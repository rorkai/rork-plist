import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildPlist, parsePlist, type PlistValue } from "../src/index";

const execFileAsync = promisify(execFile);

const RICH_VALUE: PlistValue = {
  string: "hello & <world> \"quoted\" 'apostrophe' 日本語 😀",
  emptyString: "",
  integer: 42,
  negative: -7,
  big: 18446744073709551615n,
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

test("round-trips a document containing every value type", () => {
  expect(parsePlist(buildPlist(RICH_VALUE))).toEqual(RICH_VALUE);
});

test("round-trips compact output identically", () => {
  expect(parsePlist(buildPlist(RICH_VALUE, { indent: false }))).toEqual(RICH_VALUE);
});

test("round-trips randomized documents", () => {
  // Deterministic linear congruential generator so failures reproduce.
  let seed = 0x2026_0704;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };

  const randomValue = (depth: number): PlistValue => {
    const choice = Math.floor(random() * (depth > 3 ? 6 : 8));
    switch (choice) {
      case 0:
        return `s${Math.floor(random() * 1e9)}&<>"'\u00E9`;
      case 1:
        return Math.floor(random() * 2 ** 40) - 2 ** 39;
      case 2:
        return random() < 0.5 ? random() * 1000 - 500 : Math.floor(random() * 100) + 0.5;
      case 3:
        return random() < 0.5;
      case 4:
        return new Date(Math.floor((random() * 4e12) / 1000) * 1000);
      case 5:
        return new Uint8Array(Math.floor(random() * 24)).map(() => Math.floor(random() * 256));
      case 6:
        return Array.from({ length: Math.floor(random() * 5) }, () => randomValue(depth + 1));
      default: {
        const dict: Record<string, PlistValue> = {};
        const size = Math.floor(random() * 5);
        for (let i = 0; i < size; i++) {
          dict[`k${Math.floor(random() * 1e6)}`] = randomValue(depth + 1);
        }
        return dict;
      }
    }
  };

  for (let i = 0; i < 200; i++) {
    const value = randomValue(0);
    expect(parsePlist(buildPlist(value))).toEqual(value);
    expect(parsePlist(buildPlist(value, { indent: false }))).toEqual(value);
  }
});

/**
 * Writes a document to a temporary file, runs the callback with its path,
 * and removes the file afterwards. plutil only reads from disk.
 */
async function withTempFile<T>(contents: string, run: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "rork-plist-"));
  const path = join(dir, "doc.plist");
  try {
    await writeFile(path, contents);
    return await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Cross-validation against the platform's own plist tooling, the empirical
// ground truth for what Apple parsers accept.
describe.runIf(process.platform === "darwin")("plutil cross-validation", () => {
  test("plutil lints generated documents", async () => {
    await withTempFile(buildPlist(RICH_VALUE), async (path) => {
      await expect(execFileAsync("plutil", ["-lint", path])).resolves.toBeDefined();
    });
  });

  test("plutil lints compact generated documents", async () => {
    await withTempFile(buildPlist(RICH_VALUE, { indent: false }), async (path) => {
      await expect(execFileAsync("plutil", ["-lint", path])).resolves.toBeDefined();
    });
  });

  test("plutil reads back the JSON-representable subset unchanged", async () => {
    const value: PlistValue = {
      name: "Rork & Co <plists>",
      count: 42,
      ratio: 0.5,
      enabled: true,
      items: ["a", "b", { nested: "yes" }],
    };

    const json = await withTempFile(buildPlist(value), async (path) => {
      const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", path]);
      return JSON.parse(stdout) as unknown;
    });

    expect(json).toEqual(value);
  });

  test("parses documents produced by plutil", async () => {
    const source = { alpha: "a&b", beta: [1, 2.5, false], gamma: { deep: "x" } };

    const dir = await mkdtemp(join(tmpdir(), "rork-plist-"));
    try {
      const jsonPath = join(dir, "doc.json");
      await writeFile(jsonPath, JSON.stringify(source));
      const { stdout } = await execFileAsync("plutil", ["-convert", "xml1", "-o", "-", jsonPath]);

      expect(parsePlist(stdout)).toEqual(source);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
