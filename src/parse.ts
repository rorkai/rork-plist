/**
 * Property list parsing entry point and the XML parser.
 *
 * {@link parsePlist} is the public entry. It takes an XML string, or a buffer
 * that it routes to the binary parser (see {@link "./parse-binary"}) or
 * decodes as UTF-8 XML. The XML parser itself is a hand-written
 * recursive-descent scanner over the property list grammar rather than a
 * general XML parser. The plist DTD is a closed vocabulary of ten elements
 * with no meaningful attributes, so a dedicated scanner is both faster and
 * safer — DOCTYPE internal subsets are skipped without processing, and
 * external entities simply do not exist here, which rules out
 * entity-expansion and external-entity attacks by construction.
 *
 * Grammar decisions mirror the reference implementation's observed behavior,
 * verified against the platform plist tooling in the test suite. That covers
 * hexadecimal integers, `nan`/`inf` reals, second-precision UTC dates,
 * duplicate dictionary keys resolving to the last occurrence, `<key>`
 * outside a dictionary parsing as a string, attributes being ignored, and
 * content after the closing `</plist>` tag being ignored. The one deliberate
 * strictness deviation is documented on {@link parsePlist} — corrupt base64
 * in `<data>` raises an error instead of silently decoding to fewer bytes.
 *
 * @module
 */

import { decodeBase64 } from "./base64";
import { PlistParseError } from "./errors";
import {
  APOSTROPHE,
  COLON,
  DIGIT_NINE,
  DIGIT_ZERO,
  DOUBLE_QUOTE,
  EQUALS_SIGN,
  EXCLAMATION_MARK,
  GREATER_THAN,
  HASH,
  HIGH_SURROGATE_START,
  HYPHEN_MINUS,
  isWhitespaceCode,
  LEFT_BRACKET,
  LESS_THAN,
  LOW_SURROGATE_END,
  LOWERCASE_X,
  MAX_CODE_POINT,
  PLUS_SIGN,
  QUESTION_MARK,
  RIGHT_BRACKET,
  SLASH,
  UPPERCASE_T,
  UPPERCASE_X,
  UPPERCASE_Z,
} from "./internal/character-codes";
import {
  MAX_SAFE_INTEGER_BIGINT,
  MIN_SAFE_INTEGER_BIGINT,
  PLIST_INTEGER_MAX,
  PLIST_INTEGER_MIN,
} from "./internal/integer-range";
import { hasBinaryPlistMagic, parseBinaryPlist } from "./parse-binary";
import { DEFAULT_MAX_DEPTH, type ParsePlistOptions } from "./parse-options";
import type { PlistArray, PlistDictionary, PlistValue } from "./types";

export type { ParsePlistOptions } from "./parse-options";

/**
 * Decodes UTF-8 bytes to a string for the XML path of {@link parsePlist}.
 * `fatal` makes malformed byte sequences throw instead of decoding to the
 * replacement character, so a corrupt buffer fails loudly rather than parsing
 * into silently mangled string values.
 */
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Decimal or `0x`-prefixed hexadecimal digits with an optional sign. */
const INTEGER_PATTERN = /^[+-]?(?:0[xX][0-9a-fA-F]+|[0-9]+)$/u;

/** Ordinary decimal notation with an optional exponent. */
const REAL_PATTERN = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/u;

/** The `nan`/`inf`/`infinity` spellings the reference parser accepts. */
const REAL_SPECIAL_PATTERN = /^[+-]?(?:nan|inf|infinity)$/iu;

/** Digit alphabet of a decimal character reference (`&#10;`). */
const DECIMAL_DIGITS_PATTERN = /^[0-9]+$/u;

/** Digit alphabet of a hexadecimal character reference (`&#x1F600;`). */
const HEX_DIGITS_PATTERN = /^[0-9a-fA-F]+$/u;

/**
 * Longest unsigned `<integer>` spelling that `Number()` converts exactly:
 * fifteen decimal digits stay below 2^50, and `0x` plus thirteen hexadecimal
 * digits stay below 2^52 — both inside the 2^53 exact-integer range. Longer
 * spellings take the bigint path, which handles them at any length.
 */
const MAX_EXACT_NUMBER_SPELLING = 15;

/**
 * Reports whether a code unit can appear in an XML name. Plist element names
 * are all lowercase ASCII, so this deliberately simplified alphabet only
 * affects how precisely foreign markup is rejected, not which documents
 * parse.
 */
function isNameCharCode(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= DIGIT_ZERO && code <= DIGIT_NINE) ||
    code === HYPHEN_MINUS ||
    code === 0x2e || // .
    code === COLON ||
    code === 0x5f // _
  );
}

/**
 * Reads a fixed-width run of ASCII digits as a number, or -1 when any
 * position is not a digit.
 */
function digitsAt(text: string, start: number, length: number): number {
  let value = 0;
  for (let i = start; i < start + length; i++) {
    const code = text.charCodeAt(i);
    if (code < DIGIT_ZERO || code > DIGIT_NINE) {
      return -1;
    }
    value = value * 10 + (code - DIGIT_ZERO);
  }
  return value;
}

/**
 * Parses the one `<date>` layout the reference parser accepts — second
 * precision with a mandatory trailing `Z` (`2026-07-04T10:20:30Z`) — or
 * returns null.
 *
 * The layout is fixed-width, so the components are read positionally
 * instead of through a regular expression plus `Date.parse`, which would
 * scan the text twice. `Date.UTC` silently rolls out-of-range components
 * over (month 13 becomes January), so the constructed date is compared back
 * against the parsed components to reject impossible dates.
 */
function parsePlistDate(text: string): Date | null {
  if (
    text.length !== 20 ||
    text.charCodeAt(4) !== HYPHEN_MINUS ||
    text.charCodeAt(7) !== HYPHEN_MINUS ||
    text.charCodeAt(10) !== UPPERCASE_T ||
    text.charCodeAt(13) !== COLON ||
    text.charCodeAt(16) !== COLON ||
    text.charCodeAt(19) !== UPPERCASE_Z
  ) {
    return null;
  }

  const year = digitsAt(text, 0, 4);
  const month = digitsAt(text, 5, 2);
  const day = digitsAt(text, 8, 2);
  const hour = digitsAt(text, 11, 2);
  const minute = digitsAt(text, 14, 2);
  const second = digitsAt(text, 17, 2);
  if (year < 0 || month < 0 || day < 0 || hour < 0 || minute < 0 || second < 0) {
    return null;
  }

  // Built with the setter API rather than Date.UTC because Date.UTC remaps
  // years 0-99 into 1900-1999; the setters take every year literally, and
  // the reference parser accepts the full 0000-9999 range.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);

  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  return roundTrips ? date : null;
}

/**
 * An opening tag as returned by the tokenizer.
 */
interface OpenTag {
  /** Element name exactly as written; plist names are case-sensitive. */
  name: string;

  /** Whether the tag was self-closing (`<true/>`). */
  selfClosed: boolean;

  /** Offset of the tag's `<`, kept for error reporting. */
  start: number;
}

/**
 * Parses a property list into JavaScript values.
 *
 * Accepts both formats. A `string` is always parsed as XML. A `Uint8Array` is
 * parsed as binary (`bplist00`) when it carries the binary magic, and
 * otherwise decoded as UTF-8 and parsed as XML — so a caller holding raw bytes
 * (a file read, an HTTP body) can pass them through without sniffing the
 * format first.
 *
 * XML parsing accepts complete documents — XML declaration, DOCTYPE, comments,
 * a `<plist>` wrapper — as well as bare root elements, mirroring the reference
 * parser's tolerance; content after the root value is ignored. See
 * {@link PlistValue} for how each element maps to a JavaScript value, and
 * {@link parseBinaryPlist} for the binary specifics.
 *
 * XML parsing deviates from the reference implementation in one deliberate
 * way — corrupt base64 inside `<data>` raises {@link PlistParseError}, where
 * the reference implementation silently decodes to fewer bytes. Silent
 * truncation is indistinguishable from a valid shorter payload, which is
 * unacceptable for the certificates, proofs, and tokens `<data>` elements
 * typically carry.
 *
 * @param input Source of the document — XML text, or a buffer holding either
 *   binary or XML bytes.
 * @param options See {@link ParsePlistOptions}.
 * @returns The document's root value.
 * @throws PlistParseError when the document is not a well-formed property list;
 *   the error carries the failure location (line/column for XML, byte offset
 *   for binary).
 */
export function parsePlist(input: string | Uint8Array, options: ParsePlistOptions = {}): PlistValue {
  if (typeof input !== "string") {
    if (hasBinaryPlistMagic(input)) {
      return parseBinaryPlist(input, options);
    }
    let xml: string;
    try {
      xml = utf8Decoder.decode(input);
    } catch {
      // TextDecoder throws a TypeError on invalid UTF-8; surface it as the
      // library's own parse error so callers catch one type either way.
      throw new PlistParseError("input is not valid UTF-8", input, 0);
    }
    return parseXml(xml, options);
  }
  return parseXml(input, options);
}

/** Parses an XML property list string; the string path of {@link parsePlist}. */
function parseXml(xml: string, options: ParsePlistOptions): PlistValue {
  return new Parser(xml, options.maxDepth ?? DEFAULT_MAX_DEPTH).parseDocument();
}

/**
 * Single-use recursive-descent parser over one source string.
 *
 * The instance tracks one piece of state — the current offset `pos` — and
 * moves strictly forward through the input. Methods are grouped in three
 * layers, from the document/value grammar down through the markup tokenizer
 * to text content decoding.
 */
class Parser {
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
   * Parses the whole document — optional prolog, optional `<plist>` wrapper,
   * exactly one root value.
   */
  parseDocument(): PlistValue {
    if (this.src.charCodeAt(0) === 0xfeff) {
      this.pos = 1; // byte order mark
    }

    const tag = this.nextTag("a property list value");
    if (tag.name === "plist") {
      if (tag.selfClosed) {
        this.fail("<plist> is empty", tag.start);
      }
      const value = this.parseValue(this.nextTag("a property list value"), 0);
      this.expectCloseTag("plist");
      return value;
    }

    // Bare root without the <plist> wrapper. Trailing content is ignored
    // either way, so no further scanning happens after the root value.
    return this.parseValue(tag, 0);
  }

  // ------------------------------------------------------------------------
  // Values
  // ------------------------------------------------------------------------

  /**
   * Dispatches one already-read opening tag to its value parser.
   */
  private parseValue(tag: OpenTag, depth: number): PlistValue {
    switch (tag.name) {
      case "dict":
        return this.parseDict(depth + 1, tag.selfClosed);
      case "array":
        return this.parseArray(depth + 1, tag.selfClosed);
      // The reference parser treats a stray <key> outside dictionary
      // position as a string value, so <key> parses uniformly as a string.
      case "string":
      case "key":
        return tag.selfClosed ? "" : this.readText(tag.name);
      case "integer":
        return this.parseInteger(tag);
      case "real":
        return this.parseReal(tag);
      case "true":
        this.expectEmptyElement(tag);
        return true;
      case "false":
        this.expectEmptyElement(tag);
        return false;
      case "date":
        return this.parseDate(tag);
      case "data":
        return this.parseData(tag);
      default:
        this.fail(
          tag.name === "plist" ? "<plist> may only appear at the document root" : `unknown element <${tag.name}>`,
          tag.start,
        );
    }
  }

  /**
   * Parses `<dict>` content: alternating `<key>` and value elements.
   *
   * Later duplicate keys win, matching the reference parser. A literal
   * `__proto__` key is defined as an own property so untrusted documents
   * cannot pollute prototypes.
   */
  private parseDict(depth: number, selfClosed: boolean): PlistDictionary {
    this.checkDepth(depth);
    const dict: PlistDictionary = {};
    if (selfClosed) {
      return dict;
    }

    for (;;) {
      const keyTag = this.nextTagOrClose("dict", "<key> or </dict>");
      if (keyTag === null) {
        return dict;
      }
      if (keyTag.name !== "key") {
        this.fail(`expected <key> inside <dict>, found <${keyTag.name}>`, keyTag.start);
      }
      const key = keyTag.selfClosed ? "" : this.readText("key");

      const valueTag = this.nextTagOrClose("dict", `a value for key ${JSON.stringify(key)}`);
      if (valueTag === null) {
        this.fail(`value missing for key ${JSON.stringify(key)} inside <dict>`);
      }
      const value = this.parseValue(valueTag, depth);

      if (key === "__proto__") {
        Object.defineProperty(dict, key, { value, writable: true, enumerable: true, configurable: true });
      } else {
        dict[key] = value;
      }
    }
  }

  /**
   * Parses `<array>` content — a sequence of value elements.
   */
  private parseArray(depth: number, selfClosed: boolean): PlistArray {
    this.checkDepth(depth);
    const array: PlistArray = [];
    if (selfClosed) {
      return array;
    }

    for (;;) {
      const tag = this.nextTagOrClose("array", "a value or </array>");
      if (tag === null) {
        return array;
      }
      array.push(this.parseValue(tag, depth));
    }
  }

  /**
   * Parses `<integer>` content.
   *
   * Accepts decimal and `0x`-prefixed hexadecimal spellings with an optional
   * sign, enforces the 64-bit window shared with the builder, and returns a
   * `number` when the value is exactly representable, otherwise a `bigint`.
   *
   * Nearly all real-world integers are short, so spellings that `Number()`
   * converts exactly skip the bigint allocation entirely; only long
   * spellings pay for arbitrary-precision handling.
   */
  private parseInteger(tag: OpenTag): number | bigint {
    if (tag.selfClosed) {
      this.fail("<integer> is empty", tag.start);
    }
    const text = this.readRawText("integer");
    if (!INTEGER_PATTERN.test(text)) {
      this.fail(`malformed <integer> content ${JSON.stringify(text)}`, tag.start);
    }

    const first = text.charCodeAt(0);
    const negative = first === HYPHEN_MINUS;
    const unsigned = negative || first === PLUS_SIGN ? text.slice(1) : text;

    if (unsigned.length <= MAX_EXACT_NUMBER_SPELLING) {
      const magnitude = Number(unsigned); // Number() parses the 0x prefix too
      // Normalizing away -0 keeps "-0" and "0" indistinguishable, exactly as
      // they are on the bigint path.
      return negative && magnitude !== 0 ? -magnitude : magnitude;
    }

    const magnitude = BigInt(unsigned); // handles both decimal and 0x-prefixed hex
    const value = negative ? -magnitude : magnitude;

    if (value < PLIST_INTEGER_MIN || value > PLIST_INTEGER_MAX) {
      this.fail("<integer> overflows the 64-bit property list range", tag.start);
    }
    if (value >= MIN_SAFE_INTEGER_BIGINT && value <= MAX_SAFE_INTEGER_BIGINT) {
      return Number(value);
    }
    return value;
  }

  /**
   * Parses `<real>` content — decimal notation plus the reference parser's
   * `nan`/`inf`/`infinity` spellings.
   */
  private parseReal(tag: OpenTag): number {
    if (tag.selfClosed) {
      this.fail("<real> is empty", tag.start);
    }
    const text = this.readRawText("real");
    if (REAL_PATTERN.test(text)) {
      return Number(text);
    }
    if (REAL_SPECIAL_PATTERN.test(text)) {
      const lower = text.toLowerCase();
      if (lower.endsWith("nan")) {
        return NaN;
      }
      return lower.startsWith("-") ? -Infinity : Infinity;
    }
    this.fail(`malformed <real> content ${JSON.stringify(text)}`, tag.start);
  }

  /**
   * Parses `<date>` content in the second-precision UTC layout.
   */
  private parseDate(tag: OpenTag): Date {
    if (tag.selfClosed) {
      this.fail("<date> is empty", tag.start);
    }
    const text = this.readRawText("date");
    const date = parsePlistDate(text);
    if (date === null) {
      this.fail(`malformed <date> content ${JSON.stringify(text)}`, tag.start);
    }
    return date;
  }

  /**
   * Parses `<data>` content as strict base64.
   */
  private parseData(tag: OpenTag): Uint8Array {
    if (tag.selfClosed) {
      return new Uint8Array(0);
    }
    const text = this.readRawText("data");
    try {
      return decodeBase64(text);
    } catch (error) {
      this.fail(`invalid <data> content: ${error instanceof Error ? error.message : String(error)}`, tag.start);
    }
  }

  /**
   * Consumes the closing tag of an element that must have no content,
   * such as `<true>` and `<false>` written in open-close form.
   */
  private expectEmptyElement(tag: OpenTag): void {
    if (tag.selfClosed) {
      return;
    }
    if (this.readRawText(tag.name) !== "") {
      this.fail(`<${tag.name}> must be empty`, tag.start);
    }
  }

  /**
   * Fails when container nesting exceeds the configured limit, bounding
   * recursion on adversarial documents.
   */
  private checkDepth(depth: number): void {
    if (depth > this.maxDepth) {
      this.fail(`maximum nesting depth of ${this.maxDepth} exceeded`);
    }
  }

  // ------------------------------------------------------------------------
  // Tokenizer
  // ------------------------------------------------------------------------

  /**
   * Skips everything that may legally appear between elements — whitespace,
   * comments, processing instructions (including the XML declaration), and
   * a DOCTYPE. Stops at the next `<` of an element tag, at CDATA (which is
   * content, reported by the caller), or at any other content.
   */
  private skipMisc(): void {
    const src = this.src;
    for (;;) {
      let code = src.charCodeAt(this.pos);
      while (isWhitespaceCode(code)) {
        this.pos++;
        code = src.charCodeAt(this.pos);
      }
      if (code !== LESS_THAN) {
        return;
      }

      const next = src.charCodeAt(this.pos + 1);
      if (next === QUESTION_MARK) {
        const end = src.indexOf("?>", this.pos + 2);
        if (end < 0) {
          this.fail("unterminated processing instruction");
        }
        this.pos = end + 2;
        continue;
      }
      if (next !== EXCLAMATION_MARK) {
        return;
      }

      if (src.startsWith("<!--", this.pos)) {
        const end = src.indexOf("-->", this.pos + 4);
        if (end < 0) {
          this.fail("unterminated comment");
        }
        this.pos = end + 3;
        continue;
      }
      if (src.charCodeAt(this.pos + 2) === LEFT_BRACKET) {
        return; // CDATA — content, not markup to skip
      }
      this.skipDoctype();
    }
  }

  /**
   * Skips `<!DOCTYPE ...>` including a bracketed internal subset.
   *
   * The subset is never processed — plists define no entities — so skipping
   * is the entire extent of DTD support, by design.
   */
  private skipDoctype(): void {
    const src = this.src;
    const start = this.pos;
    let inSubset = false;
    for (let i = this.pos + 2; i < src.length; i++) {
      const code = src.charCodeAt(i);
      if (code === LEFT_BRACKET) {
        inSubset = true;
      } else if (code === RIGHT_BRACKET) {
        inSubset = false;
      } else if (code === GREATER_THAN && !inSubset) {
        this.pos = i + 1;
        return;
      }
    }
    this.fail("unterminated DOCTYPE", start);
  }

  /**
   * Reads the next opening tag, failing with a message built around
   * `expectation` on anything else.
   */
  private nextTag(expectation: string): OpenTag {
    this.skipMisc();
    if (this.pos >= this.src.length) {
      this.fail(`expected ${expectation}, found end of input`);
    }
    if (this.src.charCodeAt(this.pos) !== LESS_THAN || this.src.charCodeAt(this.pos + 1) === EXCLAMATION_MARK) {
      this.fail(`expected ${expectation}, found text content`);
    }
    if (this.src.charCodeAt(this.pos + 1) === SLASH) {
      this.fail(`expected ${expectation}, found a closing tag`);
    }
    return this.readOpenTag();
  }

  /**
   * Inside a container, reads the next opening tag — or consumes the
   * container's closing tag and returns null to signal its end.
   */
  private nextTagOrClose(containerName: string, expectation: string): OpenTag | null {
    this.skipMisc();
    if (this.pos >= this.src.length) {
      this.fail(`unterminated <${containerName}>`);
    }
    if (this.src.charCodeAt(this.pos) !== LESS_THAN || this.src.charCodeAt(this.pos + 1) === EXCLAMATION_MARK) {
      this.fail(`expected ${expectation}, found text content inside <${containerName}>`);
    }
    if (this.src.charCodeAt(this.pos + 1) === SLASH) {
      this.expectCloseTag(containerName);
      return null;
    }
    return this.readOpenTag();
  }

  /**
   * Consumes `</name>`, skipping whitespace and comments before it.
   *
   * The expected name is compared in place, code unit by code unit, so the
   * overwhelmingly common case — the document is well formed — reads no
   * substring. Only the mismatch error path materializes the actual name.
   */
  private expectCloseTag(name: string): void {
    this.skipMisc();
    const start = this.pos;
    const src = this.src;
    if (src.charCodeAt(this.pos) !== LESS_THAN || src.charCodeAt(this.pos + 1) !== SLASH) {
      this.fail(`expected </${name}>`);
    }
    this.pos += 2;
    for (let i = 0; i < name.length; i++) {
      if (src.charCodeAt(this.pos + i) !== name.charCodeAt(i)) {
        this.fail(`expected </${name}>, found </${this.readName()}>`, start);
      }
    }
    if (isNameCharCode(src.charCodeAt(this.pos + name.length))) {
      this.fail(`expected </${name}>, found </${this.readName()}>`, start);
    }
    this.pos += name.length;
    this.skipWhitespace();
    if (src.charCodeAt(this.pos) !== GREATER_THAN) {
      this.fail(`malformed closing tag </${name}>`, start);
    }
    this.pos++;
  }

  /**
   * Reads `<name ...>` starting at `<`.
   *
   * Attributes carry no meaning in a property list — the reference parser
   * ignores them wherever they appear — so they are validated for
   * well-formed quoting and then discarded.
   */
  private readOpenTag(): OpenTag {
    const src = this.src;
    const start = this.pos;
    this.pos++; // consume "<"
    const name = this.readTagName();

    for (;;) {
      this.skipWhitespace();
      const code = src.charCodeAt(this.pos);
      if (Number.isNaN(code)) {
        this.fail(`unterminated <${name}> tag`, start);
      }
      if (code === GREATER_THAN) {
        this.pos++;
        return { name, selfClosed: false, start };
      }
      if (code === SLASH) {
        if (src.charCodeAt(this.pos + 1) !== GREATER_THAN) {
          this.fail(`malformed <${name}> tag`, start);
        }
        this.pos += 2;
        return { name, selfClosed: true, start };
      }

      const attributeName = this.readName();
      if (attributeName === "") {
        this.fail(`malformed <${name}> tag`, start);
      }
      this.skipWhitespace();
      if (src.charCodeAt(this.pos) === EQUALS_SIGN) {
        this.pos++;
        this.skipWhitespace();
        const quote = src.charCodeAt(this.pos);
        if (quote !== DOUBLE_QUOTE && quote !== APOSTROPHE) {
          this.fail(`attribute ${attributeName} in <${name}> is missing a quoted value`, start);
        }
        const valueEnd = src.indexOf(String.fromCharCode(quote), this.pos + 1);
        if (valueEnd < 0) {
          this.fail(`unterminated attribute value in <${name}>`, start);
        }
        this.pos = valueEnd + 1;
      }
    }
  }

  /**
   * Reads an element name, returning an interned constant for the ten plist
   * element names so the hot path never allocates a substring per tag.
   *
   * The switch keys on the first code unit; `matchKnownName` verifies the
   * rest in place. Anything else — foreign markup, attributes read by the
   * caller, malformed input — falls back to {@link readName}, which
   * materializes the actual name for error messages.
   */
  private readTagName(): string {
    const src = this.src;
    const pos = this.pos;
    switch (src.charCodeAt(pos)) {
      case 0x61: // a
        return this.matchKnownName("array");
      case 0x64: // d begins dict, date, and data (they differ at the fourth character)
        if (src.charCodeAt(pos + 1) === 0x69) {
          return this.matchKnownName("dict");
        }
        return this.matchKnownName(src.charCodeAt(pos + 3) === 0x65 ? "date" : "data");
      case 0x66: // f
        return this.matchKnownName("false");
      case 0x69: // i
        return this.matchKnownName("integer");
      case 0x6b: // k
        return this.matchKnownName("key");
      case 0x70: // p
        return this.matchKnownName("plist");
      case 0x72: // r
        return this.matchKnownName("real");
      case 0x73: // s
        return this.matchKnownName("string");
      case 0x74: // t
        return this.matchKnownName("true");
      default:
        return this.readName();
    }
  }

  /**
   * Consumes `candidate` when the source spells exactly that name at the
   * current position; otherwise leaves the position untouched and falls
   * back to {@link readName}.
   */
  private matchKnownName(candidate: string): string {
    const src = this.src;
    const start = this.pos;
    for (let i = 0; i < candidate.length; i++) {
      if (src.charCodeAt(start + i) !== candidate.charCodeAt(i)) {
        return this.readName();
      }
    }
    // A longer name that merely starts with the candidate (<dictionary>)
    // must not match.
    if (isNameCharCode(src.charCodeAt(start + candidate.length))) {
      return this.readName();
    }
    this.pos = start + candidate.length;
    return candidate;
  }

  /**
   * Reads an XML name as a fresh substring. Used for attribute names and
   * error reporting; element names on the happy path go through
   * {@link readTagName} instead.
   */
  private readName(): string {
    const src = this.src;
    const start = this.pos;
    while (this.pos < src.length && isNameCharCode(src.charCodeAt(this.pos))) {
      this.pos++;
    }
    return src.slice(start, this.pos);
  }

  /** Advances past XML whitespace without interpreting anything else. */
  private skipWhitespace(): void {
    const src = this.src;
    while (isWhitespaceCode(src.charCodeAt(this.pos))) {
      this.pos++;
    }
  }

  // ------------------------------------------------------------------------
  // Text content
  // ------------------------------------------------------------------------

  /**
   * Reads text content up to `</closeName>`, decoding entity and character
   * references and inlining CDATA sections. Used for `<string>` and `<key>`,
   * whose content is preserved exactly — including whitespace.
   */
  private readText(closeName: string): string {
    const src = this.src;
    let out = "";

    for (;;) {
      const lt = src.indexOf("<", this.pos);
      if (lt < 0) {
        this.fail(`unterminated <${closeName}>`);
      }
      if (lt > this.pos) {
        out += this.decodeTextRange(this.pos, lt);
        this.pos = lt;
      }

      if (src.charCodeAt(lt + 1) === SLASH) {
        this.expectCloseTag(closeName);
        return out;
      }
      if (src.startsWith("<![CDATA[", lt)) {
        const end = src.indexOf("]]>", lt + 9);
        if (end < 0) {
          this.fail("unterminated CDATA section", lt);
        }
        out += src.slice(lt + 9, end);
        this.pos = end + 3;
        continue;
      }
      this.fail(`unexpected markup inside <${closeName}>`, lt);
    }
  }

  /**
   * Reads literal text — no references, no CDATA — up to `</closeName>`.
   * Used for `<integer>`, `<real>`, `<date>`, and `<data>`, whose grammars
   * contain no XML-significant characters.
   */
  private readRawText(closeName: string): string {
    const src = this.src;
    const lt = src.indexOf("<", this.pos);
    if (lt < 0) {
      this.fail(`unterminated <${closeName}>`);
    }
    const text = src.slice(this.pos, lt);
    this.pos = lt;
    if (src.charCodeAt(lt + 1) !== SLASH) {
      this.fail(`unexpected markup inside <${closeName}>`, lt);
    }
    this.expectCloseTag(closeName);
    return text;
  }

  /**
   * Decodes `src[start, end)`, resolving `&...;` references.
   *
   * The overwhelmingly common case — text with no ampersand at all — is a
   * single slice; reference resolution only runs when one is present.
   */
  private decodeTextRange(start: number, end: number): string {
    const src = this.src;
    let amp = src.indexOf("&", start);
    if (amp < 0 || amp >= end) {
      return src.slice(start, end);
    }

    let out = "";
    let cursor = start;
    while (amp >= 0 && amp < end) {
      out += src.slice(cursor, amp);
      const semi = src.indexOf(";", amp + 1);
      if (semi < 0 || semi >= end) {
        this.fail("unterminated reference", amp);
      }
      out += this.resolveReference(src.slice(amp + 1, semi), amp);
      cursor = semi + 1;
      amp = src.indexOf("&", cursor);
    }
    return out + src.slice(cursor, end);
  }

  /**
   * Resolves one reference body (the text between `&` and `;`).
   *
   * Supports the five XML predefined entities and decimal or hexadecimal
   * character references. There is nothing else to support, because plist
   * documents cannot define entities when the DOCTYPE is never processed.
   */
  private resolveReference(body: string, offset: number): string {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }

    if (body.charCodeAt(0) === HASH) {
      const second = body.charCodeAt(1);
      const isHex = second === LOWERCASE_X || second === UPPERCASE_X;
      const digits = body.slice(isHex ? 2 : 1);
      if (digits.length === 0 || !(isHex ? HEX_DIGITS_PATTERN : DECIMAL_DIGITS_PATTERN).test(digits)) {
        this.fail(`malformed character reference &${body};`, offset);
      }
      const radix = isHex ? 16 : 10;
      const codePoint = parseInt(digits, radix);
      if (codePoint > MAX_CODE_POINT || (codePoint >= HIGH_SURROGATE_START && codePoint <= LOW_SURROGATE_END)) {
        this.fail(`character reference &${body}; is not a Unicode scalar value`, offset);
      }
      return String.fromCodePoint(codePoint);
    }

    this.fail(`unknown entity &${body};`, offset);
  }

  /**
   * Throws a {@link PlistParseError} anchored at `offset` (the current
   * position by default).
   */
  private fail(message: string, offset = this.pos): never {
    throw new PlistParseError(message, this.src, Math.min(offset, this.src.length));
  }
}
