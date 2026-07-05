import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildPlist, decodeBase64, parseBinaryPlist, parsePlist, PlistParseError, type PlistValue } from "../src/index";

const execFileAsync = promisify(execFile);

/**
 * Binary property lists produced by the platform `plutil` tool, captured as
 * base64 so the core round-trip is verified on every platform (not only the
 * darwin cross-validation below). Each fixture's expected value is asserted
 * against the source it was generated from.
 */
const FIXTURES = {
  // Every value type: strings (ASCII + non-ASCII), int, negative int, a
  // bigint above the safe range, real, both booleans, data, empty data,
  // a nested dict/array, and empty containers.
  comprehensive:
    "YnBsaXN0MDDdAQIDBAUGBwgJCgsMDQ4PEBESExQVGhwdHh9UYmxvYlVjb3VudFNuZWdTYmlnUm9uVXJhdGlvWmVtcHR5X2RpY3RWbmVzdGVkU29mZldjcmVhdGVkWWVtcHR5X2FyclplbXB0eV9kYXRhVG5hbWVDAQL+ECoT//////////kTACAAAAAAAAEJIz/gAAAAAAAA0NEWF1FhoxgZGhABU3R3bwgIM0HH/Ir3AAAAoEBkAFIA+AByAGsIIyguMjY5P0pRVV1ncnd7fYaPkJmanZ+jpamqq7S1tgAAAAAAAAEBAAAAAAAAACAAAAAAAAAAAAAAAAAAAAC/",
  // A 20-element array and a 40-character string, both long enough to force
  // the extended-length encoding (low nibble 0xF followed by an int count).
  extendedLength:
    "YnBsaXN0MDDSAQIDGFhiaWdfbGlzdFhsb25nX3N0cq8QFAQFBgcICQoLDA0ODxAREhMUFRYXEAAQARACEAMQBBAFEAYQBxAIEAkQChALEAwQDRAOEA8QEBAREBIQE18QKHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHgIDRYfNjg6PD5AQkRGSEpMTlBSVFZYWlxeAAAAAAAAAQEAAAAAAAAAGQAAAAAAAAAAAAAAAAAAAIk=",
  // u64max needs a 16-byte integer, i64min needs an 8-byte one, and the emoji
  // is a surrogate pair inside a UTF-16 string object.
  bigIntegers:
    "YnBsaXN0MDDTAQIDBAUGVWVtb2ppVnU2NG1heFZpNjRtaW5oAGgAaQAg2D3eAAAgAG8AaxQAAAAAAAAAAP//////////E4AAAAAAAAAACA8VHCM0RQAAAAAAAAEBAAAAAAAAAAcAAAAAAAAAAAAAAAAAAABO",
} as const;

test("parses a binary plist covering every value type", () => {
  expect(parseBinaryPlist(decodeBase64(FIXTURES.comprehensive))).toEqual({
    name: "Rørk",
    count: 42,
    neg: -7,
    big: 9007199254740993n,
    ratio: 0.5,
    on: true,
    off: false,
    created: new Date("2026-07-04T10:20:30Z"),
    blob: new Uint8Array([1, 2, 254]),
    empty_data: new Uint8Array(0),
    nested: { a: [1, "two", false] },
    empty_dict: {},
    empty_arr: [],
  });
});

test("parses the extended-length encoding for long arrays and strings", () => {
  expect(parseBinaryPlist(decodeBase64(FIXTURES.extendedLength))).toEqual({
    big_list: Array.from({ length: 20 }, (_, i) => i),
    long_str: "x".repeat(40),
  });
});

test("parses 8- and 16-byte integers and surrogate-pair strings", () => {
  expect(parseBinaryPlist(decodeBase64(FIXTURES.bigIntegers))).toEqual({
    emoji: "hi 😀 ok",
    u64max: 18446744073709551615n,
    i64min: -9223372036854775808n,
  });
});

describe("parsePlist auto-detection", () => {
  test("routes a buffer with the bplist00 magic to the binary parser", () => {
    expect(parsePlist(decodeBase64(FIXTURES.comprehensive))).toMatchObject({ name: "Rørk", count: 42 });
  });

  test("decodes a buffer without the magic as UTF-8 XML", () => {
    const xml = buildPlist({ note: "café" });
    const bytes = new TextEncoder().encode(xml);

    expect(parsePlist(bytes)).toEqual({ note: "café" });
  });

  test("still parses an XML string", () => {
    expect(parsePlist(buildPlist({ ok: true }))).toEqual({ ok: true });
  });
});

describe("malformed binary input", () => {
  test("rejects a self-referential object graph via the depth limit", () => {
    // A single array object whose only element references itself (index 0).
    // Resolving it would recurse forever without the depth guard.
    const cyclic = new Uint8Array([
      0x62,
      0x70,
      0x6c,
      0x69,
      0x73,
      0x74,
      0x30,
      0x30, // "bplist00"
      0xa1,
      0x00, // object 0: array, count 1, element ref -> object 0
      0x08, // offset table: object 0 begins at byte 8
      // trailer: 6 lead bytes, offsetIntSize=1, objectRefSize=1,
      // numObjects=1, topObject=0, offsetTableOffset=10
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x01,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x0a,
    ]);

    expect(() => parseBinaryPlist(cyclic)).toThrow(/maximum nesting depth/u);
  });

  test("rejects a buffer too short to hold a trailer", () => {
    expect(() => parseBinaryPlist(new Uint8Array([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30]))).toThrow(
      PlistParseError,
    );
  });

  test("reports the byte offset in the error position", () => {
    try {
      parseBinaryPlist(new Uint8Array([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30]));
      expect.unreachable("parse should have failed");
    } catch (error) {
      assert(error instanceof PlistParseError);
      expect(error.position.line).toBe(1);
      expect(error.message).toContain("byte");
    }
  });
});

// Cross-validation against the platform's own plist tooling, the empirical
// ground truth for the binary layout.
describe.runIf(process.platform === "darwin")("plutil binary cross-validation", () => {
  const RICH_VALUE: PlistValue = {
    string: "hello & <world> 日本語 😀",
    integer: 42,
    negative: -7,
    real: 3.25,
    yes: true,
    no: false,
    date: new Date("2026-07-04T10:20:30Z"),
    data: new Uint8Array([0, 1, 2, 253, 254, 255]),
    array: ["a", 1, [true, { deep: "value" }]],
    dict: { inner: "value" },
    empty: {},
  };

  test("parses binary documents plutil converts from our XML output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rork-plist-bin-"));
    try {
      const xmlPath = join(dir, "doc.plist");
      const binPath = join(dir, "doc.bin");
      await writeFile(xmlPath, buildPlist(RICH_VALUE));
      await execFileAsync("plutil", ["-convert", "binary1", "-o", binPath, xmlPath]);
      const { readFile } = await import("node:fs/promises");
      const bytes = new Uint8Array(await readFile(binPath));

      expect(parseBinaryPlist(bytes)).toEqual(RICH_VALUE);
      expect(parsePlist(bytes)).toEqual(RICH_VALUE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
