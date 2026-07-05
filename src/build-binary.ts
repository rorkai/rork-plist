/**
 * Binary property list (`bplist00`) serialization.
 *
 * Building runs in two phases. First the value tree is interned into a flat
 * object table: scalars are deduplicated by value (so a dictionary key reused
 * across many dicts is stored once), and each container is assigned an index
 * and recorded with the indices of its members. Then the table is encoded —
 * once the object count fixes the reference width and the serialized size
 * fixes the offset width — followed by the offset table and the fixed 32-byte
 * trailer. The root is always object 0.
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

import { encodeBase64 } from "./base64";
import { PlistBuildError } from "./errors";
import { PLIST_INTEGER_MAX, PLIST_INTEGER_MIN } from "./internal/integer-range";
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
 * A resolved entry in the object table. Scalars are encoded eagerly during
 * interning; containers hold their members' indices and are encoded in the
 * second phase, once the reference width is known.
 */
type ObjectNode =
  | { kind: "scalar"; bytes: Uint8Array }
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

/** Writes `value` as `size` big-endian bytes into `target` starting at `pos`. */
function writeUintBE(target: Uint8Array, pos: number, value: number, size: number): void {
  for (let i = size - 1; i >= 0; i--) {
    target[pos + i] = value & 0xff;
    value = Math.floor(value / 256);
  }
}

/**
 * Single-use writer that interns a value tree into an object table and encodes
 * it. One instance builds exactly one document.
 */
class BinaryBuilder {
  /** Object table in index order; the root is always index 0. */
  private readonly nodes: ObjectNode[] = [];

  /** Maps a scalar's canonical key to its object index, for deduplication. */
  private readonly scalarIndex = new Map<string, number>();

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
    for (const bytes of encoded) {
      offsets.push(cursor);
      cursor += bytes.length;
    }
    const offsetTableOffset = cursor;
    const offsetIntSize = byteWidth(offsetTableOffset);
    const totalSize = offsetTableOffset + objectCount * offsetIntSize + TRAILER_SIZE;

    const out = new Uint8Array(totalSize);
    out.set(MAGIC, 0);
    for (let i = 0; i < encoded.length; i++) {
      out.set(encoded[i]!, offsets[i]!);
    }
    for (let i = 0; i < objectCount; i++) {
      writeUintBE(out, offsetTableOffset + i * offsetIntSize, offsets[i]!, offsetIntSize);
    }

    // Trailer: 5 unused + sort version, then the two widths and three 64-bit
    // counts. The root object is index 0, so topObject stays 0.
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
        return this.internScalar(`s:${value}`, () => this.encodeString(value));
      case "number":
        return this.internNumber(value, path);
      case "bigint":
        return this.internScalar(`i:${value}`, () => this.encodeInteger(this.checkedBigInt(value, path)));
      case "boolean":
        return this.internScalar(value ? "true" : "false", () => new Uint8Array([value ? 0x09 : 0x08]));
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
   */
  private internNumber(value: number, path: string): number {
    if (Number.isInteger(value)) {
      const normalized = value === 0 ? 0 : value;
      return this.internScalar(`i:${normalized}`, () => this.encodeInteger(BigInt(normalized)));
    }
    if (!Number.isFinite(value)) {
      throw new PlistBuildError(`${value} cannot be written to a property list`, path);
    }
    return this.internScalar(`r:${value}`, () => this.encodeReal(value));
  }

  /**
   * Interns object-typed values: dates and binary data (deduplicated by value)
   * and arrays and dictionaries (interned structurally). Anything else
   * object-shaped — class instances, `Map`, `Set` — is rejected.
   */
  private internObject(value: object & PlistValue, path: string): number {
    if (value instanceof Date) {
      const time = value.getTime();
      if (Number.isNaN(time)) {
        throw new PlistBuildError("invalid Date cannot be written to a property list", path);
      }
      return this.internScalar(`d:${time}`, () => this.encodeDate(time));
    }

    if (ArrayBuffer.isView(value)) {
      // Only the view's window is read, so subarray slices of a larger buffer
      // serialize correctly; deduplicate identical payloads by their bytes.
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return this.internScalar(`data:${encodeBase64(bytes)}`, () => this.encodeData(bytes));
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
   * Interns an array: reserves its index, interns each element, then records
   * the element indices. The reserved-index-first order keeps the root at 0.
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
   * Interns a dictionary: keys and values become separate objects, and a key
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

  /**
   * Returns the index of a scalar with the given canonical key, encoding and
   * appending it on first sight and reusing it thereafter.
   */
  private internScalar(key: string, encode: () => Uint8Array): number {
    const existing = this.scalarIndex.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const index = this.nodes.length;
    this.nodes.push({ kind: "scalar", bytes: encode() });
    this.scalarIndex.set(key, index);
    return index;
  }

  private checkedBigInt(value: bigint, path: string): bigint {
    if (value < PLIST_INTEGER_MIN || value > PLIST_INTEGER_MAX) {
      throw new PlistBuildError(`bigint ${value} overflows the 64-bit <integer> range`, path);
    }
    return value;
  }

  // ------------------------------------------------------------------------
  // Object encoding
  // ------------------------------------------------------------------------

  /** Encodes a resolved node; containers now know the reference width. */
  private encodeNode(node: ObjectNode, refSize: number): Uint8Array {
    if (node.kind === "scalar") {
      return node.bytes;
    }
    if (node.kind === "array") {
      return concat(this.sizeHeader(0xa0, node.items.length), this.encodeRefs(node.items, refSize));
    }
    return concat(
      this.sizeHeader(0xd0, node.keys.length),
      this.encodeRefs(node.keys, refSize),
      this.encodeRefs(node.values, refSize),
    );
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
      return new Uint8Array([marker | count]);
    }
    return concat(new Uint8Array([marker | 0x0f]), this.encodeInteger(BigInt(count)));
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
    const out = new Uint8Array(9);
    out[0] = 0x23;
    new DataView(out.buffer).setFloat64(1, value);
    return out;
  }

  /** Encodes a `<date>` object as seconds since the property list date epoch. */
  private encodeDate(time: number): Uint8Array {
    const out = new Uint8Array(9);
    out[0] = 0x33;
    new DataView(out.buffer).setFloat64(1, time / 1000 - PLIST_DATE_EPOCH_OFFSET_SECONDS);
    return out;
  }

  /** Encodes a `<data>` object: a size header followed by the raw bytes. */
  private encodeData(bytes: Uint8Array): Uint8Array {
    return concat(this.sizeHeader(0x40, bytes.length), bytes);
  }

  /**
   * Encodes a `<string>` object. An all-ASCII string uses the one-byte-per-
   * character encoding; anything else uses UTF-16 with two big-endian bytes
   * per code unit. The count is the number of code units either way.
   */
  private encodeString(value: string): Uint8Array {
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
      return concat(this.sizeHeader(0x50, value.length), body);
    }

    const body = new Uint8Array(value.length * 2);
    const view = new DataView(body.buffer);
    for (let i = 0; i < value.length; i++) {
      view.setUint16(i * 2, value.charCodeAt(i));
    }
    return concat(this.sizeHeader(0x60, value.length), body);
  }
}

/** An array of property list values as seen by the interner. */
type PlistArrayInput = readonly PlistValue[];

/** A plain object of property list values as seen by the interner. */
type PlistDictInput = Record<string, PlistValue | undefined>;

/** Concatenates byte chunks into one buffer. */
function concat(...chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
