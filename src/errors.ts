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
 * Location of a parse failure inside the source text.
 *
 * Offsets count UTF-16 code units from the start of the string (the same
 * units `String.prototype.slice` uses), so editors and log tooling can jump
 * straight to the failure.
 */
export interface PlistErrorPosition {
  /** Zero-based character offset into the source string. */
  offset: number;

  /** One-based line number. */
  line: number;

  /** One-based column number, in characters from the start of the line. */
  column: number;
}

/**
 * Converts a character offset into a one-based line and column pair.
 *
 * Runs only when an error is actually thrown, so parsing never pays for line
 * tracking on the happy path.
 */
function positionAt(source: string, offset: number): PlistErrorPosition {
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
  /** Where in the source text parsing failed. */
  readonly position: PlistErrorPosition;

  /**
   * @param message Failure description without location; the line and column
   *   are appended automatically.
   * @param source Full source text, used to compute the position.
   * @param offset Character offset of the failure inside `source`.
   */
  constructor(message: string, source: string, offset: number) {
    const position = positionAt(source, offset);
    super(`${message} (line ${position.line}, column ${position.column})`);
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
