/**
 * Binary property list (`bplist00`) serialization.
 *
 * Building runs in two phases. First the value tree is interned into a flat
 * object table, where scalars are deduplicated by value (a dictionary key
 * reused across many dicts is stored once, and `<data>` payloads above
 * {@link DATA_CONTENT_KEY_MAX_BYTES} deduplicate by view identity instead)
 * and each container is assigned an index and recorded with the indices of
 * its members. Then the table is encoded — once the object count fixes the
 * reference width and the serialized size fixes the offset width — followed
 * by the offset table and the fixed 32-byte trailer. The root is always
 * object 0.
 *
 * The value model matches {@link "./build".buildPlist} exactly: `undefined`
 * dictionary values are omitted, and `null`, non-finite numbers, out-of-range
 * bigints, class instances, and invalid dates raise {@link PlistBuildError}
 * with the offending value's path. Circular references are detected and
 * rejected rather than recursing forever. Dates carry the full `Date` range
 * here, since the binary layout stores a raw timestamp with no calendar-text
 * limit.
 *
 * @module
 */

import { PlistBuildError } from "./errors";
import {
  MAX_SAFE_INTEGER_BIGINT,
  MIN_SAFE_INTEGER_BIGINT,
  PLIST_INTEGER_MAX,
  PLIST_INTEGER_MIN,
} from "./internal/integer-range";
import type { PlistValue } from "./types";

/** `bplist00` — the 8-byte magic every binary property list starts with. */
const MAGIC = [0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30] as const;

/** Bytes in the fixed trailer at the end of every binary property list. */
const TRAILER_SIZE = 32;

/**
 * Seconds between the Unix epoch (1970-01-01) and the property list date epoch
 * (2001-01-01T00:00:00Z). Subtracting this shifts a `Date` onto the timestamp
 * a binary `date` object stores.
 */
const PLIST_DATE_EPOCH_OFFSET_SECONDS = 978_307_200;

/**
 * Largest `<data>` payload deduplicated by content rather than by identity.
 *
 * Content dedup buckets payloads by length and compares bytes with an early
 * exit, so distinct payloads part ways after a handful of bytes and only a
 * true duplicate pays a full-length compare. The cap keeps that worst case
 * proportional to the small repeated tokens content dedup exists for —
 * session keys, hashes, certificates. Above it, payloads deduplicate by view
 * identity only — before the cap existed, content-keying a 500 KB payload
 * measured at ~40% of the whole build.
 */
const DATA_CONTENT_KEY_MAX_BYTES = 4096;

/**
 * The 256 one-byte encodings, shared by every builder instance. Markers with
 * inline counts, boolean singletons, and one-byte headers are all single
 * bytes; reusing frozen pieces removes an allocation per object from the
 * build hot path (they are only ever read back into the output buffer).
 */
const BYTE_PIECES: readonly Uint8Array[] = Array.from({ length: 256 }, (_, byte) => Uint8Array.of(byte));

/**
 * Scratch view for IEEE 754 encoding. `<real>` and `<date>` payloads write
 * the float here and copy eight bytes out, which avoids allocating a
 * `DataView` per encoded object (visible in build profiles).
 */
const FLOAT64_SCRATCH = new DataView(new ArrayBuffer(8));

/**
 * A resolved entry in the object table. Scalars are encoded eagerly during
 * interning; containers hold their members' indices and are encoded in the
 * second phase, once the reference width is known.
 *
 * Encoded bytes are kept as a list of pieces written back to back, so a
 * `<data>` payload stays a borrowed view of the caller's bytes until the
 * single copy into the output buffer — there is no intermediate
 * header-plus-payload allocation.
 */
type ObjectNode =
  | { kind: "scalar"; pieces: Uint8Array[] }
  | { kind: "array"; items: number[] }
  | { kind: "dict"; keys: number[]; values: number[] };

/**
 * Serializes a value as a binary property list (`bplist00`).
 *
 * See {@link PlistValue} for the value mapping and the module overview for the
 * value-model rules shared with the XML builder. To emit XML instead, use
 * {@link "./build".buildPlist}.
 *
 * @param value The root value to serialize.
 * @returns The encoded document as a fresh `Uint8Array`.
 * @throws PlistBuildError when a value has no property list representation, or
 *   when the input contains a circular reference. The error names the path of
 *   the offending value, e.g. `$.profiles[2].name`.
 */
export function buildBinaryPlist(value: PlistValue): Uint8Array {
  return new BinaryBuilder().build(value);
}

/**
 * Returns the smallest number of bytes (1, 2, 4, or 8) that can hold an
 * unsigned value, used to size object references and offset-table entries.
 */
function byteWidth(value: number): number {
  if (value <= 0xff) return 1;
  if (value <= 0xffff) return 2;
  if (value <= 0xffff_ffff) return 4;
  return 8;
}

/**
 * Writes `value` as `size` big-endian bytes into `target` starting at `pos`.
 *
 * Sizes above four split into 32-bit halves so the byte loop can use integer
 * shifts; the float division a single loop would need showed up in build
 * profiles (this runs for every offset-table entry and object reference).
 */
function writeUintBE(target: Uint8Array, pos: number, value: number, size: number): void {
  if (size > 4) {
    writeUintBE(target, pos, Math.floor(value / 0x1_0000_0000), size - 4);
    pos += size - 4;
    size = 4;
    value = value % 0x1_0000_0000;
  }
  for (let i = size - 1; i >= 0; i--) {
    target[pos + i] = value & 0xff;
    value >>>= 8;
  }
}

/**
 * Single-use writer that interns a value tree into an object table and encodes
 * it. One instance builds exactly one document.
 */
class BinaryBuilder {
  /** Object table in index order; the root is always index 0. */
  private readonly nodes: ObjectNode[] = [];

  /**
   * Interned scalar indices, one map per scalar kind. Separate maps keyed by
   * primitive values replace a single string-keyed map because building a
   * canonical key string per scalar (`i:42`, `d:1751624430000`) allocated on
   * every occurrence — including cache hits — and dominated dictionary-heavy
   * builds.
   *
   * Integers within the safe-integer window key by `number`; only magnitudes
   * beyond it key by `bigint` (each spelling of such a value converts
   * exactly, so `42` and `42n` still intern to one object). The split keeps
   * bigint allocation off the common lookup path.
   */
  private readonly stringIndex = new Map<string, number>();
  private readonly integerNumberIndex = new Map<number, number>();
  private readonly integerBigIntIndex = new Map<bigint, number>();
  private readonly realIndex = new Map<number, number>();
  private readonly dateIndex = new Map<number, number>();

  /**
   * Interned `<data>` indices bucketed by payload length, for payloads small
   * enough to content-key. Distinct same-length payloads separate at the
   * first differing byte, so a bucket scan is effectively free until a true
   * duplicate (which pays one full compare instead of the copy it saves).
   */
  private readonly dataContentIndex = new Map<number, { bytes: Uint8Array; index: number }[]>();

  /** Interned `<data>` indices by view identity, for payloads above the content-key cap. */
  private readonly dataViewIndex = new Map<ArrayBufferView, number>();

  /** Object index of each boolean singleton, or -1 until first interned. */
  private trueIndex = -1;
  private falseIndex = -1;

  /** Containers currently on the interning path, for cycle detection. */
  private readonly onPath = new WeakSet<object>();

  /**
   * Interns `value` and its descendants, then encodes the object table,
   * offset table, and trailer into a single buffer.
   */
  build(value: PlistValue): Uint8Array {
    this.intern(value, "$");

    const objectCount = this.nodes.length;
    const objectRefSize = byteWidth(objectCount - 1);
    const encoded = this.nodes.map((node) => this.encodeNode(node, objectRefSize));

    // Object offsets are absolute, starting after the 8-byte magic.
    const offsets: number[] = [];
    let cursor = MAGIC.length;
    for (const pieces of encoded) {
      offsets.push(cursor);
      for (const piece of pieces) {
        cursor += piece.length;
      }
    }
    const offsetTableOffset = cursor;
    const offsetIntSize = byteWidth(offsetTableOffset);
    const totalSize = offsetTableOffset + objectCount * offsetIntSize + TRAILER_SIZE;

    const out = new Uint8Array(totalSize);
    out.set(MAGIC, 0);
    let writeCursor = MAGIC.length;
    for (const pieces of encoded) {
      for (const piece of pieces) {
        // Most pieces are one-byte markers; a direct store skips the
        // typed-array set() machinery for them.
        if (piece.length === 1) {
          out[writeCursor++] = piece[0]!;
        } else {
          out.set(piece, writeCursor);
          writeCursor += piece.length;
        }
      }
    }
    for (let i = 0; i < objectCount; i++) {
      writeUintBE(out, offsetTableOffset + i * offsetIntSize, offsets[i]!, offsetIntSize);
    }

    // The trailer holds five unused bytes and the sort version, then the two
    // widths and three 64-bit counts. The root object is index 0, so
    // topObject stays 0.
    const trailer = totalSize - TRAILER_SIZE;
    out[trailer + 6] = offsetIntSize;
    out[trailer + 7] = objectRefSize;
    writeUintBE(out, trailer + 8, objectCount, 8);
    writeUintBE(out, trailer + 24, offsetTableOffset, 8);

    return out;
  }

  // ------------------------------------------------------------------------
  // Interning
  // ------------------------------------------------------------------------

  /**
   * Interns one value, returning its object index. Scalars are encoded and
   * deduplicated here; containers are delegated so their members are interned
   * first.
   *
   * @param value Value to intern.
   * @param path Path from the root for error reporting.
   */
  private intern(value: PlistValue, path: string): number {
    if (value === null) {
      throw new PlistBuildError("null has no property list representation", path);
    }
    switch (typeof value) {
      case "string":
        return this.internString(value);
      case "number":
        return this.internNumber(value, path);
      case "bigint":
        return this.internInteger(this.checkedBigInt(value, path));
      case "boolean":
        return this.internBoolean(value);
      case "object":
        return this.internObject(value, path);
      default:
        throw new PlistBuildError(`${typeof value} values have no property list representation`, path);
    }
  }

  /**
   * Interns a `number`: an integral value becomes an `<integer>` object (with
   * `-0` normalized to `0`), a finite fraction becomes a `<real>`, and `NaN`
   * or an infinity is rejected — mirroring the XML builder.
   *
   * Integral numbers pass through the same 64-bit range check as bigints
   * because `encodeInteger` cannot represent values outside `[-(2^63), 2^64)`:
   * a too-negative value would wrap in the signed 8-byte branch, and a value
   * above `2^128` would silently truncate in the 16-byte branch. Both are
   * data corruption, so an out-of-range integer must fail loudly instead.
   */
  private internNumber(value: number, path: string): number {
    if (Number.isInteger(value)) {
      // Safe-range integers are inside the 64-bit window by construction, so
      // they skip both the range check and the bigint conversion; -0
      // normalizes to 0 (SameValueZero map keys treat them as one anyway).
      if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
        return this.internSafeInteger(value === 0 ? 0 : value);
      }
      return this.internInteger(this.checkedBigInt(BigInt(value), path));
    }
    if (!Number.isFinite(value)) {
      throw new PlistBuildError(`${value} cannot be written to a property list`, path);
    }
    const existing = this.realIndex.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const index = this.appendScalar([this.encodeReal(value)]);
    this.realIndex.set(value, index);
    return index;
  }

  /**
   * Interns object-typed values. Dates and binary data deduplicate by value,
   * arrays and dictionaries intern structurally, and anything else
   * object-shaped — class instances, `Map`, `Set` — is rejected.
   */
  private internObject(value: object & PlistValue, path: string): number {
    if (value instanceof Date) {
      const time = value.getTime();
      if (Number.isNaN(time)) {
        throw new PlistBuildError("invalid Date cannot be written to a property list", path);
      }
      const existing = this.dateIndex.get(time);
      if (existing !== undefined) {
        return existing;
      }
      const index = this.appendScalar([this.encodeDate(time)]);
      this.dateIndex.set(time, index);
      return index;
    }

    if (ArrayBuffer.isView(value)) {
      return this.internData(value);
    }

    if (Array.isArray(value)) {
      return this.internArray(value, path);
    }

    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new PlistBuildError("class instances have no property list representation", path);
    }
    return this.internDict(value, path);
  }

  /**
   * Interns a `<data>` payload. Only the view's window is read, so subarray
   * slices of a larger buffer serialize correctly. Payloads up to
   * {@link DATA_CONTENT_KEY_MAX_BYTES} deduplicate by content; larger ones by
   * view identity, so passing the same view twice still stores it once. The
   * encoded node borrows the view rather than copying — the bytes are copied
   * exactly once, into the output buffer.
   */
  private internData(value: ArrayBufferView): number {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

    if (bytes.byteLength <= DATA_CONTENT_KEY_MAX_BYTES) {
      let bucket = this.dataContentIndex.get(bytes.byteLength);
      if (bucket === undefined) {
        bucket = [];
        this.dataContentIndex.set(bytes.byteLength, bucket);
      }
      for (const candidate of bucket) {
        if (bytesEqual(candidate.bytes, bytes)) {
          return candidate.index;
        }
      }
      const index = this.appendScalar([this.sizeHeader(0x40, bytes.length), bytes]);
      bucket.push({ bytes, index });
      return index;
    }

    const existing = this.dataViewIndex.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const index = this.appendScalar([this.sizeHeader(0x40, bytes.length), bytes]);
    this.dataViewIndex.set(value, index);
    return index;
  }

  /** Interns a string, deduplicating by value. */
  private internString(value: string): number {
    const existing = this.stringIndex.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const index = this.appendScalar(this.encodeString(value));
    this.stringIndex.set(value, index);
    return index;
  }

  /** Interns a safe-range integer through the number-keyed map. */
  private internSafeInteger(value: number): number {
    const existing = this.integerNumberIndex.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const index = this.appendScalar([this.encodeInteger(BigInt(value))]);
    this.integerNumberIndex.set(value, index);
    return index;
  }

  /**
   * Interns a 64-bit-checked bigint integer. Safe-range magnitudes delegate
   * to the number-keyed map so a value reached via both spellings (`42` and
   * `42n`) still interns to a single object.
   */
  private internInteger(value: bigint): number {
    if (value >= MIN_SAFE_INTEGER_BIGINT && value <= MAX_SAFE_INTEGER_BIGINT) {
      return this.internSafeInteger(Number(value));
    }
    const existing = this.integerBigIntIndex.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const index = this.appendScalar([this.encodeInteger(value)]);
    this.integerBigIntIndex.set(value, index);
    return index;
  }

  /** Interns a boolean singleton (`false` is 0x08, `true` is 0x09). */
  private internBoolean(value: boolean): number {
    const existing = value ? this.trueIndex : this.falseIndex;
    if (existing !== -1) {
      return existing;
    }
    const index = this.appendScalar([BYTE_PIECES[value ? 0x09 : 0x08]!]);
    if (value) {
      this.trueIndex = index;
    } else {
      this.falseIndex = index;
    }
    return index;
  }

  /**
   * Interns an array by reserving its index, interning each element, then
   * recording the element indices. The reserved-index-first order keeps the
   * root at 0.
   */
  private internArray(value: PlistArrayInput, path: string): number {
    this.enterContainer(value, path);
    const index = this.reserve();
    const items: number[] = [];
    for (let i = 0; i < value.length; i++) {
      items.push(this.intern(value[i]!, `${path}[${i}]`));
    }
    this.nodes[index] = { kind: "array", items };
    this.onPath.delete(value);
    return index;
  }

  /**
   * Interns a dictionary. Keys and values become separate objects, and a key
   * whose value is `undefined` is omitted (matching `JSON.stringify` and the
   * XML builder). Keys intern as strings, so repeated keys deduplicate.
   */
  private internDict(value: PlistDictInput, path: string): number {
    this.enterContainer(value, path);
    const index = this.reserve();
    const keys: number[] = [];
    const values: number[] = [];
    for (const key of Object.keys(value)) {
      const entry = value[key];
      if (entry === undefined) {
        continue;
      }
      keys.push(this.intern(key, path));
      values.push(this.intern(entry, `${path}.${key}`));
    }
    this.nodes[index] = { kind: "dict", keys, values };
    this.onPath.delete(value);
    return index;
  }

  /**
   * Adds a container to the active path, rejecting a value already on it — a
   * circular reference that would otherwise recurse forever.
   */
  private enterContainer(value: object, path: string): void {
    if (this.onPath.has(value)) {
      throw new PlistBuildError("circular reference has no property list representation", path);
    }
    this.onPath.add(value);
  }

  /** Reserves the next object index with a placeholder to be filled in later. */
  private reserve(): number {
    const index = this.nodes.length;
    this.nodes.push({ kind: "array", items: [] });
    return index;
  }

  /** Appends an encoded scalar to the object table, returning its index. */
  private appendScalar(pieces: Uint8Array[]): number {
    const index = this.nodes.length;
    this.nodes.push({ kind: "scalar", pieces });
    return index;
  }

  /**
   * Returns `value` if it fits the `<integer>` element's 64-bit window,
   * throwing {@link PlistBuildError} otherwise. Guards both the `bigint` and
   * the integral-`number` paths so no out-of-range value reaches the encoder.
   */
  private checkedBigInt(value: bigint, path: string): bigint {
    if (value < PLIST_INTEGER_MIN || value > PLIST_INTEGER_MAX) {
      throw new PlistBuildError(`integer ${value} overflows the 64-bit <integer> range`, path);
    }
    return value;
  }

  // ------------------------------------------------------------------------
  // Object encoding
  // ------------------------------------------------------------------------

  /** Encodes a resolved node; containers now know the reference width. */
  private encodeNode(node: ObjectNode, refSize: number): Uint8Array[] {
    switch (node.kind) {
      case "scalar":
        return node.pieces;
      case "array":
        return [this.sizeHeader(0xa0, node.items.length), this.encodeRefs(node.items, refSize)];
      case "dict":
        return [
          this.sizeHeader(0xd0, node.keys.length),
          this.encodeRefs(node.keys, refSize),
          this.encodeRefs(node.values, refSize),
        ];
    }
  }

  /** Encodes a list of object references, each `refSize` big-endian bytes. */
  private encodeRefs(indices: number[], refSize: number): Uint8Array {
    const out = new Uint8Array(indices.length * refSize);
    for (let i = 0; i < indices.length; i++) {
      writeUintBE(out, i * refSize, indices[i]!, refSize);
    }
    return out;
  }

  /**
   * Encodes a marker byte and element count. Counts below 15 pack into the
   * marker's low nibble; larger counts set the nibble to 0xF and follow with
   * an inline integer object, mirroring what the parser reads.
   */
  private sizeHeader(marker: number, count: number): Uint8Array {
    if (count < 0x0f) {
      return BYTE_PIECES[marker | count]!;
    }
    const countBytes = this.encodeInteger(BigInt(count));
    const out = new Uint8Array(1 + countBytes.length);
    out[0] = marker | 0x0f;
    out.set(countBytes, 1);
    return out;
  }

  /**
   * Encodes an `<integer>` object. Non-negative values use the smallest of 1,
   * 2, 4, 8, or 16 bytes; negatives always use a signed 8-byte encoding — the
   * same widths the parser decodes.
   */
  private encodeInteger(value: bigint): Uint8Array {
    if (value < 0n) {
      return this.encodeIntBytes(0x13, value + (1n << 64n), 8);
    }
    if (value <= 0xffn) return this.encodeIntBytes(0x10, value, 1);
    if (value <= 0xffffn) return this.encodeIntBytes(0x11, value, 2);
    if (value <= 0xffff_ffffn) return this.encodeIntBytes(0x12, value, 4);
    if (value <= 0x7fff_ffff_ffff_ffffn) return this.encodeIntBytes(0x13, value, 8);
    return this.encodeIntBytes(0x14, value, 16);
  }

  /** Writes an integer marker followed by `size` big-endian bytes of `value`. */
  private encodeIntBytes(marker: number, value: bigint, size: number): Uint8Array {
    const out = new Uint8Array(1 + size);
    out[0] = marker;
    let remaining = value;
    for (let i = size; i >= 1; i--) {
      out[i] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    return out;
  }

  /** Encodes a `<real>` object as a big-endian 8-byte double. */
  private encodeReal(value: number): Uint8Array {
    return encodeMarkedFloat64(0x23, value);
  }

  /** Encodes a `<date>` object as seconds since the property list date epoch. */
  private encodeDate(time: number): Uint8Array {
    return encodeMarkedFloat64(0x33, time / 1000 - PLIST_DATE_EPOCH_OFFSET_SECONDS);
  }

  /**
   * Encodes a `<string>` object as pieces. An all-ASCII string uses the
   * one-byte-per-character encoding; anything else uses UTF-16 with two
   * big-endian bytes per code unit. The count is the number of code units
   * either way.
   */
  private encodeString(value: string): Uint8Array[] {
    let ascii = true;
    for (let i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) > 0x7f) {
        ascii = false;
        break;
      }
    }

    if (ascii) {
      const body = new Uint8Array(value.length);
      for (let i = 0; i < value.length; i++) {
        body[i] = value.charCodeAt(i);
      }
      return [this.sizeHeader(0x50, value.length), body];
    }

    const body = new Uint8Array(value.length * 2);
    const view = new DataView(body.buffer);
    for (let i = 0; i < value.length; i++) {
      view.setUint16(i * 2, value.charCodeAt(i));
    }
    return [this.sizeHeader(0x60, value.length), body];
  }
}

/** An array of property list values as seen by the interner. */
type PlistArrayInput = readonly PlistValue[];

/** A plain object of property list values as seen by the interner. */
type PlistDictInput = Record<string, PlistValue | undefined>;

/**
 * Encodes a marker byte followed by a big-endian IEEE 754 double, through
 * {@link FLOAT64_SCRATCH} so no per-object `DataView` is allocated.
 */
function encodeMarkedFloat64(marker: number, value: number): Uint8Array {
  const out = new Uint8Array(9);
  out[0] = marker;
  FLOAT64_SCRATCH.setFloat64(0, value);
  for (let i = 0; i < 8; i++) {
    out[i + 1] = FLOAT64_SCRATCH.getUint8(i);
  }
  return out;
}

/**
 * Byte-wise equality with an early exit, used by content dedup. Distinct
 * payloads of equal length usually differ within the first few bytes, so the
 * common miss costs almost nothing; only a true duplicate scans to the end.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
