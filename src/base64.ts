/**
 * Strict RFC 4648 base64 codec backing the `<data>` element.
 *
 * The codec is exported as part of the public API because protocol code that
 * works with property lists almost always needs a base64 codec with the same
 * tolerance rules — whitespace anywhere (Apple tools wrap `<data>` content
 * across indented lines) and optional padding, but nothing else.
 *
 * Hosts that expose a native codec through the `Buffer` global (Node.js,
 * Bun, Electron, edge runtimes with Node compatibility) take a fast path
 * after validation; browsers and Hermes take a portable pure-JavaScript path
 * with identical observable behavior.
 *
 * @module
 */

import { EQUALS_SIGN } from "./internal/character-codes";

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
 * Detects whether whitespace stripping is needed at all, so the common
 * single-line input avoids the `replace` allocation entirely.
 */
const CONTAINS_WHITESPACE = /[\t\n\r ]/u;

/** Whitespace runs removed before validation and decoding. */
const WHITESPACE_RUNS = /[\t\n\r ]+/gu;

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
 * Whitespace is ignored anywhere, matching how Apple tools wrap `<data>`
 * content across lines. Padding may be omitted when the final group is
 * unambiguous. Characters outside the alphabet, misplaced padding, or a
 * truncated final group raise an error instead of silently dropping part of
 * the payload — the failure mode that matters when the payload is a
 * certificate, a cryptographic proof, or a session token.
 *
 * @param text Base64 text, optionally wrapped with whitespace.
 * @returns A freshly allocated buffer holding exactly the decoded bytes.
 * @throws RangeError when the input is not valid base64.
 */
export function decodeBase64(text: string): Uint8Array {
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
