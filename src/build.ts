/**
 * XML property list serialization.
 *
 * The builder emits the reference writer's document layout — XML
 * declaration, DOCTYPE, `<plist version="1.0">` wrapper, root element at
 * column zero, one indentation unit per nesting level — so generated
 * documents diff cleanly against Apple tool output. Empty-element forms
 * follow what the reference parser accepts, which is not uniform across
 * elements: `<dict/>` and `<array/>` are fine, but empty data must be
 * written open-close because the reference parser rejects `<data/>`.
 *
 * Serialization is strict where silence would hide bugs: values with no
 * property list representation raise {@link PlistBuildError} carrying the
 * path of the offending value instead of being skipped or coerced.
 *
 * @module
 */

import { encodeBase64 } from "./base64";
import { PlistBuildError } from "./errors";
import {
  AMPERSAND,
  CARRIAGE_RETURN,
  GREATER_THAN,
  HIGH_SURROGATE_END,
  HIGH_SURROGATE_START,
  LESS_THAN,
  LINE_FEED,
  LOW_SURROGATE_END,
  LOW_SURROGATE_START,
  SPACE,
  TAB,
} from "./internal/character-codes";
import { PLIST_INTEGER_MAX, PLIST_INTEGER_MIN } from "./internal/integer-range";
import type { PlistValue } from "./types";

/**
 * Options accepted by {@link buildPlist}.
 */
export interface BuildPlistOptions {
  /**
   * Indentation unit, or `false` for a single-line body.
   *
   * The default is a tab, the unit Apple tooling emits. Single-line output
   * is useful for network payloads where the document is never read by a
   * person and the whitespace is pure overhead.
   */
  indent?: string | false;
}

/**
 * The document prolog every emitted plist starts with: the XML declaration
 * and the PropertyList-1.0 DOCTYPE, exactly as the reference writer emits
 * them.
 */
const XML_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';

/**
 * Serializes a value as a complete XML property list document.
 *
 * The output includes the XML declaration, the PropertyList-1.0 DOCTYPE,
 * and the `<plist version="1.0">` wrapper. See {@link PlistValue} for the
 * value mapping and {@link BuildPlistOptions} for layout control.
 *
 * @param value The root value to serialize.
 * @param options See {@link BuildPlistOptions}.
 * @returns The document text, terminated by a newline.
 * @throws PlistBuildError when a value has no property list representation:
 *   `null`, `undefined`, functions, symbols, class instances, `NaN`,
 *   infinities, out-of-range bigints, invalid dates, lone surrogates, or
 *   characters XML 1.0 cannot carry. The error names the path of the
 *   offending value, e.g. `$.profiles[2].name`.
 */
export function buildPlist(value: PlistValue, options: BuildPlistOptions = {}): string {
  const indent = options.indent ?? "\t";
  const builder = new Builder(indent === false ? null : indent);
  builder.appendValue(value, "$", 0);
  if (indent === false) {
    return `${XML_HEADER}<plist version="1.0">${builder.out}</plist>\n`;
  }
  return `${XML_HEADER}<plist version="1.0">\n${builder.out}</plist>\n`;
}

/**
 * Single-use serializer accumulating output into {@link out}.
 *
 * Output grows through string concatenation, which modern engines optimize
 * with rope-like representations; the profile-shaped benchmark showed no
 * benefit from array-join batching.
 */
class Builder {
  /** The document body accumulated so far, without header or wrapper. */
  out = "";

  /**
   * Indentation strings by depth, built once per depth instead of calling
   * `repeat` on every line — documents emit many lines at few depths.
   */
  private readonly indentByDepth: string[] = [];

  /**
   * @param indent Indentation unit for pretty output, or null for a
   *   single-line body.
   */
  constructor(private readonly indent: string | null) {}

  /**
   * Serializes one value, dispatching on its runtime type.
   *
   * The parameter deliberately admits `null` and `undefined` even though
   * {@link PlistValue} excludes them: loosely typed callers can smuggle both
   * past the public signature, and dictionary iteration reads properties the
   * compiler cannot verify. Accepting the unsafe shapes here and rejecting
   * them with path context keeps every call site free of casts and non-null
   * assertions while preserving the loud failure.
   *
   * @param value Value to serialize.
   * @param path Path from the root for error reporting, e.g. `$.items[3]`.
   * @param depth Container nesting depth; controls indentation only.
   */
  appendValue(value: PlistValue | null | undefined, path: string, depth: number): void {
    if (value === null) {
      throw new PlistBuildError("null has no property list representation", path);
    }
    switch (typeof value) {
      case "string":
        this.appendLine(depth, `<string>${escapeText(value, path)}</string>`);
        return;
      case "number":
        this.appendNumber(value, path, depth);
        return;
      case "bigint":
        if (value < PLIST_INTEGER_MIN || value > PLIST_INTEGER_MAX) {
          throw new PlistBuildError(`bigint ${value} overflows the 64-bit <integer> range`, path);
        }
        this.appendLine(depth, `<integer>${value}</integer>`);
        return;
      case "boolean":
        this.appendLine(depth, value ? "<true/>" : "<false/>");
        return;
      case "object":
        this.appendObject(value, path, depth);
        return;
      default:
        throw new PlistBuildError(`${typeof value} values have no property list representation`, path);
    }
  }

  /**
   * Serializes a `number` as `<integer>` when integral, `<real>` otherwise.
   *
   * `NaN` and infinities are rejected: the XML format has spellings for
   * them, but emitting one is almost always a caller bug in the protocols
   * this library serves, so the builder fails loudly instead of
   * round-tripping an accident.
   */
  private appendNumber(value: number, path: string, depth: number): void {
    if (Number.isInteger(value)) {
      // Negative zero normalizes to zero; the two are indistinguishable
      // after a parse round trip anyway.
      this.appendLine(depth, `<integer>${value === 0 ? 0 : value}</integer>`);
      return;
    }
    if (!Number.isFinite(value)) {
      throw new PlistBuildError(`${value} cannot be written to a property list`, path);
    }
    this.appendLine(depth, `<real>${value}</real>`);
  }

  /**
   * Serializes object-typed values: dates, binary data, arrays, and
   * dictionaries. Anything else object-shaped (class instances, Maps,
   * Sets) has no property list representation and is rejected.
   */
  private appendObject(value: object & PlistValue, path: string, depth: number): void {
    if (value instanceof Date) {
      this.appendDate(value, path, depth);
      return;
    }

    if (ArrayBuffer.isView(value)) {
      this.appendData(value, depth);
      return;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        this.appendLine(depth, "<array/>");
        return;
      }
      this.appendLine(depth, "<array>");
      let index = 0;
      for (const element of value) {
        this.appendValue(element, `${path}[${index}]`, depth + 1);
        index++;
      }
      this.appendLine(depth, "</array>");
      return;
    }

    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new PlistBuildError("class instances have no property list representation", path);
    }

    // Reading through an index signature yields `PlistValue | undefined`
    // under noUncheckedIndexedAccess; appendValue accepts exactly that shape
    // and turns a runtime undefined into a path-carrying error.
    const record: Record<string, PlistValue | undefined> = value;
    const keys = Object.keys(record);
    if (keys.length === 0) {
      this.appendLine(depth, "<dict/>");
      return;
    }
    this.appendLine(depth, "<dict>");
    for (const key of keys) {
      this.appendLine(depth + 1, `<key>${escapeText(key, path)}</key>`);
      this.appendValue(record[key], `${path}.${key}`, depth + 1);
    }
    this.appendLine(depth, "</dict>");
  }

  /**
   * Serializes a `Date` as a `<date>` element.
   *
   * The wire layout carries second precision; sub-second time is truncated
   * rather than rounded so timestamps never move forward.
   */
  private appendDate(value: Date, path: string, depth: number): void {
    const time = value.getTime();
    if (Number.isNaN(time)) {
      throw new PlistBuildError("invalid Date cannot be written to a property list", path);
    }
    const alignedTime = Math.floor(time / 1000) * 1000;
    const iso = (alignedTime === time ? value : new Date(alignedTime)).toISOString();
    this.appendLine(depth, `<date>${iso.slice(0, 19)}Z</date>`);
  }

  /**
   * Serializes an `ArrayBufferView` as a `<data>` element.
   *
   * Encodes exactly the view's window, never its whole backing buffer, so
   * subarray views into larger protocol buffers serialize correctly. The
   * open-close form for empty data is load-bearing: the reference parser
   * accepts `<data></data>` but rejects `<data/>`.
   */
  private appendData(value: ArrayBufferView, depth: number): void {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.appendLine(depth, `<data>${encodeBase64(bytes)}</data>`);
  }

  /**
   * Appends one element line at the given depth — or raw text when
   * single-line output was requested.
   */
  private appendLine(depth: number, text: string): void {
    if (this.indent === null) {
      this.out += text;
      return;
    }
    this.out += this.indentation(this.indent, depth) + text + "\n";
  }

  /**
   * Returns the indentation string for a depth, building and caching it on
   * first use so repeated lines at the same depth share one string.
   *
   * The unit is passed by the caller rather than read from the field so the
   * narrowed non-null type flows in without re-checking.
   */
  private indentation(indent: string, depth: number): string {
    const cached = this.indentByDepth[depth];
    if (cached !== undefined) {
      return cached;
    }
    const value = indent.repeat(depth);
    this.indentByDepth[depth] = value;
    return value;
  }
}

/**
 * Matches every code unit the escape loop has to inspect: characters that
 * need replacing (`&`, `<`, `>`, carriage return), characters that must be
 * rejected (C0 controls other than tab and line feed), and surrogates.
 *
 * With the `u` flag a well-paired surrogate matches as one supplementary
 * code point outside this class, so text whose non-ASCII content is fully
 * paired (emoji, CJK) stays on the fast path while lone surrogates still
 * drop into the loop and are rejected there.
 */
// oxlint-disable-next-line no-control-regex -- detecting control characters is this pattern's purpose
const NEEDS_ESCAPING_PATTERN = /[&<>\r\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF]/u;

/**
 * Escapes text for `<string>` and `<key>` element content.
 *
 * `&` and `<` must be escaped per XML; `>` is escaped as well so the
 * sequence `]]>` can never appear literally. A carriage return is written
 * as `&#13;` because a literal one would be folded into a line feed by XML
 * line-ending normalization in standard parsers — the reference form is the
 * one that survives every round trip.
 *
 * Characters outside the XML 1.0 character range (C0 controls other than
 * tab, line feed, and carriage return) and lone surrogates cannot be
 * represented in a well-formed document at all, so they are rejected.
 *
 * Most protocol strings need no work at all, so one native regex scan
 * decides whether the character-by-character loop runs.
 */
function escapeText(text: string, path: string): string {
  if (!NEEDS_ESCAPING_PATTERN.test(text)) {
    return text;
  }
  return escapeTextSlow(text, path);
}

/**
 * The escape loop behind {@link escapeText}, entered only when the scan
 * found something to replace or reject.
 */
function escapeTextSlow(text: string, path: string): string {
  let out = "";
  let plainStart = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    let replacement: string | null = null;
    if (code === AMPERSAND) {
      replacement = "&amp;";
    } else if (code === LESS_THAN) {
      replacement = "&lt;";
    } else if (code === GREATER_THAN) {
      replacement = "&gt;";
    } else if (code === CARRIAGE_RETURN) {
      replacement = "&#13;";
    } else if (code < SPACE && code !== TAB && code !== LINE_FEED) {
      throw new PlistBuildError(
        `control character U+${code.toString(16).toUpperCase().padStart(4, "0")} is not representable in XML`,
        path,
      );
    } else if (code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END) {
      const low = text.charCodeAt(i + 1);
      if (Number.isNaN(low) || low < LOW_SURROGATE_START || low > LOW_SURROGATE_END) {
        throw new PlistBuildError("lone surrogate is not representable in XML", path);
      }
      i++; // valid pair; both code units pass through untouched
    } else if (code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END) {
      throw new PlistBuildError("lone surrogate is not representable in XML", path);
    }

    if (replacement !== null) {
      out += text.slice(plainStart, i) + replacement;
      plainStart = i + 1;
    }
  }

  return plainStart === 0 ? text : out + text.slice(plainStart);
}
