/**
 * Binary property list (`bplist00`) parsing.
 *
 * The binary format is an object table with an offset index and a fixed
 * 32-byte trailer, all big-endian (which is `DataView`'s default byte order).
 * A document is: the 8-byte magic `bplist00`, the encoded objects, an offset
 * table mapping each object index to its byte offset, and the trailer naming
 * the integer widths, object count, root object index, and offset-table
 * location. Containers reference their members by index into the offset
 * table, so the parser resolves objects on demand starting from the root.
 *
 * Every read is bounds-checked against the buffer, and object-reference
 * cycles are bounded by {@link ParsePlistOptions.maxDepth}, so malformed or
 * adversarial input raises {@link PlistParseError} rather than reading out of
 * bounds or recursing forever. The layout is verified empirically: the test
 * suite cross-checks this parser against binary documents produced by the
 * platform plist tooling.
 *
 * @module
 */

import { PlistParseError } from "./errors";
import {
  MAX_SAFE_INTEGER_BIGINT,
  MIN_SAFE_INTEGER_BIGINT,
  PLIST_INTEGER_MAX,
  PLIST_INTEGER_MIN,
} from "./internal/integer-range";
import { DEFAULT_MAX_DEPTH, type ParsePlistOptions } from "./parse-options";
import type { PlistArray, PlistDictionary, PlistValue } from "./types";

/** `bplist00` — the 8-byte magic every binary property list starts with. */
const MAGIC = [0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30] as const;

/** Bytes in the fixed trailer at the end of every binary property list. */
const TRAILER_SIZE = 32;

/**
 * Seconds between the Unix epoch (1970-01-01) and the property list date epoch
 * (2001-01-01T00:00:00Z). Binary `date` objects store seconds since the
 * latter, so adding this shifts them onto Unix time.
 */
const PLIST_DATE_EPOCH_OFFSET_SECONDS = 978_307_200;

/**
 * Reports whether a buffer begins with the `bplist00` magic.
 *
 * Used by {@link "./parse".parsePlist} to route a `Uint8Array` to the binary
 * parser instead of decoding it as XML text.
 *
 * @param bytes Candidate buffer; only its first eight bytes are inspected.
 */
export function hasBinaryPlistMagic(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) {
    return false;
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Parses a binary property list (`bplist00`) into JavaScript values.
 *
 * See {@link PlistValue} for the value mapping. `<data>` objects become
 * `Uint8Array`, dates become `Date`, and integers follow the same 64-bit
 * window and `number`/`bigint` split as the XML parser. UID objects (used by
 * keyed archives, not by plain property lists) have no property list
 * representation and are rejected.
 *
 * @param bytes The binary document. Only the view's window is read.
 * @param options See {@link ParsePlistOptions}.
 * @returns The document's root value.
 * @throws PlistParseError when the buffer is not a well-formed binary plist;
 *   the error's position carries the byte offset of the failure.
 */
export function parseBinaryPlist(bytes: Uint8Array, options: ParsePlistOptions = {}): PlistValue {
  return new BinaryParser(bytes, options.maxDepth ?? DEFAULT_MAX_DEPTH).parse();
}

/**
 * Single-use reader over one binary property list buffer.
 *
 * A `DataView` scoped to the input's window backs every read so views into a
 * larger `ArrayBuffer` (a slice of a bundle read, say) parse correctly. The
 * trailer fields are read once in {@link parse}; the rest of the methods
 * resolve the object graph on demand from the root.
 */
class BinaryParser {
  /** Big-endian view over the input's window; the source of every read. */
  private readonly view: DataView;

  /** Length of the input window in bytes; the upper bound for reads. */
  private readonly byteLength: number;

  /** Absolute byte offset of the offset table, from the trailer. */
  private offsetTableOffset = 0;

  /** Width in bytes of each offset-table entry, from the trailer. */
  private offsetIntSize = 0;

  /** Width in bytes of each object reference, from the trailer. */
  private objectRefSize = 0;

  /** Total number of objects in the table, from the trailer. */
  private objectCount = 0;

  /**
   * Caches each object's resolved value by index. The object table is a graph:
   * one object can be referenced from many places, so resolving each index at
   * most once is both a correctness guard and the main throughput win.
   *
   * Correctness: without it, a table like `A[n] = [A[n-1], A[n-1]]` re-resolves
   * `A[n-1]` twice at every level, expanding a tiny buffer to `2^n` allocations
   * while staying under {@link maxDepth}.
   *
   * Throughput: the format interns strings, so one `<dict>` key shared across
   * hundreds of dictionaries is a single object referenced hundreds of times;
   * caching decodes it once instead of once per reference. Every object is
   * cached (not just containers) because that reuse is where the win is, and a
   * per-object map hit is far cheaper than re-decoding a string.
   *
   * A referenced object resolves to one shared instance, as the platform
   * reader does. `undefined` is never a property list value, so it is a safe
   * "not yet resolved" sentinel.
   */
  private readonly resolved = new Map<number, PlistValue>();

  /**
   * @param bytes The binary document to read.
   * @param maxDepth Maximum container nesting depth, which also bounds
   *   reference cycles.
   */
  constructor(
    private readonly bytes: Uint8Array,
    private readonly maxDepth: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.byteLength = bytes.byteLength;
  }

  /**
   * Validates the magic and trailer, then resolves the root object.
   *
   * The trailer's declared widths, object count, and offset-table location are
   * bounds-checked against the buffer before any object is read, so later
   * reads can trust them.
   */
  parse(): PlistValue {
    if (!hasBinaryPlistMagic(this.bytes)) {
      this.fail("not a binary property list (missing bplist00 magic)", 0);
    }
    if (this.byteLength < MAGIC.length + TRAILER_SIZE) {
      this.fail("binary property list is too short to contain a trailer", 0);
    }

    // The trailer's meaningful fields start 6 bytes in (5 unused + sort
    // version), then two width bytes and three 64-bit counts.
    const trailer = this.byteLength - TRAILER_SIZE;
    this.offsetIntSize = this.u8(trailer + 6);
    this.objectRefSize = this.u8(trailer + 7);
    this.objectCount = this.readBigEndianUint(trailer + 8, 8);
    const topObject = this.readBigEndianUint(trailer + 16, 8);
    this.offsetTableOffset = this.readBigEndianUint(trailer + 24, 8);

    if (this.offsetIntSize < 1 || this.offsetIntSize > 8 || this.objectRefSize < 1 || this.objectRefSize > 8) {
      this.fail("binary property list trailer declares an invalid integer width", trailer);
    }
    // The offset table sits between the objects and the trailer; reject a
    // declared size that cannot fit, which also bounds the work below.
    if (
      this.offsetTableOffset < MAGIC.length ||
      this.offsetTableOffset + this.objectCount * this.offsetIntSize > trailer
    ) {
      this.fail("binary property list offset table is out of bounds", trailer + 24);
    }
    if (topObject >= this.objectCount) {
      this.fail("binary property list root object index is out of range", trailer + 16);
    }

    return this.parseObject(topObject, 0);
  }

  // ------------------------------------------------------------------------
  // Object graph
  // ------------------------------------------------------------------------

  /**
   * Resolves the object at `index` in the offset table.
   *
   * The object's marker byte encodes its type in the high nibble and, for most
   * types, a size or count in the low nibble.
   *
   * @param index Object index (into the offset table).
   * @param depth Current container nesting depth, bounded by `maxDepth` — this
   *   is what stops reference cycles from recursing forever.
   */
  private parseObject(index: number, depth: number): PlistValue {
    // An object already resolved once is returned as its shared instance,
    // which both bounds work on documents that reuse objects and keeps the
    // graph's reference sharing.
    const cached = this.resolved.get(index);
    if (cached !== undefined) {
      return cached;
    }
    if (depth > this.maxDepth) {
      this.fail(`maximum nesting depth of ${this.maxDepth} exceeded`, this.objectOffset(index));
    }

    const value = this.resolveObject(index, depth);
    this.resolved.set(index, value);
    return value;
  }

  /**
   * Decodes the object at `index` from its marker byte. {@link parseObject}
   * owns the resolved-object cache; this method only reads and builds.
   *
   * The marker's high nibble is the type and, for most types, the low nibble
   * carries a size or count.
   */
  private resolveObject(index: number, depth: number): PlistValue {
    const offset = this.objectOffset(index);
    const marker = this.u8(offset);
    const objectType = marker >> 4;
    const objectInfo = marker & 0x0f;

    switch (objectType) {
      case 0x0:
        return this.parseSingleton(marker, offset);
      case 0x1:
        return this.parseInteger(offset, 1 << objectInfo);
      case 0x2:
        return this.parseReal(offset, 1 << objectInfo);
      case 0x3:
        return this.parseDate(offset, objectInfo);
      case 0x4:
        return this.parseData(offset);
      case 0x5:
        return this.parseAsciiString(offset);
      case 0x6:
        return this.parseUnicodeString(offset);
      case 0x8:
        this.fail("UID objects have no property list representation", offset);
        break;
      // A set (0xc) shares the array layout — count followed by object
      // references — and the platform tooling widens sets to arrays in XML too.
      case 0xa:
      case 0xc:
        return this.parseArray(offset, depth + 1);
      case 0xd:
        return this.parseDict(offset, depth + 1);
      default:
        this.fail(`unknown binary object marker 0x${marker.toString(16).padStart(2, "0")}`, offset);
    }
  }

  /**
   * Resolves a marker in the `0x0n` family: the `false` (0x08) and `true`
   * (0x09) singletons. The null (0x00) and fill (0x0f) markers have no
   * property list representation and are rejected.
   */
  private parseSingleton(marker: number, offset: number): boolean {
    if (marker === 0x08) {
      return false;
    }
    if (marker === 0x09) {
      return true;
    }
    this.fail(`binary marker 0x${marker.toString(16).padStart(2, "0")} has no property list representation`, offset);
  }

  /**
   * Resolves an `integer` object of `byteCount` bytes.
   *
   * 1/2/4-byte integers are unsigned and fit a JS number exactly. 8- and
   * 16-byte integers are signed two's complement, decoded via bigint and
   * narrowed back to `number` when they fall inside the safe integer range,
   * enforcing the same 64-bit window as the XML parser.
   */
  private parseInteger(offset: number, byteCount: number): number | bigint {
    if (byteCount <= 4) {
      return this.readBigEndianUint(offset + 1, byteCount);
    }
    if (byteCount !== 8 && byteCount !== 16) {
      this.fail(`unsupported <integer> width of ${byteCount} bytes`, offset);
    }

    let magnitude = 0n;
    for (let i = 0; i < byteCount; i++) {
      magnitude = (magnitude << 8n) | BigInt(this.u8(offset + 1 + i));
    }
    const bits = BigInt(byteCount * 8);
    const signBit = 1n << (bits - 1n);
    const value = magnitude >= signBit ? magnitude - (1n << bits) : magnitude;

    if (value < PLIST_INTEGER_MIN || value > PLIST_INTEGER_MAX) {
      this.fail("<integer> overflows the 64-bit property list range", offset);
    }
    if (value >= MIN_SAFE_INTEGER_BIGINT && value <= MAX_SAFE_INTEGER_BIGINT) {
      return Number(value);
    }
    return value;
  }

  /**
   * Resolves a `real` object: a big-endian IEEE 754 float (4 bytes) or double
   * (8 bytes).
   */
  private parseReal(offset: number, byteCount: number): number {
    this.requireBytes(offset + 1, byteCount);
    if (byteCount === 4) {
      return this.view.getFloat32(offset + 1);
    }
    if (byteCount === 8) {
      return this.view.getFloat64(offset + 1);
    }
    this.fail(`unsupported <real> width of ${byteCount} bytes`, offset);
  }

  /**
   * Resolves a `date` object: a big-endian double of seconds since the
   * property list date epoch (2001-01-01), shifted onto Unix time for the
   * `Date`. The result is rounded to the nearest millisecond — a `Date` holds
   * integer milliseconds, so this recovers the intended value from the
   * floating-point seconds representation rather than leaving a 1-ulp error.
   *
   * The date marker is always `0x33` (an 8-byte payload); the low nibble is
   * not a width field. A different low nibble, or a payload that is `NaN`, an
   * infinity, or beyond the `Date` range, is malformed and fails rather than
   * yielding an `Invalid Date`.
   *
   * @param objectInfo The marker's low nibble, which must be `0x3`.
   */
  private parseDate(offset: number, objectInfo: number): Date {
    if (objectInfo !== 0x3) {
      this.fail("binary <date> marker is not 0x33", offset);
    }
    this.requireBytes(offset + 1, 8);
    const secondsSinceEpoch = this.view.getFloat64(offset + 1);
    const date = new Date(Math.round((secondsSinceEpoch + PLIST_DATE_EPOCH_OFFSET_SECONDS) * 1000));
    if (Number.isNaN(date.getTime())) {
      this.fail("binary <date> payload is not a representable date", offset);
    }
    return date;
  }

  /**
   * Resolves a `data` object into a standalone `Uint8Array` copied out of the
   * input window.
   */
  private parseData(offset: number): Uint8Array {
    const { count, start } = this.readLength(offset);
    this.requireBytes(start, count);
    return this.bytes.slice(start, start + count);
  }

  /**
   * Resolves an ASCII `string` object: one byte per character, each a code
   * point in 0–127. A byte above `0x7f` is out of spec — the writer encodes
   * such strings as UTF-16 (the `0x6n` marker) — so it fails rather than being
   * silently reinterpreted as a Latin-1 character.
   */
  private parseAsciiString(offset: number): string {
    const { count, start } = this.readLength(offset);
    this.requireBytes(start, count);
    let out = "";
    for (let i = 0; i < count; i++) {
      const byte = this.u8(start + i);
      if (byte > 0x7f) {
        this.fail("binary ASCII <string> contains a non-ASCII byte", start + i);
      }
      out += String.fromCharCode(byte);
    }
    return out;
  }

  /**
   * Resolves a Unicode `string` object: `count` UTF-16 code units, each stored
   * as two big-endian bytes. JS strings are UTF-16, so the units pass straight
   * through.
   */
  private parseUnicodeString(offset: number): string {
    const { count, start } = this.readLength(offset);
    this.requireBytes(start, count * 2);
    let out = "";
    for (let i = 0; i < count; i++) {
      out += String.fromCharCode(this.view.getUint16(start + i * 2));
    }
    return out;
  }

  /**
   * Resolves an `array` (or set) object: a count followed by that many object
   * references, each resolved in turn.
   */
  private parseArray(offset: number, depth: number): PlistArray {
    const { count, start } = this.readLength(offset);
    this.requireBytes(start, count * this.objectRefSize);
    const array: PlistArray = [];
    for (let i = 0; i < count; i++) {
      array.push(this.parseObject(this.readRef(start + i * this.objectRefSize), depth));
    }
    return array;
  }

  /**
   * Resolves a `dict` object: a count, then all key references, then all value
   * references. Keys must resolve to strings, and a literal `__proto__` key is
   * stored as an own property so untrusted documents cannot pollute prototypes.
   */
  private parseDict(offset: number, depth: number): PlistDictionary {
    const { count, start } = this.readLength(offset);
    const valuesStart = start + count * this.objectRefSize;
    this.requireBytes(start, count * this.objectRefSize * 2);

    const dict: PlistDictionary = {};
    for (let i = 0; i < count; i++) {
      const key = this.parseObject(this.readRef(start + i * this.objectRefSize), depth);
      if (typeof key !== "string") {
        this.fail("binary <dict> key is not a string", start + i * this.objectRefSize);
      }
      const value = this.parseObject(this.readRef(valuesStart + i * this.objectRefSize), depth);
      if (key === "__proto__") {
        Object.defineProperty(dict, key, { value, writable: true, enumerable: true, configurable: true });
      } else {
        dict[key] = value;
      }
    }
    return dict;
  }

  // ------------------------------------------------------------------------
  // Primitives
  // ------------------------------------------------------------------------

  /**
   * Reads a collection's element count and the offset where its contents
   * begin. A low nibble below 0xF is the count itself; 0xF means the count is
   * an inline integer object immediately after the marker.
   */
  private readLength(offset: number): { count: number; start: number } {
    const info = this.u8(offset) & 0x0f;
    if (info !== 0x0f) {
      return { count: info, start: offset + 1 };
    }
    const sizeMarker = this.u8(offset + 1);
    if (sizeMarker >> 4 !== 0x1) {
      this.fail("binary length prefix is not an integer", offset + 1);
    }
    const intByteCount = 1 << (sizeMarker & 0x0f);
    const count = this.readBigEndianUint(offset + 2, intByteCount);
    return { count, start: offset + 2 + intByteCount };
  }

  /**
   * Reads one object reference and validates it against the object count.
   *
   * @param offset Byte offset of the reference within a container.
   * @returns The referenced object's index into the offset table.
   */
  private readRef(offset: number): number {
    const index = this.readBigEndianUint(offset, this.objectRefSize);
    if (index >= this.objectCount) {
      this.fail("binary object reference is out of range", offset);
    }
    return index;
  }

  /**
   * Returns the byte offset of object `index` from the offset table, validated
   * to point into the object region (after the magic, before the table).
   */
  private objectOffset(index: number): number {
    const offset = this.readBigEndianUint(this.offsetTableOffset + index * this.offsetIntSize, this.offsetIntSize);
    if (offset < MAGIC.length || offset >= this.offsetTableOffset) {
      this.fail("binary object offset is out of bounds", this.offsetTableOffset + index * this.offsetIntSize);
    }
    return offset;
  }

  /**
   * Reads a big-endian unsigned integer of `size` bytes as a number. Used for
   * offsets, references, and lengths, which are always well within the safe
   * integer range for any real document.
   */
  private readBigEndianUint(offset: number, size: number): number {
    this.requireBytes(offset, size);
    let value = 0;
    for (let i = 0; i < size; i++) {
      value = value * 256 + this.view.getUint8(offset + i);
    }
    return value;
  }

  /** Reads a single bounds-checked byte. */
  private u8(offset: number): number {
    this.requireBytes(offset, 1);
    return this.view.getUint8(offset);
  }

  /** Throws unless `[offset, offset + length)` lies within the buffer. */
  private requireBytes(offset: number, length: number): void {
    if (offset < 0 || length < 0 || offset + length > this.byteLength) {
      this.fail("binary property list read out of bounds", Math.max(0, Math.min(offset, this.byteLength)));
    }
  }

  /**
   * Throws a {@link PlistParseError} anchored at a byte offset. Return type is
   * `never` so call sites need no explicit control-flow after it.
   */
  private fail(message: string, offset: number): never {
    throw new PlistParseError(message, this.bytes, offset);
  }
}
