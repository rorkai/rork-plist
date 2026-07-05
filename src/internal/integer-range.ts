/**
 * Boundaries of the `<integer>` element's value space.
 *
 * The reference implementation stores plist integers in a 64-bit machine
 * word and accepts the union of the signed and unsigned ranges before
 * reporting overflow, so the representable window is `[-(2^63), 2^64 - 1]`.
 * Both the parser and the builder enforce the same window so a value that
 * round-trips through this library also round-trips through Apple tooling.
 */

/** Lowest value an `<integer>` element can carry: `-(2^63)`. */
export const PLIST_INTEGER_MIN = -(2n ** 63n);

/** Highest value an `<integer>` element can carry: `2^64 - 1`. */
export const PLIST_INTEGER_MAX = 2n ** 64n - 1n;

/** `Number.MAX_SAFE_INTEGER` as a bigint, for exactness comparisons. */
export const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** `-Number.MAX_SAFE_INTEGER` as a bigint, for exactness comparisons. */
export const MIN_SAFE_INTEGER_BIGINT = -MAX_SAFE_INTEGER_BIGINT;
