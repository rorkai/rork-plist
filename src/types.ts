/**
 * The value model shared by {@link parsePlist} and {@link buildPlist}.
 *
 * The mapping follows the property list XML DTD
 * (https://www.apple.com/DTDs/PropertyList-1.0.dtd) element for element:
 *
 * | Plist element         | JavaScript value                                         |
 * | --------------------- | -------------------------------------------------------- |
 * | `<string>` / `<key>`  | `string`                                                 |
 * | `<integer>`           | `number`, or `bigint` beyond `Number.MAX_SAFE_INTEGER`   |
 * | `<real>`              | `number`                                                 |
 * | `<true/>` `<false/>`  | `boolean`                                                |
 * | `<date>`              | `Date` (UTC, second precision)                           |
 * | `<data>`              | `Uint8Array`                                             |
 * | `<array>`             | {@link PlistArray}                                       |
 * | `<dict>`              | {@link PlistDictionary}                                  |
 *
 * Keyed-archive UID objects have no XML element of their own. They surface
 * as {@link PlistUid} and render as the one-key `CF$UID` integer dictionary
 * the platform uses.
 *
 * @module
 */

/**
 * A value representable in an Apple property list.
 *
 * Two number-like cases deserve attention:
 *
 * - `<integer>` values that fit within `Number.MAX_SAFE_INTEGER` parse as
 *   `number`; anything larger parses as `bigint` so 64-bit identifiers and
 *   tokens never lose precision silently. Both `number` and `bigint` build
 *   back into `<integer>` elements.
 * - Integral `number`s build as `<integer>`; fractional ones build as
 *   `<real>`. A `number` that happens to be integral therefore does not
 *   round-trip as a `<real>` — protocols that depend on the distinction
 *   should carry reals as fractional values.
 */
export type PlistValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Uint8Array
  | PlistUid
  | PlistArray
  | PlistDictionary;

/**
 * A keyed-archive UID, the object-table reference NSKeyedArchiver stores
 * between entries of its `$objects` array.
 *
 * The binary format stores a UID as an unsigned integer of one to four
 * bytes and the platform reader rejects anything wider, so an index never
 * exceeds 32 bits. XML has no UID element. The platform renders a UID there
 * as a dictionary holding a single `CF$UID` integer and reads exactly that
 * shape back as a UID, and this library does the same in both directions.
 */
export class PlistUid {
  /** The archive object-table index. */
  readonly uid: number;

  /**
   * @param uid An integer from 0 to 0xffffffff.
   * @throws RangeError when the value is not an integer, is negative, or
   *   does not fit in 32 bits. The platform writer silently wraps such
   *   values modulo 2^32, and refusing them here keeps a corrupted archive
   *   from being written at all.
   */
  constructor(uid: number) {
    if (!Number.isInteger(uid) || uid < 0 || uid > 0xff_ff_ff_ff) {
      throw new RangeError(`a UID must be an unsigned 32-bit integer, got ${uid}`);
    }
    this.uid = uid;
  }
}

/**
 * An `<array>` element — an ordered list of property list values.
 *
 * This is a plain JavaScript array; the interface exists only to give the
 * recursive {@link PlistValue} type a name.
 */
export interface PlistArray extends Array<PlistValue> {}

/**
 * A `<dict>` element — a plain object whose keys appear in document order.
 *
 * Duplicate keys in a parsed document resolve to the last occurrence,
 * matching the reference parser. A literal `__proto__` key is always stored
 * as an own property, so parsing untrusted documents cannot pollute
 * prototypes. When building, a key whose value is `undefined` is omitted
 * (as `JSON.stringify` does), so optional fields need no manual stripping.
 */
export interface PlistDictionary {
  [key: string]: PlistValue;
}

/**
 * A property list serialization format, as {@link detectPlistFormat}
 * classifies documents and {@link buildPlist} selects builders.
 */
export type PlistFormat = "binary" | "xml" | "openstep";

/**
 * Narrows a property list value to a dictionary.
 *
 * The guard rules out every other object shape in the value model, including
 * {@link PlistUid}, which is an object but not a dictionary. It lives in the
 * library so it evolves together with {@link PlistValue}. A caller-side
 * shape test written against an older union keeps compiling after the union
 * grows and then quietly misclassifies the new shape, which is exactly what
 * would have happened to a pre-UID guard once UIDs started parsing as
 * `PlistUid` objects.
 *
 * `null` and `undefined` are accepted so optional lookups, such as a
 * dictionary member that may be absent, can be narrowed directly.
 */
export function isPlistDictionary(value: PlistValue | null | undefined): value is PlistDictionary {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date) &&
    !(value instanceof PlistUid)
  );
}
