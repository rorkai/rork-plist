/**
 * Named UTF-16 code units used by the scanner, the text escaper, and the
 * base64 codec.
 *
 * The hot paths in this library compare `charCodeAt` results directly instead
 * of allocating one-character strings; naming the code points keeps those
 * comparisons readable without giving up the performance of integer
 * comparisons.
 */

/** The tab character, `\t`. */
export const TAB = 0x09;

/** The line feed character, `\n`. */
export const LINE_FEED = 0x0a;

/** The form feed character, `\f`. */
export const FORM_FEED = 0x0c;

/** The carriage return character, `\r`. */
export const CARRIAGE_RETURN = 0x0d;

/** The space character. */
export const SPACE = 0x20;

/** `!`, the second character of `<!--`, `<!DOCTYPE`, and `<![CDATA[`. */
export const EXCLAMATION_MARK = 0x21;

/** `"`, one of the two XML attribute value quotes. */
export const DOUBLE_QUOTE = 0x22;

/** `#`, the marker of a numeric character reference (`&#10;`). */
export const HASH = 0x23;

/** `&`, the start of an entity or character reference. */
export const AMPERSAND = 0x26;

/** `'`, the other XML attribute value quote. */
export const APOSTROPHE = 0x27;

/** `+`, an optional integer sign. */
export const PLUS_SIGN = 0x2b;

/** `-`, the negative integer sign and the date component separator. */
export const HYPHEN_MINUS = 0x2d;

/** `/`, the closing-tag and self-closing-tag marker. */
export const SLASH = 0x2f;

/** `0`, the low end of the ASCII digit range. */
export const DIGIT_ZERO = 0x30;

/** `9`, the high end of the ASCII digit range. */
export const DIGIT_NINE = 0x39;

/** `:`, the time component separator in `<date>` values. */
export const COLON = 0x3a;

/** `<`, the start of any markup. */
export const LESS_THAN = 0x3c;

/** `=`, the attribute name/value separator and the base64 padding symbol. */
export const EQUALS_SIGN = 0x3d;

/** `>`, the end of a tag. */
export const GREATER_THAN = 0x3e;

/** `?`, the second character of a processing instruction (`<?xml ...?>`). */
export const QUESTION_MARK = 0x3f;

/** `T`, the date/time separator in `<date>` values. */
export const UPPERCASE_T = 0x54;

/** `X`, the uppercase hexadecimal reference marker (`&#X41;`). */
export const UPPERCASE_X = 0x58;

/** `Z`, the mandatory UTC suffix of `<date>` values. */
export const UPPERCASE_Z = 0x5a;

/** `[`, the opener of a CDATA section or DOCTYPE internal subset. */
export const LEFT_BRACKET = 0x5b;

/** `]`, the closer of a DOCTYPE internal subset. */
export const RIGHT_BRACKET = 0x5d;

/** `x`, the hexadecimal marker in `0x` integers and `&#x...;` references. */
export const LOWERCASE_X = 0x78;

/** First code unit of the high (leading) surrogate range. */
export const HIGH_SURROGATE_START = 0xd800;

/** Last code unit of the high (leading) surrogate range. */
export const HIGH_SURROGATE_END = 0xdbff;

/** First code unit of the low (trailing) surrogate range. */
export const LOW_SURROGATE_START = 0xdc00;

/** Last code unit of the low (trailing) surrogate range. */
export const LOW_SURROGATE_END = 0xdfff;

/** Highest Unicode code point a character reference may designate. */
export const MAX_CODE_POINT = 0x10_ffff;

/**
 * Reports whether a code unit is XML whitespace (space, tab, line feed, or
 * carriage return), the set that separates plist markup tokens.
 *
 * The base64 codec does not share this predicate: its whitespace set also
 * includes the form feed, matching the platform parser and the standard
 * `Uint8Array.fromBase64` codec.
 */
export function isWhitespaceCode(code: number): boolean {
  return code === SPACE || code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN;
}
