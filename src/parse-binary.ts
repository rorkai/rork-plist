/**
 * Binary property list (`bplist00`) parsing.
 *
 * The binary format is an object table with an offset index and a fixed
 * 32-byte trailer, all big-endian (which is `DataView`'s default byte order).
 * A document starts with the 8-byte magic `bplist00`, followed by the encoded
 * objects, an offset table mapping each object index to its byte offset, and
 * the trailer naming the integer widths, object count, root object index, and
 * offset-table location. Containers reference their members by index into the
 * offset table, so the parser resolves objects on demand starting from the
 * root.
 *
 * Every read is bounds-checked against the buffer, and object-reference
 * cycles are bounded by {@link ParsePlistOptions.maxDepth}, so malformed or
 * adversarial input raises {@link PlistParseError} rather than reading out of
 * bounds or recursing forever. The layout is verified empirically by
 * cross-checking this parser against binary documents produced by the
 * platform plist tooling in the test suite.
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
 * `Uint8Array` — copies by default, or views into the input buffer with
 * {@link ParsePlistOptions.data | data: "view"} — dates become `Date`, and
 * integers follow the same 64-bit window and `number`/`bigint` split as the
 * XML parser. UID objects (used by keyed archives, not by plain property
 * lists) have no property list representation and are rejected.
 *
 * @param bytes The binary document. Only the view's window is read.
 * @param options See {@link ParsePlistOptions}.
 * @returns The document's root value.
 * @throws PlistParseError when the buffer is not a well-formed binary plist;
 *   the error's position carries the byte offset of the failure.
 */
export function parseBinaryPlist(bytes: Uint8Array, options: ParsePlistOptions = {}): PlistValue {
  return new BinaryParser(bytes, options.maxDepth ?? DEFAULT_MAX_DEPTH, options.data === "view").parse();
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

  /** Element count of the last {@link readLength} call. */
  private lengthCount = 0;

  /** Content start offset of the last {@link readLength} call. */
  private lengthStart = 0;

  /**
   * Caches each object's resolved value by index, so every index resolves at
   * most once. The object table is a graph and one object can be referenced
   * from many places, which makes the cache both a correctness guard and the
   * main throughput win.
   *
   * It guards correctness because without it a table like
   * `A[n] = [A[n-1], A[n-1]]` re-resolves `A[n-1]` twice at every level,
   * expanding a tiny buffer to `2^n` allocations while staying under
   * {@link maxDepth}. It wins throughput because the format interns strings,
   * so one `<dict>` key shared across hundreds of dictionaries is a single
   * object referenced hundreds of times, and caching decodes it once instead
   * of once per reference. Every object is cached, not just containers,
   * because that reuse is where the win is.
   *
   * The cache is a dense array indexed by object index rather than a map, so
   * a lookup on the hot path costs one array read. The eager allocation is
   * safely bounded because the trailer validation caps the object count by
   * what fits in the buffer; {@link parse} sizes it once the trailer is
   * validated. `undefined` is never a property list value, which makes it a
   * safe "not resolved" sentinel.
   *
   * A referenced object resolves to one shared instance, as the platform
   * reader does.
   */
  private resolved: (PlistValue | undefined)[] = [];

  /**
   * @param bytes The binary document to read.
   * @param maxDepth Maximum container nesting depth, which also bounds
   *   reference cycles.
   * @param dataAsViews When true, `<data>` payloads alias the input buffer
   *   instead of being copied out; see {@link ParsePlistOptions.data}.
   */
  constructor(
    private readonly bytes: Uint8Array,
    private readonly maxDepth: number,
    private readonly dataAsViews: boolean,
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
    // version), then two width bytes and three 64-bit counts. The length
    // check above proves the whole 32-byte span is in bounds, so the field
    // reads skip per-read checks.
    const trailer = this.byteLength - TRAILER_SIZE;
    this.offsetIntSize = this.bytes[trailer + 6]!;
    this.objectRefSize = this.bytes[trailer + 7]!;
    this.objectCount = this.readUintUnchecked(trailer + 8, 8);
    const topObject = this.readUintUnchecked(trailer + 16, 8);
    this.offsetTableOffset = this.readUintUnchecked(trailer + 24, 8);

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

    // Sizing eagerly is safe because the offset-table bound above caps
    // objectCount by what physically fits in the buffer.
    // oxlint-disable-next-line no-new-array -- a sparse length-N cache is the point; Array.from would eagerly fill
    this.resolved = new Array<PlistValue | undefined>(this.objectCount);
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
    const cached = this.resolved[index];
    if (cached !== undefined) {
      return cached;
    }

    const offset = this.objectOffset(index);
    // objectOffset guarantees the offset lies inside the object region, so
    // the marker byte reads without a second bounds check. The marker's high
    // nibble is the type; for most types the low nibble is a size or count.
    const marker = this.bytes[offset]!;
    const objectInfo = marker & 0x0f;
    let value: PlistValue;

    switch (marker >> 4) {
      // The 0x0n family holds the false (0x08) and true (0x09) singletons;
      // the null (0x00) and fill (0x0f) markers have no property list
      // representation and are rejected.
      case 0x0:
        if (marker !== 0x08 && marker !== 0x09) {
          this.fail(
            `binary marker 0x${marker.toString(16).padStart(2, "0")} has no property list representation`,
            offset,
          );
        }
        value = marker === 0x09;
        break;
      case 0x1:
        value = this.parseInteger(offset, 1 << objectInfo);
        break;
      case 0x2:
        value = this.parseReal(offset, 1 << objectInfo);
        break;
      case 0x3:
        value = this.parseDate(offset, objectInfo);
        break;
      case 0x4:
        value = this.parseData(offset, objectInfo);
        break;
      case 0x5:
        value = this.parseAsciiString(offset, objectInfo);
        break;
      case 0x6:
        value = this.parseUnicodeString(offset, objectInfo);
        break;
      case 0x8:
        this.fail("UID objects have no property list representation", offset);
        break;
      // A set (0xc) shares the array layout — count followed by object
      // references — and the platform tooling widens sets to arrays in XML too.
      case 0xa:
      case 0xc:
        this.requireDepth(depth + 1, offset);
        value = this.parseArray(offset, objectInfo, depth + 1);
        break;
      case 0xd:
        this.requireDepth(depth + 1, offset);
        value = this.parseDict(offset, objectInfo, depth + 1);
        break;
      default:
        this.fail(`unknown binary object marker 0x${marker.toString(16).padStart(2, "0")}`, offset);
    }

    this.resolved[index] = value;
    return value;
  }

  /**
   * Fails when entering a container would exceed the depth limit. Enforced
   * at container entry — empty containers included — matching the XML
   * parser; this is also what stops reference cycles from recursing forever.
   */
  private requireDepth(depth: number, offset: number): void {
    if (depth > this.maxDepth) {
      this.fail(`maximum nesting depth of ${this.maxDepth} exceeded`, offset);
    }
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
    switch (byteCount) {
      case 1:
      case 2:
      case 4:
        return this.readBigEndianUint(offset + 1, byteCount);
      case 8:
      case 16: {
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
      default:
        this.fail(`unsupported <integer> width of ${byteCount} bytes`, offset);
    }
  }

  /**
   * Resolves a `real` object, stored as a big-endian IEEE 754 float (4 bytes)
   * or double (8 bytes).
   */
  private parseReal(offset: number, byteCount: number): number {
    this.requireBytes(offset + 1, byteCount);
    switch (byteCount) {
      case 4:
        return this.view.getFloat32(offset + 1);
      case 8:
        return this.view.getFloat64(offset + 1);
      default:
        this.fail(`unsupported <real> width of ${byteCount} bytes`, offset);
    }
  }

  /**
   * Resolves a `date` object, stored as a big-endian double of seconds since
   * the property list date epoch (2001-01-01) and shifted onto Unix time for
   * the `Date`. The result is rounded to the nearest millisecond — a `Date`
   * holds integer milliseconds, so this recovers the intended value from the
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
   * Resolves a `data` object. By default the payload is a standalone
   * `Uint8Array` copied out of the input window; it becomes a borrowed
   * `subarray` view when the caller opted into
   * {@link ParsePlistOptions.data | data: "view"}.
   */
  private parseData(offset: number, objectInfo: number): Uint8Array {
    this.readLength(offset, objectInfo);
    const count = this.lengthCount;
    const start = this.lengthStart;
    this.requireBytes(start, count);
    if (this.dataAsViews) {
      return this.bytes.subarray(start, start + count);
    }
    return this.bytes.slice(start, start + count);
  }

  /**
   * Resolves an ASCII `string` object, stored one byte per character with
   * every code point in 0–127. A byte above `0x7f` is out of spec — the
   * writer encodes such strings as UTF-16 (the `0x6n` marker) — so it fails
   * rather than being silently reinterpreted as a Latin-1 character.
   */
  private parseAsciiString(offset: number, objectInfo: number): string {
    this.readLength(offset, objectInfo);
    const count = this.lengthCount;
    const start = this.lengthStart;
    this.requireBytes(start, count);
    // The span check above covers the whole string, so the loop can index the
    // byte array directly instead of paying a bounds check per character.
    const bytes = this.bytes;
    let out = "";
    for (let i = 0; i < count; i++) {
      const byte = bytes[start + i]!;
      if (byte > 0x7f) {
        this.fail("binary ASCII <string> contains a non-ASCII byte", start + i);
      }
      out += String.fromCharCode(byte);
    }
    return out;
  }

  /**
   * Resolves a Unicode `string` object, stored as UTF-16 code units of two
   * big-endian bytes each. JS strings are UTF-16, so the units pass straight
   * through.
   */
  private parseUnicodeString(offset: number, objectInfo: number): string {
    this.readLength(offset, objectInfo);
    const count = this.lengthCount;
    const start = this.lengthStart;
    this.requireBytes(start, count * 2);
    const view = this.view;
    let out = "";
    for (let i = 0; i < count; i++) {
      out += String.fromCharCode(view.getUint16(start + i * 2));
    }
    return out;
  }

  /**
   * Resolves an `array` (or set) object, stored as a count followed by that
   * many object references, each resolved in turn.
   */
  private parseArray(offset: number, objectInfo: number, depth: number): PlistArray {
    this.readLength(offset, objectInfo);
    const count = this.lengthCount;
    const start = this.lengthStart;
    this.requireBytes(start, count * this.objectRefSize);
    const array: PlistArray = [];
    for (let i = 0; i < count; i++) {
      array.push(this.parseObject(this.readRef(start + i * this.objectRefSize), depth));
    }
    return array;
  }

  /**
   * Resolves a `dict` object, stored as a count, then all key references,
   * then all value references. Keys must resolve to strings, and a literal
   * `__proto__` key is stored as an own property so untrusted documents
   * cannot pollute prototypes.
   */
  private parseDict(offset: number, objectInfo: number, depth: number): PlistDictionary {
    this.readLength(offset, objectInfo);
    const count = this.lengthCount;
    const start = this.lengthStart;
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
   * begin, leaving them in {@link lengthCount} and {@link lengthStart}. A low
   * nibble below 0xF is the count itself; 0xF means the count is an inline
   * integer object immediately after the marker.
   *
   * Results land in scratch fields rather than a returned pair because this
   * runs for every string, data, array, and dict object; the fields are
   * consumed immediately by the caller before any further parsing.
   *
   * @param offset Byte offset of the object's marker.
   * @param objectInfo The marker's low nibble, already extracted by
   *   {@link parseObject} so the marker byte is not re-read here.
   */
  private readLength(offset: number, objectInfo: number): void {
    if (objectInfo !== 0x0f) {
      this.lengthCount = objectInfo;
      this.lengthStart = offset + 1;
      return;
    }
    const sizeMarker = this.u8(offset + 1);
    if (sizeMarker >> 4 !== 0x1) {
      this.fail("binary length prefix is not an integer", offset + 1);
    }
    const intByteCount = 1 << (sizeMarker & 0x0f);
    this.lengthCount = this.readBigEndianUint(offset + 2, intByteCount);
    this.lengthStart = offset + 2 + intByteCount;
  }

  /**
   * Reads one object reference and validates it against the object count.
   * The read itself skips {@link requireBytes} because both containers
   * span-check all their references in one call before looping.
   *
   * @param offset Byte offset of the reference within a container.
   * @returns The referenced object's index into the offset table.
   */
  private readRef(offset: number): number {
    const index = this.readUintSized(offset, this.objectRefSize);
    if (index >= this.objectCount) {
      this.fail("binary object reference is out of range", offset);
    }
    return index;
  }

  /**
   * Returns the byte offset of object `index` from the offset table, validated
   * to point into the object region (after the magic, before the table).
   * The read skips {@link requireBytes} because {@link parse} validated the
   * whole table span up front and every `index` is validated against
   * `objectCount` before arriving here.
   */
  private objectOffset(index: number): number {
    const entry = this.offsetTableOffset + index * this.offsetIntSize;
    const offset = this.readUintSized(entry, this.offsetIntSize);
    if (offset < MAGIC.length || offset >= this.offsetTableOffset) {
      this.fail("binary object offset is out of bounds", entry);
    }
    return offset;
  }

  /**
   * Reads an offset-table entry or object reference whose span was already
   * validated. One- and two-byte widths cover practically every document.
   */
  private readUintSized(offset: number, size: number): number {
    switch (size) {
      case 1:
        return this.bytes[offset]!;
      case 2:
        return this.view.getUint16(offset);
      default:
        return this.readUintUnchecked(offset, size);
    }
  }

  /**
   * Reads a big-endian unsigned integer of `size` bytes as a number. Used for
   * offsets, references, and lengths, which are always well within the safe
   * integer range for any real document.
   *
   * The 1/2/4/8-byte widths — the only ones the platform writer emits — read
   * through fixed-width `DataView` accessors instead of a byte loop because
   * this runs for every offset-table entry and object reference; odd widths
   * (a 3-byte offset size is legal) keep the loop.
   */
  private readBigEndianUint(offset: number, size: number): number {
    this.requireBytes(offset, size);
    return this.readUintUnchecked(offset, size);
  }

  /**
   * {@link readBigEndianUint} without the bounds check, for callers whose
   * span was already validated (the offset table in {@link parse}, container
   * reference lists in {@link parseArray} and {@link parseDict}).
   */
  private readUintUnchecked(offset: number, size: number): number {
    switch (size) {
      case 1:
        return this.view.getUint8(offset);
      case 2:
        return this.view.getUint16(offset);
      case 4:
        return this.view.getUint32(offset);
      case 8:
        return this.view.getUint32(offset) * 0x1_0000_0000 + this.view.getUint32(offset + 4);
      default: {
        let value = 0;
        for (let i = 0; i < size; i++) {
          value = value * 256 + this.view.getUint8(offset + i);
        }
        return value;
      }
    }
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
