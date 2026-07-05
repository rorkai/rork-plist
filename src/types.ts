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
export type PlistValue = string | number | bigint | boolean | Date | Uint8Array | PlistArray | PlistDictionary;

/**
 * An `<array>` element: an ordered list of property list values.
 *
 * This is a plain JavaScript array; the interface exists only to give the
 * recursive {@link PlistValue} type a name.
 */
export interface PlistArray extends Array<PlistValue> {}

/**
 * A `<dict>` element: a plain object whose keys appear in document order.
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
