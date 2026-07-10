/**
 * OpenStep (NeXTSTEP) text property list serialization.
 *
 * The platform tooling reads OpenStep but cannot write it, so unlike the XML
 * and binary writers there is no reference output to mirror. Correctness is
 * defined by acceptance instead: every document this module emits parses to
 * the same values through both {@link "./parse-openstep"} and the platform
 * parser, which the test suite verifies value by value through plutil.
 *
 * The format is untyped — its leaves are strings and hex data — so the
 * writer accepts exactly that value model and rejects everything else
 * loudly. Serializing a number, boolean, or date as a string is a decision
 * about representation that belongs to the caller; doing it silently would
 * make `parse(build(value))` disagree with `value` in shape, the kind of
 * quiet corruption this library exists to refuse.
 *
 * Strings are written bare when every character is in the bare-token
 * alphabet and the token cannot be misread as a comment opener; anything
 * else is double-quoted, with C escapes for the characters the grammar
 * cannot carry literally and `\U` escapes for lone surrogates. Data is
 * written as hex in the four-byte groups OpenStep documents conventionally
 * use.
 *
 * @module
 */

import { PlistBuildError } from "./errors";
import { isOpenStepBareCode } from "./parse-openstep";
import { PlistUid, type PlistDictionary, type PlistValue } from "./types";

/**
 * The 256 two-digit lowercase hex spellings, indexed by byte value. Data
 * payloads can reach hundreds of kilobytes, and formatting each byte through
 * `toString(16)` plus padding measured as the dominant cost of data-heavy
 * builds; a table lookup per byte removes both allocations.
 */
const HEX_PAIRS = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

/**
 * Options accepted by {@link buildOpenStepPlist}.
 */
export interface BuildOpenStepPlistOptions {
  /**
   * Indentation unit, or `false` for a single-line body.
   *
   * The default is a tab, matching the layout Xcode project files use.
   */
  indent?: string | false;
}

/**
 * Serializes a value as an OpenStep (NeXTSTEP) text property list.
 *
 * The format is untyped, so only the value model it can represent is
 * accepted, meaning strings, `Uint8Array` data, arrays, and plain-object
 * dictionaries. Numbers, bigints, booleans, and dates are rejected with the
 * offending value's path rather than silently stringified, so convert them
 * deliberately before building. A dictionary key whose value is `undefined`
 * is omitted, matching the XML and binary builders.
 *
 * The platform tooling has no OpenStep writer, so output cannot be diffed
 * against a reference layout. Instead, every emitted document is verified
 * to parse identically through this library and the platform parser.
 *
 * @param value The root value to serialize.
 * @param options See {@link BuildOpenStepPlistOptions}.
 * @returns The document text, terminated by a newline.
 * @throws PlistBuildError, naming the offending value's path, when a value
 *   has no OpenStep representation. That covers numbers, bigints, booleans,
 *   dates, UIDs, `null`, `undefined` outside a dictionary value, functions,
 *   symbols, class instances, and circular references.
 */
export function buildOpenStepPlist(value: PlistValue, options: BuildOpenStepPlistOptions = {}): string {
  const indent = options.indent ?? "\t";
  const builder = new OpenStepBuilder(indent === false ? null : indent);
  builder.appendValue(value, "$", 0);
  return `${builder.out}\n`;
}

/**
 * Single-use serializer accumulating output into {@link out}, mirroring the
 * XML builder's shape.
 */
class OpenStepBuilder {
  /** The document text accumulated so far. */
  out = "";

  /** Containers currently on the serialization path, for cycle detection. */
  private readonly onPath = new WeakSet<object>();

  /**
   * Indentation strings by depth, built once per depth instead of calling
   * `repeat` on every line.
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
   * The parameter admits `null` and `undefined` for the same reason the XML
   * builder's does: loosely typed callers can smuggle both past the public
   * signature, and both must fail here with path context.
   *
   * @param value Value to serialize.
   * @param path Path from the root for error reporting.
   * @param depth Container nesting depth; controls indentation only.
   */
  appendValue(value: PlistValue | null | undefined, path: string, depth: number): void {
    if (value == null) {
      throw new PlistBuildError(`${value} has no OpenStep representation`, path);
    }
    if (typeof value === "string") {
      this.out += encodeString(value);
      return;
    }
    if (typeof value !== "object") {
      // The remaining primitives are exactly the typed values OpenStep
      // lacks: numbers, bigints, booleans, and the value-less types.
      throw new PlistBuildError(
        `${typeof value} values have no OpenStep representation, serialize the value as a string first`,
        path,
      );
    }
    if (ArrayBuffer.isView(value)) {
      this.appendData(value);
      return;
    }
    if (Array.isArray(value)) {
      this.appendArray(value, path, depth);
      return;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      if (value instanceof Date) {
        throw new PlistBuildError("dates have no OpenStep representation, serialize the date as a string first", path);
      }
      if (value instanceof PlistUid) {
        throw new PlistBuildError("UIDs have no OpenStep representation", path);
      }
      throw new PlistBuildError("class instances have no OpenStep representation", path);
    }
    this.appendDict(value as PlistDictionary, path, depth);
  }

  /** Serializes a `<hex>` data literal in four-byte groups. */
  private appendData(view: ArrayBufferView): void {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    let out = "<";
    for (let i = 0; i < bytes.length; i++) {
      if (i > 0 && i % 4 === 0) {
        out += " ";
      }
      out += HEX_PAIRS[bytes[i]!]!;
    }
    this.out += `${out}>`;
  }

  /**
   * Serializes an array — one element per line when indenting, `(a, b)` on
   * one line otherwise.
   */
  private appendArray(value: readonly PlistValue[], path: string, depth: number): void {
    if (value.length === 0) {
      this.out += "()";
      return;
    }
    this.enterContainer(value, path);
    this.out += "(";
    for (let i = 0; i < value.length; i++) {
      if (value[i] === undefined) {
        throw new PlistBuildError("undefined has no OpenStep representation", `${path}[${i}]`);
      }
      if (this.indent === null) {
        this.out += i === 0 ? "" : " ";
      } else {
        this.out += `\n${this.indentation(depth + 1)}`;
      }
      this.appendValue(value[i], `${path}[${i}]`, depth + 1);
      if (i < value.length - 1) {
        this.out += ",";
      }
    }
    this.out += this.indent === null ? ")" : `\n${this.indentation(depth)})`;
    this.onPath.delete(value);
  }

  /**
   * Serializes a dictionary — one `key = value;` entry per line when
   * indenting, `{ a = x; b = y; }` on one line otherwise. A key whose value
   * is `undefined` is omitted, matching the other builders.
   */
  private appendDict(value: PlistDictionary, path: string, depth: number): void {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined);
    if (keys.length === 0) {
      this.out += "{}";
      return;
    }
    this.enterContainer(value, path);
    this.out += "{";
    for (const key of keys) {
      this.out += this.indent === null ? " " : `\n${this.indentation(depth + 1)}`;
      this.out += `${encodeString(key)} = `;
      this.appendValue(value[key], `${path}.${key}`, depth + 1);
      this.out += ";";
    }
    this.out += this.indent === null ? " }" : `\n${this.indentation(depth)}}`;
    this.onPath.delete(value);
  }

  /**
   * Adds a container to the active path, rejecting a value already on it — a
   * circular reference that would otherwise recurse forever.
   */
  private enterContainer(value: object, path: string): void {
    if (this.onPath.has(value)) {
      throw new PlistBuildError("circular reference has no property list representation", path);
    }
    this.onPath.add(value);
  }

  /** Returns the cached indentation string for `depth`. */
  private indentation(depth: number): string {
    let cached = this.indentByDepth[depth];
    if (cached === undefined) {
      cached = (this.indent ?? "").repeat(depth);
      this.indentByDepth[depth] = cached;
    }
    return cached;
  }
}

/**
 * Serializes one string, bare when the grammar reads it back verbatim and
 * double-quoted otherwise.
 *
 * A token qualifies as bare when it is non-empty, every character is in the
 * bare alphabet, and it cannot be misread as a comment — a token may contain
 * `//` (the platform parser keeps scanning mid-token) but must not start
 * with one, and `/*` never appears bare because the platform parser rejects
 * it even mid-token.
 */
function encodeString(value: string): string {
  if (isBareSafe(value)) {
    return value;
  }

  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) {
      out += `\\${value.charAt(i)}`;
    } else if (code === 0x0a) {
      out += "\\n";
    } else if (code === 0x09) {
      out += "\\t";
    } else if (code === 0x0d) {
      out += "\\r";
    } else if (code < 0x20 || code === 0x7f) {
      // Remaining control characters spell as three octal digits, a fixed
      // width no following character can extend.
      out += `\\${code.toString(8).padStart(3, "0")}`;
    } else if (code >= 0xd800 && code <= 0xdfff && !isPairedSurrogate(value, i)) {
      // A lone surrogate cannot survive the UTF-8 encoding of the document
      // text, so it spells as a \U escape, which the parsers read back as
      // the raw code unit.
      out += `\\U${code.toString(16).padStart(4, "0")}`;
    } else {
      out += value.charAt(i);
    }
  }
  return `${out}"`;
}

/** Reports whether a string can be written as a bare token. */
function isBareSafe(value: string): boolean {
  if (value.length === 0 || value.startsWith("//") || value.includes("/*")) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    if (!isOpenStepBareCode(value.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

/** Reports whether the surrogate at `index` is half of a valid pair. */
function isPairedSurrogate(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  if (code <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    return next >= 0xdc00 && next <= 0xdfff;
  }
  const previous = value.charCodeAt(index - 1);
  return previous >= 0xd800 && previous <= 0xdbff;
}
