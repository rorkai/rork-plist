import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  buildBinaryPlist,
  buildPlist,
  decodeBase64,
  parseBinaryPlist,
  parsePlist,
  PlistParseError,
  PlistUid,
  type PlistArray,
  type PlistValue,
} from "../src/index";

const execFileAsync = promisify(execFile);

const MAGIC = [0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30] as const;

/**
 * Encodes XML text as UTF-16 with a leading byte order mark, the encoding
 * selection signal the reference parser honors for property list files.
 *
 * @param text The document text to encode.
 * @param littleEndian Unit byte order; the mark announces the same order.
 */
function utf16Bytes(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xfeff, littleEndian);
  for (let i = 0; i < text.length; i++) {
    view.setUint16(2 + i * 2, text.charCodeAt(i), littleEndian);
  }
  return out;
}

/**
 * Wraps a single hand-written object as a complete binary plist — magic, the
 * object at byte 8, a one-entry offset table, and a trailer. Every width is 1
 * byte, which is valid for any object under 256 bytes and keeps the malformed
 * fixtures below readable.
 *
 * @param object The object's raw bytes (marker plus payload).
 */
function singleObjectBinaryPlist(object: readonly number[]): Uint8Array {
  const body = [...MAGIC, ...object];
  const offsetTableOffset = body.length;
  body.push(MAGIC.length); // the one offset-table entry — object 0 begins at byte 8

  const trailer = Array.from({ length: 32 }, () => 0);
  trailer[6] = 1; // offsetIntSize
  trailer[7] = 1; // objectRefSize
  trailer[15] = 1; // objectCount = 1
  // topObject stays 0; offsetTableOffset in the last trailer byte.
  trailer[31] = offsetTableOffset;
  return Uint8Array.from([...body, ...trailer]);
}

/**
 * Builds a binary plist whose root fans out through shared references.
 * Object 0 is an integer leaf and object k is the array `[k-1, k-1]`, so the
 * root (object `depth`) forms a balanced binary tree of height `depth`. A
 * parser that re-resolves each reference visits the leaf `2^depth` times;
 * one that memoizes resolved objects visits `depth + 1` objects total.
 *
 * @param depth Number of array levels above the leaf; also the root's index.
 */
function fanoutBinaryPlist(depth: number): Uint8Array {
  const objects: number[][] = [[0x10, 0x00]]; // object 0 is the integer 0
  for (let k = 1; k <= depth; k++) {
    objects.push([0xa2, k - 1, k - 1]); // array with two refs to object k-1
  }

  const body: number[] = [...MAGIC];
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(body.length);
    body.push(...object);
  }
  const offsetTableOffset = body.length;
  body.push(...offsets); // 1-byte offsets, valid while the body stays < 256 B

  const trailer = Array.from({ length: 32 }, () => 0);
  trailer[6] = 1; // offsetIntSize
  trailer[7] = 1; // objectRefSize
  trailer[15] = objects.length; // objectCount (< 256)
  trailer[23] = depth; // topObject = root index
  trailer[31] = offsetTableOffset; // offset table location (< 256)
  return Uint8Array.from([...body, ...trailer]);
}

/**
 * Binary property lists produced by the platform `plutil` tool, captured as
 * base64 so the core round-trip is verified on every platform (not only the
 * darwin cross-validation below). Each fixture's expected value is asserted
 * against the source it was generated from.
 */
const FIXTURES = {
  // Covers every value type — strings (ASCII + non-ASCII), int, negative
  // int, a bigint above the safe range, real, both booleans, data, empty
  // data, a nested dict/array, and empty containers.
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

  test("rejects invalid UTF-8 on the XML byte path", () => {
    // Leads with '<' so the bplist magic check fails and the buffer takes the
    // XML-decode path; 0xff is never a valid UTF-8 byte.
    expect(() => parsePlist(new Uint8Array([0x3c, 0xff]))).toThrow(PlistParseError);
  });

  test("decodes UTF-16 buffers by their byte order mark", () => {
    const doc = "<dict><key>name</key><string>Rørk 😀</string></dict>";

    expect(parsePlist(utf16Bytes(doc, true))).toEqual({ name: "Rørk 😀" });
    expect(parsePlist(utf16Bytes(doc, false))).toEqual({ name: "Rørk 😀" });
  });

  test("rejects UTF-16 that ends in a half code unit", () => {
    const bytes = utf16Bytes("<string>x</string>", true);

    expect(() => parsePlist(bytes.subarray(0, bytes.length - 1))).toThrow(/half code unit/u);
  });

  test("rejects UTF-16 without a byte order mark, like the reference parser", () => {
    const bytes = utf16Bytes("<string>x</string>", true).subarray(2);

    expect(() => parsePlist(bytes)).toThrow(PlistParseError);
  });
});

describe("the data option", () => {
  // A single <data> object of two bytes; its payload sits at bytes 9-10,
  // right after the magic (8) and the 0x42 marker.
  const DATA_DOC = () => singleObjectBinaryPlist([0x42, 0xaa, 0xbb]);

  test("copies payloads out of the input buffer by default", () => {
    const doc = DATA_DOC();
    const parsed = parseBinaryPlist(doc) as Uint8Array;

    expect(parsed).toEqual(new Uint8Array([0xaa, 0xbb]));
    expect(parsed.buffer).not.toBe(doc.buffer);
    parsed[0] = 0;
    expect(doc[9]).toBe(0xaa); // the document is untouched
  });

  test("data: 'view' aliases the input buffer without copying", () => {
    const doc = DATA_DOC();
    const parsed = parseBinaryPlist(doc, { data: "view" }) as Uint8Array;

    expect(parsed).toEqual(new Uint8Array([0xaa, 0xbb]));
    expect(parsed.buffer).toBe(doc.buffer);
    expect(parsed.byteOffset).toBe(9);
  });
});

describe("depth limit", () => {
  test("applies on container entry, empty containers included", () => {
    // Object 0 is an array whose single element is object 1, an empty array.
    // After the magic come the two objects, the offset table (objects at
    // bytes 8 and 10), and the trailer naming offsetIntSize 1, objectRefSize
    // 1, two objects, root object 0, and the offset table at byte 11.
    // oxfmt-ignore
    const nestedEmpty = Uint8Array.from([
      0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30,
      0xa1, 0x01,
      0xa0,
      0x08, 0x0a,
      0, 0, 0, 0, 0, 0, 1, 1,
      0, 0, 0, 0, 0, 0, 0, 2,
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 11,
    ]);

    expect(parseBinaryPlist(nestedEmpty, { maxDepth: 2 })).toEqual([[]]);
    expect(() => parseBinaryPlist(nestedEmpty, { maxDepth: 1 })).toThrow(/maximum nesting depth/u);
  });
});

describe("shared object references", () => {
  test("resolves repeated references to one shared value without expanding", () => {
    // Height 60 is 2^60 leaf visits without memoization — the test would not
    // finish. It returns immediately when references are resolved once, so the
    // assertion walks the shared spine rather than deep-equaling the tree.
    const depth = 60;
    let node: PlistValue = parseBinaryPlist(fanoutBinaryPlist(depth));

    for (let level = 0; level < depth; level++) {
      expect(Array.isArray(node)).toBe(true);
      const array = node as PlistArray;
      expect(array).toHaveLength(2);
      expect(array[0]).toBe(array[1]); // the same instance, not a re-parsed copy
      node = array[0]!;
    }
    expect(node).toBe(0);
  });
});

describe("UID objects", () => {
  test("parses one- to four-byte UID payloads", () => {
    expect(parseBinaryPlist(singleObjectBinaryPlist([0x80, 0x05]))).toEqual(new PlistUid(5));
    expect(parseBinaryPlist(singleObjectBinaryPlist([0x81, 0x01, 0x2c]))).toEqual(new PlistUid(300));
    expect(parseBinaryPlist(singleObjectBinaryPlist([0x82, 0x01, 0x11, 0x70]))).toEqual(new PlistUid(70000));
    expect(parseBinaryPlist(singleObjectBinaryPlist([0x83, 0xff, 0xff, 0xff, 0xff]))).toEqual(
      new PlistUid(0xff_ff_ff_ff),
    );
  });

  // CF rejects five- and eight-byte UID payloads (probed with hand-assembled
  // documents), so widths past four are malformed rather than big values.
  test("rejects UID payloads wider than four bytes", () => {
    expect(() => parseBinaryPlist(singleObjectBinaryPlist([0x84, 0x01, 0, 0, 0, 0]))).toThrow(/UID width/u);
    expect(() => parseBinaryPlist(singleObjectBinaryPlist([0x87, 0, 0, 0, 2, 0, 0, 0, 0]))).toThrow(/UID width/u);
  });

  test("deduplicates equal UIDs in built output", () => {
    const built = buildBinaryPlist([new PlistUid(9), new PlistUid(9), new PlistUid(300)]);

    expect(parseBinaryPlist(built)).toEqual([new PlistUid(9), new PlistUid(9), new PlistUid(300)]);
    // The root array plus one object each for 9 and 300 makes three objects,
    // where a writer without interning would emit four. numObjects is the
    // big-endian u64 that starts 24 bytes before the end of the trailer.
    const view = new DataView(built.buffer, built.byteLength - 24, 8);
    expect(view.getUint32(4)).toBe(3);
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
      0x00, // object 0 — an array of count 1 whose element ref points back to object 0
      0x08, // the one offset-table entry — object 0 begins at byte 8
      // The trailer holds 6 lead bytes, then offsetIntSize=1, objectRefSize=1,
      // numObjects=1, topObject=0, offsetTableOffset=10.
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

  test("rejects a date marker other than 0x33", () => {
    // 0x30 has the date type nibble but the wrong low nibble; the low nibble
    // of a date is not a width field, so only 0x33 is valid.
    const badMarker = singleObjectBinaryPlist([0x30, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => parseBinaryPlist(badMarker)).toThrow(/0x33/u);
  });

  test("rejects a date payload that is not a representable Date", () => {
    // 0x33 followed by the IEEE 754 bit pattern for NaN.
    const nanDate = singleObjectBinaryPlist([0x33, 0x7f, 0xf8, 0, 0, 0, 0, 0, 0]);
    expect(() => parseBinaryPlist(nanDate)).toThrow(PlistParseError);
  });

  test("rejects a non-ASCII byte inside an ASCII string object", () => {
    // 0x51 is an ASCII string of length 1; 0x80 is outside the ASCII range
    // and would only ever appear in a UTF-16 (0x6n) string object.
    const nonAscii = singleObjectBinaryPlist([0x51, 0x80]);
    expect(() => parseBinaryPlist(nonAscii)).toThrow(/non-ASCII/u);
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

  test("round-trips UIDs through plutil in both directions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rork-plist-uid-"));
    try {
      const xmlPath = join(dir, "doc.plist");
      const binPath = join(dir, "doc.bin");
      // Our XML CF$UID rendering must convert into real UID markers, and
      // plutil's binary output must parse back into the same PlistUids.
      const value = { small: new PlistUid(5), wide: new PlistUid(70000), max: new PlistUid(0xff_ff_ff_ff) };
      await writeFile(xmlPath, buildPlist(value));
      await execFileAsync("plutil", ["-convert", "binary1", "-o", binPath, xmlPath]);
      const { readFile } = await import("node:fs/promises");
      const bytes = new Uint8Array(await readFile(binPath));

      expect(parseBinaryPlist(bytes)).toEqual(value);
      // Our own binary output must survive plutil's reading the same way.
      await writeFile(binPath, buildBinaryPlist(value));
      const { stdout } = await execFileAsync("plutil", ["-convert", "xml1", "-o", "-", binPath]);
      expect(parsePlist(stdout)).toEqual(value);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reads the same UTF-16 document plutil accepts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rork-plist-u16-"));
    try {
      const path = join(dir, "doc.plist");
      const bytes = utf16Bytes(buildPlist({ name: "Rørk 😀", ok: true }), true);
      await writeFile(path, bytes);
      // plutil accepting the exact same bytes proves the encoding selection
      // matches the platform, not just our own round trip.
      const { stdout } = await execFileAsync("plutil", ["-convert", "xml1", "-o", "-", path]);

      expect(parsePlist(bytes)).toEqual({ name: "Rørk 😀", ok: true });
      expect(parsePlist(stdout)).toEqual({ name: "Rørk 😀", ok: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
