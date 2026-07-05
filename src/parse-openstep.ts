/**
 * OpenStep (NeXTSTEP) text property list parsing.
 *
 * The OpenStep format predates both XML and binary property lists and
 * survives in Xcode's `project.pbxproj`, in `.strings` localization files,
 * and in old configuration files. A document is a value written as `{ key =
 * value; }` dictionaries, `( a, b )` arrays, `<0fbd77>` hex data, and quoted
 * or bare strings — the format is untyped, so every leaf other than data is
 * a string. The reference implementation reads OpenStep but cannot write it
 * (`plutil -convert` offers no OpenStep target), and this library mirrors
 * that: parsing only.
 *
 * Every grammar decision here is pinned empirically against the platform
 * parser, probed case by case through plutil: the bare-key `"key";`
 * shorthand (the value becomes the key), brace-less strings-file documents,
 * mandatory entry semicolons, single- and double-quoted strings, the
 * C-style and octal escapes (octal values map through the NeXTSTEP text
 * encoding, captured verbatim in {@link NEXTSTEP_HIGH_CODE_UNITS}),
 * variable-length `\U` escapes that keep lone surrogates, non-nesting
 * comments that may run to end of input, per-group even hex digits inside
 * data, and whitespace-only input reading as an empty dictionary while
 * empty input is rejected.
 *
 * @module
 */

import { PlistParseError } from "./errors";
import { DEFAULT_MAX_DEPTH, type ParsePlistOptions } from "./parse-options";
import type { PlistDictionary, PlistValue } from "./types";

/**
 * Unicode code units for the NeXTSTEP text encoding's 0x80–0xFF range.
 *
 * Octal escapes are byte values in the NeXTSTEP character set, not Latin-1:
 * `"\341"` is `Æ`, not `á`. This table is the platform parser's own mapping,
 * captured byte by byte through plutil by converting every escape from 0x80
 * to 0xFF and recording the code unit it produced (the last two positions
 * are unassigned in the encoding and map to U+0000).
 */
// oxfmt-ignore
const NEXTSTEP_HIGH_CODE_UNITS = [
  0x00a0, 0x00c0, 0x00c1, 0x00c2, 0x00c3, 0x00c4, 0x00c5, 0x00c7,
  0x00c8, 0x00c9, 0x00ca, 0x00cb, 0x00cc, 0x00cd, 0x00ce, 0x00cf,
  0x00d0, 0x00d1, 0x00d2, 0x00d3, 0x00d4, 0x00d5, 0x00d6, 0x00d9,
  0x00da, 0x00db, 0x00dc, 0x00dd, 0x00de, 0x00b5, 0x00d7, 0x00f7,
  0x00a9, 0x00a1, 0x00a2, 0x00a3, 0x2044, 0x00a5, 0x0192, 0x00a7,
  0x00a4, 0x2019, 0x201c, 0x00ab, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x00ae, 0x2013, 0x2020, 0x2021, 0x00b7, 0x00a6, 0x00b6, 0x2022,
  0x201a, 0x201e, 0x201d, 0x00bb, 0x2026, 0x2030, 0x00ac, 0x00bf,
  0x00b9, 0x02cb, 0x00b4, 0x02c6, 0x02dc, 0x00af, 0x02d8, 0x02d9,
  0x00a8, 0x00b2, 0x02da, 0x00b8, 0x00b3, 0x02dd, 0x02db, 0x02c7,
  0x2014, 0x00b1, 0x00bc, 0x00bd, 0x00be, 0x00e0, 0x00e1, 0x00e2,
  0x00e3, 0x00e4, 0x00e5, 0x00e7, 0x00e8, 0x00e9, 0x00ea, 0x00eb,
  0x00ec, 0x00c6, 0x00ed, 0x00aa, 0x00ee, 0x00ef, 0x00f0, 0x00f1,
  0x0141, 0x00d8, 0x0152, 0x00ba, 0x00f2, 0x00f3, 0x00f4, 0x00f5,
  0x00f6, 0x00e6, 0x00f9, 0x00fa, 0x00fb, 0x0131, 0x00fc, 0x00fd,
  0x0142, 0x00f8, 0x0153, 0x00df, 0x00fe, 0x00ff, 0x0000, 0x0000,
] as const;

/**
 * Parses an OpenStep (NeXTSTEP) text property list into JavaScript values.
 *
 * The format is untyped, so leaves parse as `string` (quoted or bare) or
 * `Uint8Array` (`<hex>` data); containers are arrays and dictionaries.
 * Strings-file documents — brace-less `key = value;` entries, including the
 * bare `"key";` shorthand whose value is the key itself — parse as a
 * dictionary, matching the reference parser.
 *
 * {@link parsePlist} reaches this parser automatically for text that is not
 * XML, so calling it directly is only needed when the input is known to be
 * OpenStep and a misparse as XML should be impossible.
 *
 * @param text The document text.
 * @param options See {@link ParsePlistOptions}; the `data` option has no
 *   effect here because hex data always decodes into fresh bytes.
 * @returns The document's root value.
 * @throws PlistParseError when the text is not a well-formed OpenStep
 *   property list; the error carries the line and column of the failure.
 */
export function parseOpenStepPlist(text: string, options: ParsePlistOptions = {}): PlistValue {
  return new OpenStepParser(text, options.maxDepth ?? DEFAULT_MAX_DEPTH).parseDocument();
}

/** Reports whether a code unit is OpenStep whitespace (HT–CR plus space). */
function isOpenStepWhitespace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

/**
 * Reports whether a code unit may appear in a bare (unquoted) string. The
 * alphabet is exactly the reference parser's: ASCII letters and digits plus
 * `_`, `$`, `/`, `:`, `.`, and `-`. Everything else — including non-ASCII —
 * requires quoting.
 */
function isBareStringCode(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x5f || // _
    code === 0x24 || // $
    code === 0x2f || // /
    code === 0x3a || // :
    code === 0x2e || // .
    code === 0x2d // -
  );
}

/** Returns the value of an ASCII hex digit, or -1 when the unit is not one. */
function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30;
  }
  if (code >= 0x61 && code <= 0x66) {
    return code - 0x61 + 10;
  }
  if (code >= 0x41 && code <= 0x46) {
    return code - 0x41 + 10;
  }
  return -1;
}

/**
 * Single-use recursive-descent parser over one OpenStep document. The
 * instance tracks one piece of state — the current offset `pos` — and moves
 * strictly forward through the input.
 */
class OpenStepParser {
  /** Current offset into {@link src}; only ever moves forward. */
  private pos = 0;

  /**
   * @param src Source text of the document.
   * @param maxDepth Maximum container nesting depth before parsing fails.
   */
  constructor(
    private readonly src: string,
    private readonly maxDepth: number,
  ) {}

  /**
   * Parses the whole document.
   *
   * The root is one value, with two verified deviations from "exactly one
   * value": input that is only whitespace and comments parses as an empty
   * dictionary (an entry-less strings file), and a root string followed by
   * `=` or `;` reparses as a brace-less strings-file dictionary — which also
   * makes `"key";` produce `{ key: "key" }` while a bare `"key"` stays a
   * string, matching the reference parser on both.
   */
  parseDocument(): PlistValue {
    if (this.src.length === 0) {
      this.fail("OpenStep document is empty", 0);
    }
    if (this.src.charCodeAt(0) === 0xfeff) {
      this.pos = 1; // byte order mark
    }
    this.skipVoid();
    if (this.pos >= this.src.length) {
      return {};
    }

    const start = this.pos;
    const first = this.parseValue(0);
    this.skipVoid();
    if (this.pos >= this.src.length) {
      return first;
    }

    const code = this.src.charCodeAt(this.pos);
    if (typeof first === "string" && (code === 0x3d || code === 0x3b)) {
      // '=' or ';' after a root string is a strings-file document.
      this.pos = start;
      return this.parseDictionaryBody(1, false);
    }
    this.fail("unexpected content after the root value");
  }

  /**
   * Parses one value at the current position, dispatched on its first
   * character.
   */
  private parseValue(depth: number): PlistValue {
    if (depth > this.maxDepth) {
      this.fail(`maximum nesting depth of ${this.maxDepth} exceeded`);
    }
    const code = this.src.charCodeAt(this.pos);
    switch (code) {
      case 0x7b: // {
        this.pos++;
        return this.parseDictionaryBody(depth + 1, true);
      case 0x28: // (
        this.pos++;
        return this.parseArrayBody(depth + 1);
      case 0x3c: // <
        return this.parseData();
      case 0x22: // "
      case 0x27: // '
        return this.parseQuotedString(code);
      default:
        return this.parseBareString();
    }
  }

  /**
   * Parses dictionary entries up to the closing brace (braced form) or the
   * end of input (strings-file form). Keys must be strings; every entry —
   * including the bare-key `key;` shorthand, whose value is the key itself —
   * ends with a mandatory semicolon. Duplicate keys resolve to the last
   * occurrence, and a literal `__proto__` key is stored as an own property
   * so untrusted documents cannot pollute prototypes.
   */
  private parseDictionaryBody(depth: number, braced: boolean): PlistDictionary {
    const dict: PlistDictionary = {};
    for (;;) {
      this.skipVoid();
      if (braced) {
        if (this.pos >= this.src.length) {
          this.fail("unterminated dictionary");
        }
        if (this.src.charCodeAt(this.pos) === 0x7d) {
          this.pos++;
          return dict;
        }
      } else if (this.pos >= this.src.length) {
        return dict;
      }

      const key = this.parseStringToken("a dictionary key");
      this.skipVoid();

      let value: PlistValue;
      if (this.src.charCodeAt(this.pos) === 0x3d) {
        this.pos++;
        this.skipVoid();
        if (this.pos >= this.src.length) {
          this.fail("dictionary entry is missing a value");
        }
        value = this.parseValue(depth);
        this.skipVoid();
      } else {
        // The bare-key shorthand used by strings files.
        value = key;
      }

      if (this.src.charCodeAt(this.pos) !== 0x3b) {
        this.fail("expected ';' after the dictionary entry");
      }
      this.pos++;

      if (key === "__proto__") {
        Object.defineProperty(dict, key, { configurable: true, enumerable: true, value, writable: true });
      } else {
        dict[key] = value;
      }
    }
  }

  /**
   * Parses array elements up to the closing parenthesis. Elements are
   * comma-separated; a trailing comma before `)` is allowed, a leading or
   * doubled comma is not.
   */
  private parseArrayBody(depth: number): PlistValue[] {
    const array: PlistValue[] = [];
    this.skipVoid();
    if (this.src.charCodeAt(this.pos) === 0x29) {
      this.pos++;
      return array;
    }
    for (;;) {
      if (this.pos >= this.src.length) {
        this.fail("unterminated array");
      }
      array.push(this.parseValue(depth));
      this.skipVoid();
      const code = this.src.charCodeAt(this.pos);
      if (code === 0x2c) {
        this.pos++;
        this.skipVoid();
        if (this.src.charCodeAt(this.pos) === 0x29) {
          this.pos++;
          return array;
        }
        continue;
      }
      if (code === 0x29) {
        this.pos++;
        return array;
      }
      this.fail("expected ',' or ')' in the array");
    }
  }

  /**
   * Parses a `<hex bytes>` data literal. Whitespace separates byte groups,
   * each group must hold an even number of hex digits, and comments are not
   * recognized inside the literal — all verified against the reference
   * parser.
   */
  private parseData(): Uint8Array {
    const start = this.pos;
    this.pos++; // consume '<'
    const src = this.src;
    const bytes: number[] = [];
    for (;;) {
      while (this.pos < src.length && isOpenStepWhitespace(src.charCodeAt(this.pos))) {
        this.pos++;
      }
      if (this.pos >= src.length) {
        this.fail("unterminated data", start);
      }
      if (src.charCodeAt(this.pos) === 0x3e) {
        this.pos++;
        return Uint8Array.from(bytes);
      }

      const groupStart = this.pos;
      let high = hexValue(src.charCodeAt(this.pos));
      if (high < 0) {
        this.fail("data may only contain hex digits");
      }
      while (high >= 0) {
        this.pos++;
        const low = this.pos < src.length ? hexValue(src.charCodeAt(this.pos)) : -1;
        if (low < 0) {
          this.fail("data contains an odd number of hex digits in a group", groupStart);
        }
        this.pos++;
        bytes.push((high << 4) | low);
        high = this.pos < src.length ? hexValue(src.charCodeAt(this.pos)) : -1;
      }
    }
  }

  /**
   * Parses the string forms a dictionary key permits — quoted, single-quoted,
   * or bare. Anything else fails with a message naming the caller's context.
   */
  private parseStringToken(role: string): string {
    const code = this.src.charCodeAt(this.pos);
    if (code === 0x22 || code === 0x27) {
      return this.parseQuotedString(code);
    }
    if (isBareStringCode(code)) {
      return this.parseBareString();
    }
    this.fail(`expected ${role}`);
  }

  /** Parses a bare string token; fails when no bare-string character is present. */
  private parseBareString(): string {
    const src = this.src;
    const start = this.pos;
    while (this.pos < src.length && isBareStringCode(src.charCodeAt(this.pos))) {
      this.pos++;
    }
    if (this.pos === start) {
      const char = this.pos < src.length ? src.charAt(this.pos) : "end of input";
      this.fail(`unexpected ${char === "end of input" ? char : `character ${JSON.stringify(char)}`}`);
    }
    return src.slice(start, this.pos);
  }

  /**
   * Parses a quoted string body after its opening quote (double or single).
   * Backslash escapes cover the C set (`\a \b \f \n \r \t \v`), one to three
   * octal digits mapped through the NeXTSTEP encoding, and `\U` with up to
   * four hex digits kept as a raw UTF-16 code unit (lone surrogates
   * included); any other escaped character stands for itself, which is how
   * quotes, backslashes, and literal newlines are carried.
   */
  private parseQuotedString(quote: number): string {
    const src = this.src;
    const start = this.pos;
    this.pos++; // consume the opening quote
    let out = "";
    let plainStart = this.pos;
    for (;;) {
      if (this.pos >= src.length) {
        this.fail("unterminated string", start);
      }
      const code = src.charCodeAt(this.pos);
      if (code === quote) {
        out += src.slice(plainStart, this.pos);
        this.pos++;
        return out;
      }
      if (code !== 0x5c) {
        this.pos++;
        continue;
      }
      out += src.slice(plainStart, this.pos);
      this.pos++; // consume the backslash
      if (this.pos >= src.length) {
        this.fail("unterminated string", start);
      }
      out += this.resolveEscape();
      plainStart = this.pos;
    }
  }

  /**
   * Resolves one escape sequence, positioned after its backslash, and leaves
   * the position after the sequence.
   */
  private resolveEscape(): string {
    const src = this.src;
    const code = src.charCodeAt(this.pos);

    if (code >= 0x30 && code <= 0x37) {
      // Up to three octal digits; the value is a byte in the NeXTSTEP
      // encoding (larger spellings wrap to a byte first, as the reference
      // parser does).
      let value = 0;
      let digits = 0;
      while (digits < 3 && this.pos < src.length) {
        const digit = src.charCodeAt(this.pos) - 0x30;
        if (digit < 0 || digit > 7) {
          break;
        }
        value = value * 8 + digit;
        digits++;
        this.pos++;
      }
      const byte = value & 0xff;
      return String.fromCharCode(byte < 0x80 ? byte : NEXTSTEP_HIGH_CODE_UNITS[byte - 0x80]!);
    }

    if (code === 0x55) {
      // \U with up to four hex digits, taken as one raw UTF-16 code unit.
      // Zero digits yield U+0000 and lone surrogates pass through, matching
      // the reference parser.
      this.pos++;
      let value = 0;
      let digits = 0;
      while (digits < 4 && this.pos < src.length) {
        const digit = hexValue(src.charCodeAt(this.pos));
        if (digit < 0) {
          break;
        }
        value = value * 16 + digit;
        digits++;
        this.pos++;
      }
      return String.fromCharCode(value);
    }

    this.pos++;
    switch (code) {
      case 0x61: // a
        return "\u0007";
      case 0x62: // b
        return "\b";
      case 0x66: // f
        return "\f";
      case 0x6e: // n
        return "\n";
      case 0x72: // r
        return "\r";
      case 0x74: // t
        return "\t";
      case 0x76: // v
        return "\v";
      default:
        // Any other escaped character stands for itself.
        return String.fromCharCode(code);
    }
  }

  /**
   * Skips whitespace and comments. Line comments run to the end of the line;
   * block comments do not nest and are allowed to run to the end of the
   * input, both matching the reference parser.
   */
  private skipVoid(): void {
    const src = this.src;
    for (;;) {
      while (this.pos < src.length && isOpenStepWhitespace(src.charCodeAt(this.pos))) {
        this.pos++;
      }
      if (src.charCodeAt(this.pos) !== 0x2f) {
        return;
      }
      const next = src.charCodeAt(this.pos + 1);
      if (next === 0x2f) {
        const lf = src.indexOf("\n", this.pos + 2);
        const cr = src.indexOf("\r", this.pos + 2);
        const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
        this.pos = end < 0 ? src.length : end + 1;
      } else if (next === 0x2a) {
        const end = src.indexOf("*/", this.pos + 2);
        this.pos = end < 0 ? src.length : end + 2;
      } else {
        return;
      }
    }
  }

  /**
   * Throws a {@link PlistParseError} anchored at an offset (the current
   * position by default). Return type is `never` so call sites need no
   * explicit control flow after it.
   */
  private fail(message: string, offset = this.pos): never {
    throw new PlistParseError(message, this.src, offset);
  }
}
