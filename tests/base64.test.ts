import { decodeBase64, encodeBase64 } from "../src/index";

// RFC 4648 section 10 test vectors.
test.each([
  ["", ""],
  ["f", "Zg=="],
  ["fo", "Zm8="],
  ["foo", "Zm9v"],
  ["foob", "Zm9vYg=="],
  ["fooba", "Zm9vYmE="],
  ["foobar", "Zm9vYmFy"],
])("encodes %j as %j and decodes it back", (ascii, base64) => {
  const bytes = new Uint8Array([...ascii].map((char) => char.charCodeAt(0)));

  expect(encodeBase64(bytes)).toBe(base64);
  expect(decodeBase64(base64)).toEqual(bytes);
});

test("round-trips every byte value", () => {
  const bytes = new Uint8Array(256).map((_, i) => i);

  expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
});

test("ignores whitespace anywhere in the input", () => {
  expect(decodeBase64(" Zm9v\n\tYmFy \r\n")).toEqual(decodeBase64("Zm9vYmFy"));
});

// The whitespace set is ASCII whitespace: the platform parser accepts a form
// feed inside <data> (probed through plutil), and so does the standard
// Uint8Array.fromBase64 codec. A vertical tab is not whitespace to either
// codec and stays rejected.
test("accepts a form feed as whitespace but rejects a vertical tab", () => {
  expect(decodeBase64("Zm9v\fYmFy")).toEqual(decodeBase64("Zm9vYmFy"));
  expect(decodeBase64(`\f${"Zm9vYmFy".repeat(12)}\f`)).toEqual(decodeBase64("Zm9vYmFy".repeat(12)));
  expect(() => decodeBase64("Zm9v\vYmFy")).toThrow(RangeError);
  expect(() => decodeBase64(`${"Zm9vYmFy".repeat(12)}\v`)).toThrow(RangeError);
});

// Short inputs decode on a separate fast path; sweeping payload sizes across
// the path boundary proves both paths agree byte for byte, padded or not,
// bare or whitespace-wrapped.
test("decodes identically on both sides of the small-input fast path", () => {
  for (let length = 0; length <= 80; length++) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 53 + length) & 0xff);
    const base64 = encodeBase64(bytes);
    const wrapped = `\n\t${base64.replaceAll(/(.{20})/gu, "$1\n\t")}\n`;
    const unpadded = base64.replace(/=+$/u, "");

    expect(decodeBase64(base64), `bare, ${length} bytes`).toEqual(bytes);
    expect(decodeBase64(wrapped), `wrapped, ${length} bytes`).toEqual(bytes);
    expect(decodeBase64(unpadded), `unpadded, ${length} bytes`).toEqual(bytes);
  }
});

test("accepts unpadded final groups", () => {
  expect(decodeBase64("Zm9vYg")).toEqual(decodeBase64("Zm9vYg=="));
  expect(decodeBase64("Zm9vYmE")).toEqual(decodeBase64("Zm9vYmE="));
});

test("rejects characters outside the alphabet", () => {
  expect(() => decodeBase64("Zm9%")).toThrow(RangeError);
});

test("rejects a truncated final group", () => {
  expect(() => decodeBase64("Zm9vY")).toThrow(RangeError);
});

test("rejects padding in the middle of the input", () => {
  expect(() => decodeBase64("Zm==9v")).toThrow(RangeError);
});

test("rejects excessive padding", () => {
  expect(() => decodeBase64("Z===")).toThrow(RangeError);
});

// The decode tier backed by the standard Uint8Array codec must accept and
// reject exactly the same inputs as this module's own paths — a divergence
// would make behavior depend on the host. The standard API is removed for
// the duration of the block so decodeBase64 exercises the module's own
// validation, while the saved reference serves as the comparison oracle.
// Hosts without the API skip the block (stock Node 24 ships it only behind
// a V8 flag; the CI matrix includes a run with the flag enabled).
const standardCodec = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");

describe.skipIf(standardCodec === undefined)("differential against the standard codec", () => {
  beforeEach(() => {
    delete (Uint8Array as { fromBase64?: unknown }).fromBase64;
  });

  afterEach(() => {
    if (standardCodec) {
      Object.defineProperty(Uint8Array, "fromBase64", standardCodec);
    }
  });

  test("agrees with the module's own paths on seeded mutated inputs", () => {
    if (standardCodec === undefined) {
      throw new Error("unreachable: the block is skipped without the standard codec");
    }
    const native = standardCodec.value as (text: string) => Uint8Array;
    // Deterministic LCG, so failures reproduce.
    let state = 0xbadc0de;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const whitespace = " \t\n\f\r";
    const invalid = "%\v\u00E9\u0000*";

    for (let round = 0; round < 600; round++) {
      // Lengths cross the small-input fast-path boundary in both directions.
      const bytes = new Uint8Array(Math.floor(random() * 120)).map(() => Math.floor(random() * 256));
      let input = encodeBase64(bytes);
      const mutation = Math.floor(random() * 8);
      const at = Math.floor(random() * (input.length + 1));
      if (mutation === 1 || mutation === 3) {
        const run = whitespace[Math.floor(random() * whitespace.length)]!.repeat(1 + Math.floor(random() * 3));
        input = input.slice(0, at) + run + input.slice(at);
      }
      if (mutation === 2 || mutation === 3) {
        input = input.replace(/=+$/u, "");
      }
      if (mutation === 4) {
        input = input.slice(0, at) + invalid[Math.floor(random() * invalid.length)] + input.slice(at);
      }
      if (mutation === 5) {
        input = input.slice(0, at) + "=" + input.slice(at);
      }
      if (mutation === 6 && input.length > 0) {
        input = input.slice(0, -1);
      }
      if (mutation === 7) {
        input += "=";
      }

      let ours: Uint8Array | null = null;
      try {
        ours = decodeBase64(input);
      } catch {
        ours = null;
      }
      let theirs: Uint8Array | null = null;
      try {
        theirs = native(input);
      } catch {
        theirs = null;
      }

      const label = `round ${round}: ${JSON.stringify(input)}`;
      if (ours === null || theirs === null) {
        expect(ours, label).toBe(theirs);
      } else {
        expect(ours, label).toEqual(theirs);
      }
    }
  });
});

// Runtimes without the Buffer global (browsers, Hermes) take the portable
// code path; it must behave identically to the native fast path. The
// standard Uint8Array codec is removed too, because hosts that ship it would
// otherwise satisfy the decode tier above the portable one.
describe("without a native base64 codec", () => {
  const fromBase64 = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
  const toBase64 = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toBase64");

  beforeEach(() => {
    // The `undefined` is the point here — it simulates a host without the global.
    // oxlint-disable-next-line unicorn/no-useless-undefined
    vi.stubGlobal("Buffer", undefined);
    delete (Uint8Array as { fromBase64?: unknown }).fromBase64;
    delete (Uint8Array.prototype as { toBase64?: unknown }).toBase64;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (fromBase64) {
      Object.defineProperty(Uint8Array, "fromBase64", fromBase64);
    }
    if (toBase64) {
      // Restores the descriptor the beforeEach hook removed; this puts the
      // host's own method back rather than extending the prototype.
      // oxlint-disable-next-line no-extend-native
      Object.defineProperty(Uint8Array.prototype, "toBase64", toBase64);
    }
  });

  test("encodes and decodes identically to the native path", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);

    expect(encodeBase64(bytes)).toBe(
      "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/w==",
    );
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });

  test("decodes whitespace-wrapped and unpadded input", () => {
    expect(decodeBase64(" Zm9v\n\tYmFy \r\n")).toEqual(new Uint8Array([102, 111, 111, 98, 97, 114]));
    expect(decodeBase64("Zm9vYg")).toEqual(new Uint8Array([102, 111, 111, 98]));
  });

  test("rejects invalid input", () => {
    expect(() => decodeBase64("Zm9%")).toThrow(RangeError);
    expect(() => decodeBase64("Zm9vY")).toThrow(RangeError);
  });
});
