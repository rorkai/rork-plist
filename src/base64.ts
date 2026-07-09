/**
 * Strict RFC 4648 base64 codec backing the `<data>` element.
 *
 * The codec is exported as part of the public API because protocol code that
 * works with property lists almost always needs a base64 codec with the same
 * tolerance rules — whitespace anywhere (Apple tools wrap `<data>` content
 * across indented lines) and optional padding, but nothing else.
 *
 * Decoding uses the fastest codec the host ships — the standard
 * `Uint8Array.fromBase64`, then the `Buffer` global, then plain
 * JavaScript — and behaves identically on all of them. Errors always come
 * from this module's own validation, never from the host codec.
 *
 * @module
 */

import { EQUALS_SIGN, FORM_FEED, isWhitespaceCode } from "./internal/character-codes";

/** The RFC 4648 section 4 alphabet, indexed by six-bit value. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Reverse lookup from an ASCII code unit to its six-bit alphabet value;
 * -1 marks code units outside the alphabet.
 */
const DECODE_TABLE = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) {
  DECODE_TABLE[ALPHABET.charCodeAt(i)] = i;
}

/**
 * Longest input, in characters, that decodes on the small-input fast path.
 *
 * Real documents are dominated by short `<data>` payloads — 20- and 32-byte
 * hashes arrive as 30–50 characters of wrapped base64 — and at those sizes
 * the fixed costs of the general path (two regular-expression passes, a
 * pooled native buffer, and the copy out of the pool) exceed the cost of
 * decoding in plain JavaScript. The measured crossover on Node 24 sits near
 * 48 decoded bytes; above it the general path is faster and takes over.
 */
const SMALL_INPUT_MAX_LENGTH = 64;

/**
 * Scratch output for the small-input fast path, sized for the most bytes
 * {@link SMALL_INPUT_MAX_LENGTH} characters can carry (three bytes per four
 * symbols). Decoding fills a prefix and slices it off as the caller's copy.
 */
const SMALL_DECODE_SCRATCH = new Uint8Array((SMALL_INPUT_MAX_LENGTH / 4) * 3);

/**
 * Reports whether a code unit is base64 whitespace.
 *
 * The set is ASCII whitespace — the XML markup set plus the form feed —
 * matching both the platform parser (probed through `plutil`, which accepts
 * a form feed inside `<data>`) and the standard `Uint8Array.fromBase64`
 * codec, so the native tier never accepts input the other tiers reject.
 */
function isBase64Whitespace(code: number): boolean {
  return isWhitespaceCode(code) || code === FORM_FEED;
}

/**
 * Detects whether whitespace stripping is needed at all, so the common
 * single-line input avoids the `replace` allocation entirely.
 */
const CONTAINS_WHITESPACE = /[\t\n\f\r ]/u;

/** Whitespace runs removed before validation and decoding. */
const WHITESPACE_RUNS = /[\t\n\f\r ]+/gu;

/**
 * Alphabet symbols followed by at most two trailing padding characters; one
 * native regex scan validates both character set and padding placement.
 */
const BASE64_SHAPE = /^[A-Za-z0-9+/]*={0,2}$/u;

/**
 * Interface of the host `Buffer` global used by the native fast path.
 *
 * Only the two overloads the codec calls are described. The global is looked
 * up at call time — never imported — so bundling this module for a host
 * without `Buffer` neither fails nor pulls in a polyfill.
 */
interface BufferConstructorLike {
  /** Decodes base64 text into bytes, as `Buffer.from(text, "base64")`. */
  from(input: string, encoding: "base64"): Uint8Array;

  /** Wraps a buffer window so it can be encoded with `toString("base64")`. */
  from(input: ArrayBufferLike, byteOffset: number, length: number): { toString(encoding: "base64"): string };
}

/**
 * Returns the host's `Buffer` constructor when one is available.
 *
 * The result is used purely as a performance fast path after this module's
 * own validation, so behavior stays identical whether or not the host
 * provides it.
 */
function nativeBuffer(): BufferConstructorLike | null {
  const candidate = (globalThis as { Buffer?: BufferConstructorLike }).Buffer;
  return candidate && typeof candidate.from === "function" ? candidate : null;
}

/**
 * Returns the standard `Uint8Array.fromBase64` codec when the host ships it.
 *
 * The lookup happens at call time, like {@link nativeBuffer}, so tests can
 * remove the API to pin a specific tier and hosts that gain the API pick it
 * up without a rebuild. Its whitespace, padding, and rejection behavior was
 * probed case by case against this module's rules; the one divergence —
 * error type and wording — never surfaces because rejected input re-reports
 * through this module's own validation.
 *
 * The access goes through a cast because the program's `lib` is pinned to
 * the ES2022 runtime floor, where the standard codec's declarations do not
 * exist. Typing the property as optional right here is the point: it is
 * exactly as reliable as the feature detection.
 */
function nativeFromBase64(): ((text: string) => Uint8Array) | null {
  const candidate = (Uint8Array as { fromBase64?: unknown }).fromBase64;
  return typeof candidate === "function" ? (candidate as (text: string) => Uint8Array) : null;
}

/**
 * Interface of the standard `Uint8Array.prototype.toBase64` method used by
 * the encode fast path on hosts without `Buffer`. Declared locally for the
 * same reason {@link nativeFromBase64} casts: the ES2022 `lib` floor has no
 * declarations for the standard codec.
 */
interface ToBase64Capable {
  toBase64?: () => string;
}

/**
 * Builds the most descriptive error for input that failed the shape check.
 *
 * Runs only on the failure path, so it can afford a character-by-character
 * scan to distinguish misplaced padding from characters outside the
 * alphabet.
 */
function describeInvalidBase64(stripped: string): RangeError {
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i);
    if (code === EQUALS_SIGN) {
      return new RangeError("base64 padding may only appear at the end");
    }
    if (code >= 128 || DECODE_TABLE[code] === -1) {
      return new RangeError(`invalid base64 character ${JSON.stringify(stripped.charAt(i))}`);
    }
  }
  return new RangeError("invalid base64 input");
}

/**
 * Returns how many bytes a trailing partial group of base64 symbols carries.
 * Two symbols hold one byte and three hold two; a remainder of zero means the
 * input divided into full groups. A remainder of one was already rejected as
 * truncated input before this runs.
 */
function trailingByteCount(remainder: number): number {
  switch (remainder) {
    case 2:
      return 1;
    case 3:
      return 2;
    default:
      return 0;
  }
}

/**
 * Decodes a short input in one pass, or returns `null` to send it through
 * the general path.
 *
 * The pass validates and decodes simultaneously: alphabet symbols accumulate
 * bits, whitespace is skipped, and anything irregular — a character outside
 * the alphabet, padding followed by more symbols, excess padding, or a
 * truncated final group — abandons the fast path instead of reporting the
 * problem, so every rejection message keeps coming from one place, the
 * general path.
 *
 * @returns The decoded bytes, or `null` when the input needs the general
 *   path's full validation.
 */
function decodeSmallBase64(text: string): Uint8Array | null {
  let symbolCount = 0;
  let padCount = 0;
  let accumulator = 0;
  let bitsCollected = 0;
  let outIndex = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? DECODE_TABLE[code]! : -1;
    if (value >= 0) {
      if (padCount > 0) {
        return null;
      }
      symbolCount++;
      accumulator = (accumulator << 6) | value;
      bitsCollected += 6;
      if (bitsCollected >= 8) {
        bitsCollected -= 8;
        SMALL_DECODE_SCRATCH[outIndex++] = (accumulator >>> bitsCollected) & 0xff;
      }
      continue;
    }
    if (code === EQUALS_SIGN) {
      if (padCount === 2) {
        return null;
      }
      padCount++;
      continue;
    }
    if (isBase64Whitespace(code)) {
      continue;
    }
    return null;
  }

  if (padCount > 0 && (symbolCount + padCount) % 4 !== 0) {
    return null;
  }
  if (symbolCount % 4 === 1) {
    return null;
  }
  return SMALL_DECODE_SCRATCH.slice(0, outIndex);
}

/**
 * Returns the six-bit value of one validated alphabet symbol.
 *
 * Input reaching this function has already passed the shape check, so a
 * miss can only mean the validation pattern and the decode table have
 * drifted apart. Failing loudly here keeps that class of bug from silently
 * corrupting decoded payloads, and lets the type system carry the
 * table-lookup proof instead of a non-null assertion.
 */
function symbolValue(code: number): number {
  const value = DECODE_TABLE[code];
  if (value === undefined || value < 0) {
    throw new RangeError(`base64 validation accepted an invalid symbol (code ${code})`);
  }
  return value;
}

/**
 * Decodes RFC 4648 base64 text into bytes.
 *
 * ASCII whitespace (space, tab, line feed, form feed, carriage return) is
 * ignored anywhere, matching how Apple tools wrap `<data>` content across
 * lines. Padding may be omitted when the final group is unambiguous.
 * Characters outside the alphabet, misplaced padding, or a truncated final
 * group raise an error instead of silently dropping part of the payload —
 * the failure mode that matters when the payload is a certificate, a
 * cryptographic proof, or a session token.
 *
 * @param text Base64 text, optionally wrapped with whitespace.
 * @returns A freshly allocated buffer holding exactly the decoded bytes.
 * @throws RangeError when the input is not valid base64.
 */
export function decodeBase64(text: string): Uint8Array {
  if (text.length <= SMALL_INPUT_MAX_LENGTH) {
    const decoded = decodeSmallBase64(text);
    if (decoded !== null) {
      return decoded;
    }
  }

  const fromBase64 = nativeFromBase64();
  if (fromBase64) {
    try {
      return fromBase64(text);
    } catch {
      // The input is invalid; fall through to this module's validation so
      // the rejection carries the canonical error type and message instead
      // of the host's. The doubled scan only ever runs on the failure path.
    }
  }

  const stripped = CONTAINS_WHITESPACE.test(text) ? text.replace(WHITESPACE_RUNS, "") : text;

  if (!BASE64_SHAPE.test(stripped)) {
    throw describeInvalidBase64(stripped);
  }

  const padCount = stripped.endsWith("==") ? 2 : stripped.endsWith("=") ? 1 : 0;
  if (padCount > 0 && stripped.length % 4 !== 0) {
    throw new RangeError("base64 padding does not match content length");
  }

  const symbolCount = stripped.length - padCount;
  const remainder = symbolCount % 4;
  // A single trailing symbol carries six bits, not enough for a byte, so the
  // group is truncated rather than merely unpadded.
  if (remainder === 1) {
    throw new RangeError("base64 input is truncated");
  }

  const byteLength = Math.floor(symbolCount / 4) * 3 + trailingByteCount(remainder);

  const buffer = nativeBuffer();
  if (buffer) {
    const decoded = buffer.from(stripped, "base64");
    // Copy out of the runtime's internal pool so callers own a standalone
    // buffer exactly the size of the payload.
    const out = new Uint8Array(byteLength);
    out.set(decoded.subarray(0, byteLength));
    return out;
  }

  const out = new Uint8Array(byteLength);
  let accumulator = 0;
  let bitsCollected = 0;
  let outIndex = 0;
  for (let i = 0; i < symbolCount; i++) {
    accumulator = (accumulator << 6) | symbolValue(stripped.charCodeAt(i));
    bitsCollected += 6;
    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      out[outIndex++] = (accumulator >>> bitsCollected) & 0xff;
    }
  }

  return out;
}

/**
 * Encodes bytes as unwrapped RFC 4648 base64 with padding.
 *
 * The output contains no line breaks. Apple parsers accept unwrapped
 * `<data>` content, and a single line keeps documents smaller and encoding
 * simpler than column-wrapped output.
 *
 * Hosts without `Buffer` use the standard `Uint8Array.prototype.toBase64`
 * when it has shipped — it produces the same padded, unwrapped output — and
 * only hosts with neither codec take the portable path.
 *
 * The portable path accumulates bits over `for...of` iteration, which types
 * every byte as `number` — index arithmetic the compiler cannot verify never
 * appears, so neither do non-null assertions. Six bits of a final partial
 * group are flushed left-aligned, exactly as RFC 4648 section 4 specifies.
 *
 * @param bytes The bytes to encode. Only the view's window is read, never
 *   the rest of its backing buffer.
 */
export function encodeBase64(bytes: Uint8Array): string {
  const buffer = nativeBuffer();
  if (buffer) {
    return buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }

  const toBase64 = (bytes as ToBase64Capable).toBase64;
  if (typeof toBase64 === "function") {
    return toBase64.call(bytes);
  }

  let out = "";
  let accumulator = 0;
  let bitsCollected = 0;

  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bitsCollected += 8;
    if (bitsCollected === 24) {
      out +=
        ALPHABET.charAt((accumulator >>> 18) & 63) +
        ALPHABET.charAt((accumulator >>> 12) & 63) +
        ALPHABET.charAt((accumulator >>> 6) & 63) +
        ALPHABET.charAt(accumulator & 63);
      accumulator = 0;
      bitsCollected = 0;
    }
  }

  // One leftover byte flushes as two symbols, two bytes as three; zero
  // leftover bits mean the input divided into full three-byte groups.
  switch (bitsCollected) {
    case 8:
      out += ALPHABET.charAt((accumulator >>> 2) & 63) + ALPHABET.charAt((accumulator << 4) & 63) + "==";
      break;
    case 16:
      out +=
        ALPHABET.charAt((accumulator >>> 10) & 63) +
        ALPHABET.charAt((accumulator >>> 4) & 63) +
        ALPHABET.charAt((accumulator << 2) & 63) +
        "=";
      break;
  }

  return out;
}
