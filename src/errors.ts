/**
 * Error types raised by this library.
 *
 * Both error classes are exported so callers can distinguish "the document is
 * malformed" ({@link PlistParseError}) from "this value cannot be written"
 * ({@link PlistBuildError}) and report precise context for each.
 *
 * @module
 */

import { LINE_FEED } from "./internal/character-codes";

/**
 * Location of a parse failure.
 *
 * For XML input, offsets count UTF-16 code units from the start of the string
 * (the same units `String.prototype.slice` uses) and `line`/`column` locate
 * the failure in the text. For binary input there is no text, so `offset` is
 * the byte offset into the buffer and `line`/`column` are both 1.
 */
export interface PlistErrorPosition {
  /** Zero-based character offset (XML) or byte offset (binary). */
  offset: number;

  /** One-based line number; always 1 for binary input. */
  line: number;

  /** One-based column number; always 1 for binary input. */
  column: number;
}

/**
 * Converts a source offset into a position.
 *
 * Runs only when an error is actually thrown, so parsing never pays for line
 * tracking on the happy path. A non-string source is binary input, which has
 * no lines: the byte offset is reported as `offset` with `line`/`column` at 1.
 */
function positionAt(source: string | Uint8Array, offset: number): PlistErrorPosition {
  if (typeof source !== "string") {
    return { offset, line: 1, column: 1 };
  }
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === LINE_FEED) {
      line++;
      lineStart = i + 1;
    }
  }
  return { offset, line, column: offset - lineStart + 1 };
}

/**
 * Thrown when the source text is not a well-formed property list.
 *
 * The message always embeds the line and column of the failure, and the same
 * information is available in structured form on {@link position} for
 * programmatic use.
 */
export class PlistParseError extends Error {
  /** Where in the source parsing failed. */
  readonly position: PlistErrorPosition;

  /**
   * @param message Failure description without location; the location is
   *   appended automatically.
   * @param source Full source, used to compute the position — the XML string
   *   or the binary buffer.
   * @param offset Character offset (XML) or byte offset (binary) of the
   *   failure inside `source`.
   */
  constructor(message: string, source: string | Uint8Array, offset: number) {
    const position = positionAt(source, offset);
    const location =
      typeof source === "string" ? `line ${position.line}, column ${position.column}` : `byte ${position.offset}`;
    super(`${message} (${location})`);
    this.name = "PlistParseError";
    this.position = position;
  }
}

/**
 * Thrown when a value cannot be represented in a property list.
 *
 * Raised for `null`, `undefined`, functions, symbols, class instances,
 * non-finite numbers, out-of-range bigints, invalid dates, lone surrogates,
 * and characters XML 1.0 cannot carry. The {@link path} pinpoints the
 * offending value inside the input, which matters when serializing large
 * nested payloads.
 */
export class PlistBuildError extends Error {
  /** Path to the offending value from the root, e.g. `$.profiles[2].name`. */
  readonly path: string;

  /**
   * @param message Failure description without location; the value path is
   *   appended automatically.
   * @param path Path to the offending value from the root, `$`.
   */
  constructor(message: string, path: string) {
    super(`${message} (at ${path})`);
    this.name = "PlistBuildError";
    this.path = path;
  }
}
