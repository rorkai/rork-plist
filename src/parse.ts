/**
 * Property list parsing entry points and format dispatch.
 *
 * {@link parsePlist} is the generic entry. It routes a buffer to the binary
 * parser (see {@link "./parse-binary"}) or decodes it as text — UTF-8, or
 * UTF-16 when a byte order mark says so, the same encoding selection the
 * reference parser applies — and text dispatches between the XML grammar
 * (see {@link "./parse-xml"}) and the OpenStep grammar (see
 * {@link "./parse-openstep"}). {@link detectPlistFormat} exposes the same
 * classification without parsing, and {@link parsePlistDictionary} wraps the
 * generic entry for the dictionary-rooted documents most callers read.
 *
 * @module
 */

import { PlistParseError } from "./errors";
import { DIGIT_NINE, DIGIT_ZERO, GREATER_THAN, isWhitespaceCode, LESS_THAN } from "./internal/character-codes";
import { hasBinaryPlistMagic, parseBinaryPlist } from "./parse-binary";
import { parseOpenStepPlist } from "./parse-openstep";
import type { ParsePlistOptions } from "./parse-options";
import { parseXmlPlist } from "./parse-xml";
import { isPlistDictionary, type PlistDictionary, type PlistFormat, type PlistValue } from "./types";

export type { ParsePlistOptions } from "./parse-options";

/**
 * Decodes UTF-8 bytes to a string for the text path of {@link parsePlist}.
 * `fatal` makes malformed byte sequences throw instead of decoding to the
 * replacement character, so a corrupt buffer fails loudly rather than parsing
 * into silently mangled string values.
 */
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Decodes a non-binary plist buffer to text, selecting the encoding the way
 * the reference parser does — by byte order mark alone. `FF FE` decodes as
 * UTF-16 little-endian and `FE FF` as UTF-16 big-endian; everything else
 * decodes as UTF-8. The XML declaration's `encoding` attribute is ignored,
 * and BOM-less UTF-16 is rejected, both verified against the platform
 * tooling, which behaves the same way.
 */
function decodeTextBytes(input: Uint8Array): string {
  if (input.length >= 2) {
    if (input[0] === 0xff && input[1] === 0xfe) {
      return decodeUtf16(input, true);
    }
    if (input[0] === 0xfe && input[1] === 0xff) {
      return decodeUtf16(input, false);
    }
  }
  try {
    return utf8Decoder.decode(input);
  } catch {
    // TextDecoder throws a TypeError on invalid UTF-8; surface it as the
    // library's own parse error so callers catch one type either way.
    throw new PlistParseError("input is not valid UTF-8", input, 0);
  }
}

/**
 * Decodes UTF-16 text following its two-byte byte order mark. The decoder is
 * hand-rolled rather than a `TextDecoder` because the UTF-16 labels are not
 * required to exist in every runtime this library supports; code units pass
 * through to the JS string (itself UTF-16) unchanged.
 *
 * @param input The whole buffer, including the byte order mark.
 * @param littleEndian Unit byte order, as announced by the mark.
 */
function decodeUtf16(input: Uint8Array, littleEndian: boolean): string {
  const byteLength = input.byteLength - 2;
  if (byteLength % 2 !== 0) {
    throw new PlistParseError("UTF-16 input ends in a half code unit", input, input.byteLength - 1);
  }
  const view = new DataView(input.buffer, input.byteOffset + 2, byteLength);
  const unitCount = byteLength / 2;
  const units: number[] = [];
  let out = "";
  for (let i = 0; i < unitCount; i++) {
    units.push(view.getUint16(i * 2, littleEndian));
    // Flushing in chunks keeps the argument list small enough to spread while
    // avoiding a per-unit string concatenation on megabyte documents.
    if (units.length === 4096) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  if (units.length > 0) {
    out += String.fromCharCode(...units);
  }
  return out;
}

/**
 * Parses a property list into JavaScript values.
 *
 * Accepts every format the platform reads. A `Uint8Array` is parsed as
 * binary (`bplist00`) when it carries the binary magic, and otherwise
 * decoded as text — UTF-8, or UTF-16 when a byte order mark announces it. A
 * `string`, or decoded text, parses as XML when its first significant
 * character is `<` and as OpenStep otherwise (see
 * {@link parseOpenStepPlist}), so a caller holding raw bytes (a file read,
 * an HTTP body) can pass them through without sniffing the format or
 * encoding first.
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
    return parseText(decodeTextBytes(input), options);
  }
  return parseText(input, options);
}

/**
 * Dispatches decoded text between the XML and OpenStep grammars.
 *
 * XML markup must begin with `<`, so text whose first significant character
 * is anything else is OpenStep. Text that does begin with `<` parses as XML,
 * with one verified exception mirroring the reference parser: when XML
 * parsing fails and the character after `<` could open a root-level OpenStep
 * data literal (a hex digit, whitespace, or `>`), the OpenStep reading is
 * tried before the XML error surfaces — `<dada>` is four data bytes to the
 * platform tooling, not markup. When both grammars reject such input, the
 * XML error is the one reported, since markup-shaped input almost always
 * means XML was intended.
 */
function parseText(text: string, options: ParsePlistOptions): PlistValue {
  const sniff = significantOffset(text);
  if (text.charCodeAt(sniff) !== LESS_THAN) {
    return parseOpenStepPlist(text, options);
  }

  try {
    return parseXmlPlist(text, options);
  } catch (xmlError) {
    const next = text.charCodeAt(sniff + 1);
    const isHexDigit =
      (next >= DIGIT_ZERO && next <= DIGIT_NINE) ||
      (next >= 0x61 && next <= 0x66) || // a-f
      (next >= 0x41 && next <= 0x46); // A-F
    if (isHexDigit || isWhitespaceCode(next) || next === GREATER_THAN) {
      try {
        return parseOpenStepPlist(text, options);
      } catch {
        throw xmlError;
      }
    }
    throw xmlError;
  }
}

/**
 * Finds the offset of the first significant character, past an optional
 * byte order mark and leading whitespace. That character decides the text
 * grammar, so {@link parseText} and {@link detectPlistFormat} both read it
 * from here and cannot disagree.
 */
function significantOffset(text: string): number {
  let offset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (offset < text.length && isWhitespaceCode(text.charCodeAt(offset))) {
    offset++;
  }
  return offset;
}

/**
 * Reports the format {@link parsePlist} would read `input` as, without
 * parsing it.
 *
 * A buffer carrying the `bplist00` magic is `"binary"`. Anything else is
 * decoded as text the way {@link parsePlist} decodes it — UTF-8, or UTF-16
 * when a byte order mark announces it — and classifies as `"xml"` when the
 * first significant character is `<` and `"openstep"` otherwise.
 *
 * The intended use is rewriting a document while preserving its on-disk
 * format. Detect the format, parse, modify, and hand the value to the
 * matching builder, so a binary document does not silently come back as XML.
 *
 * Detection reads only the leading bytes, so it cannot see the one deep
 * dispatch case {@link parsePlist} resolves by parsing: markup-shaped text
 * that fails as XML but reads as an OpenStep root data literal, such as
 * `<0fbd77>`, reports `"xml"` here. Such documents are data-rooted, so this
 * does not affect the rewrite pattern above, which operates on
 * dictionary-rooted files.
 *
 * @param input Document text, or a buffer holding any plist format.
 * @returns The classification of `input`.
 * @throws PlistParseError when a buffer is neither binary nor decodable
 *   text, the same error {@link parsePlist} raises for such input.
 */
export function detectPlistFormat(input: string | Uint8Array): PlistFormat {
  if (typeof input !== "string") {
    if (hasBinaryPlistMagic(input)) {
      return "binary";
    }
    return detectTextFormat(decodeTextBytes(input));
  }
  return detectTextFormat(input);
}

/** The text path of {@link detectPlistFormat}. */
function detectTextFormat(text: string): PlistFormat {
  return text.charCodeAt(significantOffset(text)) === LESS_THAN ? "xml" : "openstep";
}

/**
 * Parses a property list and requires the root to be a dictionary.
 *
 * Most documents this library meets in practice — app metadata, exported
 * settings, entitlements, provisioning payloads — are dictionary-rooted by
 * contract, and every consumer of {@link parsePlist} otherwise repeats the
 * same narrowing before touching keys. This entry point returns the typed
 * dictionary directly and accepts the same inputs and options as
 * {@link parsePlist}.
 *
 * @param input Source of the document — text, or a buffer holding any plist
 *   format.
 * @param options See {@link ParsePlistOptions}.
 * @returns The document's root dictionary.
 * @throws PlistParseError when the document is malformed, and also when it
 *   is well formed but its root is any other shape, including a
 *   keyed-archive UID, which parses as {@link PlistUid} rather than as the
 *   one-key dictionary that encodes it.
 */
export function parsePlistDictionary(input: string | Uint8Array, options: ParsePlistOptions = {}): PlistDictionary {
  const value = parsePlist(input, options);
  if (!isPlistDictionary(value)) {
    throw new PlistParseError("the document root is not a dictionary", input, 0);
  }
  return value;
}
