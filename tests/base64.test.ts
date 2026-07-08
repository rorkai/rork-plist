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

// Runtimes without the Buffer global (browsers, Hermes) take the portable
// code path; it must behave identically to the native fast path.
describe("without a native base64 codec", () => {
  beforeEach(() => {
    // The `undefined` is the point here — it simulates a host without the global.
    // oxlint-disable-next-line unicorn/no-useless-undefined
    vi.stubGlobal("Buffer", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
