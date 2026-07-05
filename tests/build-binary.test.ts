import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  buildBinaryPlist,
  buildPlist,
  parseBinaryPlist,
  parsePlist,
  PlistBuildError,
  type PlistValue,
} from "../src/index";

const execFileAsync = promisify(execFile);

// Whole-second date so the value survives plutil's XML round trip in the
// cross-validation below; sub-second preservation has its own test.
const RICH_VALUE: PlistValue = {
  string: "hello & <world> 日本語 😀",
  emptyString: "",
  integer: 42,
  negative: -7,
  u64max: 18446744073709551615n,
  i64min: -9223372036854775808n,
  real: 3.25,
  yes: true,
  no: false,
  date: new Date("2026-07-04T10:20:30Z"),
  data: new Uint8Array([0, 1, 2, 253, 254, 255]),
  emptyData: new Uint8Array(0),
  array: ["a", 1, [true, { deep: "value" }]],
  emptyArray: [],
  dict: { inner: "value" },
  emptyDict: {},
};

test("round-trips every value type through binary", () => {
  expect(parseBinaryPlist(buildBinaryPlist(RICH_VALUE))).toEqual(RICH_VALUE);
});

test("preserves sub-second date precision, which XML would truncate", () => {
  const value = { at: new Date("2026-07-04T10:20:30.500Z") };

  expect(parseBinaryPlist(buildBinaryPlist(value))).toEqual(value);
});

test("round-trips a scalar root", () => {
  expect(parseBinaryPlist(buildBinaryPlist("just a string"))).toBe("just a string");
  expect(parseBinaryPlist(buildBinaryPlist(42))).toBe(42);
});

test("starts with the bplist00 magic", () => {
  const magic = buildBinaryPlist({}).subarray(0, 8);

  expect([...magic]).toEqual([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30]);
});

test("round-trips randomized documents", () => {
  // Deterministic generator so failures reproduce.
  let seed = 0x2026_0705;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const randomValue = (depth: number): PlistValue => {
    switch (Math.floor(random() * (depth > 3 ? 6 : 8))) {
      case 0:
        return `s${Math.floor(random() * 1e6)}😀`;
      case 1:
        return Math.floor(random() * 2 ** 40) - 2 ** 39;
      case 2:
        return random() < 0.5 ? random() : Math.floor(random() * 100) + 0.5;
      case 3:
        return random() < 0.5;
      case 4:
        return new Uint8Array(Math.floor(random() * 20)).map(() => Math.floor(random() * 256));
      case 5:
        return new Date(Math.floor(random() * 4e12));
      case 6:
        return Array.from({ length: Math.floor(random() * 5) }, () => randomValue(depth + 1));
      default: {
        const dict: Record<string, PlistValue> = {};
        for (let i = 0; i < Math.floor(random() * 5); i++) {
          dict[`k${Math.floor(random() * 1e4)}`] = randomValue(depth + 1);
        }
        return dict;
      }
    }
  };

  for (let i = 0; i < 200; i++) {
    const value = randomValue(0);
    expect(parseBinaryPlist(buildBinaryPlist(value))).toEqual(value);
  }
});

test("deduplicates repeated scalars", () => {
  // Ten dicts each with the same two keys and a shared string value — without
  // interning, the keys and value would be re-emitted every time. The dedup
  // is observable as a much smaller document than the naive size, and it must
  // still round-trip.
  const value = Array.from({ length: 10 }, () => ({ sharedKey: "shared-value", other: "shared-value" }));
  const binary = buildBinaryPlist(value);

  expect(parseBinaryPlist(binary)).toEqual(value);
  // 3 interned scalars ("sharedKey", "other", "shared-value") plus 11 dicts/
  // array, nowhere near the ~30 scalar objects a naive encoder would emit.
  expect(binary.length).toBeLessThan(300);
});

test("deduplicates <data> payloads", () => {
  // Distinct small views with identical bytes deduplicate by content...
  const sharedView = new Uint8Array([1, 2, 3, 4]);
  const byContent = buildBinaryPlist({ a: new Uint8Array([1, 2, 3, 4]), b: new Uint8Array([1, 2, 3, 4]) });
  const byIdentity = buildBinaryPlist({ a: sharedView, b: sharedView });
  expect(byContent.length).toBe(byIdentity.length);
  expect(parseBinaryPlist(byContent)).toEqual({ a: sharedView, b: sharedView });

  // ...while a large payload is keyed by view identity (content keying would
  // rescan the payload on every occurrence), so reusing one view stores the
  // bytes once.
  const large = new Uint8Array(100_000).fill(7);
  expect(buildBinaryPlist({ a: large, b: large }).length).toBeLessThan(120_000);
});

test("allows dates outside the four-digit year range that XML rejects", () => {
  // The binary layout stores a raw timestamp, so it has no calendar-text limit.
  const farFuture = new Date(0);
  farFuture.setUTCFullYear(12_000, 0, 1);

  expect(() => buildPlist(farFuture)).toThrow(PlistBuildError);
  expect(parseBinaryPlist(buildBinaryPlist(farFuture))).toEqual(farFuture);
});

describe("value-model parity with the XML builder", () => {
  // Every value both builders must reject, checked against each so the two
  // stay in lockstep on the shared rules.
  test.each([
    ["null", null, "$"],
    ["undefined at the root", undefined, "$"],
    ["null in an array", [null], "$[0]"],
    ["undefined in an array", [undefined], "$[0]"],
    ["NaN", NaN, "$"],
    ["Infinity", Infinity, "$"],
    ["out-of-range bigint", 2n ** 64n, "$"],
    // Integer-valued doubles beyond the 64-bit window — both builders must
    // reject rather than truncate (binary) or emit unparsable text (XML).
    ["out-of-range positive integral number", 1e40, "$"],
    ["out-of-range negative integral number", -1e19, "$"],
    ["a class instance", new Map(), "$"],
  ])("both builders reject %s", (_label, value, path) => {
    expect(() => buildPlist(value as never)).toThrow(path);
    expect(() => buildBinaryPlist(value as never)).toThrow(path);
  });

  test("both builders omit undefined dictionary values", () => {
    const value = { kept: 1, dropped: undefined } as never;

    expect(parseBinaryPlist(buildBinaryPlist(value))).toEqual({ kept: 1 });
    expect(buildPlist(value)).not.toContain("dropped");
  });
});

test("rejects circular references instead of recursing forever", () => {
  const cyclic: PlistValue[] = [];
  cyclic.push(cyclic);

  expect(() => buildBinaryPlist(cyclic)).toThrow(/circular reference/u);
});

// Cross-validation against the platform's own plist tooling — our output must
// be something Apple's parser accepts and reads back to the same value.
describe.runIf(process.platform === "darwin")("plutil binary cross-validation", () => {
  test("plutil accepts our binary output and it round-trips through plutil's XML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rork-plist-buildbin-"));
    try {
      const binPath = join(dir, "doc.bin");
      await writeFile(binPath, buildBinaryPlist(RICH_VALUE));

      // plutil accepting the buffer proves the layout is well-formed.
      await expect(execFileAsync("plutil", ["-lint", binPath])).resolves.toBeDefined();

      // Convert our binary to XML with plutil, then parse that XML with our
      // own parser, so the value must survive the trip through Apple's
      // tooling. (JSON conversion can't be used — it has no representation
      // for data or date.)
      const { stdout } = await execFileAsync("plutil", ["-convert", "xml1", "-o", "-", binPath]);
      expect(parsePlist(stdout)).toEqual(RICH_VALUE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("our parser reads binary that plutil produced from the same value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rork-plist-buildbin-"));
    try {
      const xmlPath = join(dir, "doc.plist");
      const binPath = join(dir, "doc.bin");
      await writeFile(xmlPath, buildPlist(RICH_VALUE));
      await execFileAsync("plutil", ["-convert", "binary1", "-o", binPath, xmlPath]);

      // plutil's binary and ours should both parse to the same value.
      const theirs = parseBinaryPlist(new Uint8Array(await readFile(binPath)));
      const ours = parseBinaryPlist(buildBinaryPlist(RICH_VALUE));
      expect(ours).toEqual(theirs);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
