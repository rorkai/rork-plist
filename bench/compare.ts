/**
 * Cross-library benchmark comparing rork-plist with the most-used plist
 * packages on npm — plist (v5, XML + binary), @expo/plist (XML), and
 * bplist-parser / bplist-creator (binary). Run it with `pnpm bench:compare`,
 * which builds first so the measured artifact is the published one.
 *
 * Fixtures are the three representative document shapes from the main bench
 * suite. On macOS every fixture is canonicalized by `plutil`, Apple's own
 * encoder, so no parser reads its own writer's output; elsewhere the fixtures
 * fall back to this library's writers and a note is printed.
 *
 * Each operation runs as interleaved round-robin batches (library A, B, C,
 * then A again) so JIT tiering, garbage collection, and thermal drift hit
 * every library equally. The reported figure is the median batch, in
 * nanoseconds per operation. Before timing, every library must round-trip
 * the fixture it is measured on.
 *
 * The script runs as TypeScript directly through Node's native type
 * stripping, which is on by default in Node 22.18 and later.
 */
/* oxlint-disable no-console -- printing results to stdout is this script's output */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  build as plistBuild,
  buildBinary as plistBuildBinary,
  parse as plistParse,
  parseBinary as plistParseBinary,
  parseOpenStep as plistParseOpenStep,
  type PlistValue as PlistPackageValue,
} from "plist";

import {
  buildBinaryPlist,
  buildPlist,
  parseBinaryPlist,
  parseOpenStepPlist,
  parsePlist,
  type PlistValue,
} from "../dist/index.js";

// The remaining three libraries are CommonJS without usable ESM-facing types
// (@expo/plist ships declarations that miss its double-wrapped default
// export; the bplist packages ship none), so they load through require and
// are typed here at the boundary.
const require = createRequire(import.meta.url);

const expoPlist = (
  require("@expo/plist") as {
    default: { build(value: unknown): string; parse(xml: string): unknown };
  }
).default;

const bplistParser = require("bplist-parser") as {
  parseBuffer(buffer: Buffer | Uint8Array): unknown[];
};

const bplistCreator = require("bplist-creator") as (value: unknown) => Buffer;

/** Deterministic pseudo-random bytes, as a Buffer so every library accepts them. */
function bytes(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = state & 0xff;
  }
  return out;
}

const shapes: Record<string, PlistValue> = {
  "auth response": {
    Status: { ec: 0, ed: "Success", "server-info": "1.0" },
    spd: bytes(512, 1),
    np: "8874100170514355861",
    "session-token": bytes(256, 2),
    created: new Date("2026-07-04T10:20:30Z"),
  },
  "device list": {
    devices: Array.from({ length: 500 }, (_, i) => ({
      deviceId: `DEVICE${i.toString(16).toUpperCase().padStart(8, "0")}`,
      name: `Device ${i} & Co <primary>`,
      deviceNumber: `00008150-${i.toString(16).padStart(12, "0")}`,
      model: "iPhone17,1",
      enabled: i % 3 !== 0,
      addedDate: new Date(1_700_000_000_000 + i * 86_400_000),
    })),
  },
  "profile (data-heavy)": {
    AppIDName: "Development Profile",
    ExpirationDate: new Date("2027-07-04T00:00:00Z"),
    DeveloperCertificates: [bytes(1600, 3), bytes(1600, 4), bytes(1600, 5)],
    "der-encoded-profile": bytes(500_000, 6),
    TimeToLive: 365,
    Version: 1,
  },
};

/** One document shape with its canonical XML, binary, and OpenStep encodings. */
interface Fixture {
  binary: Uint8Array;
  openStep: string;
  value: PlistValue;
  xml: string;
}

/**
 * Serializes a fixture value as OpenStep text, purely for this benchmark —
 * the library ships no OpenStep writer because the platform tooling has
 * none either, so the fixture is produced here and, on macOS, validated
 * through `plutil -lint` before timing. The format is untyped, so scalars
 * become quoted strings and binary payloads become hex data; JSON string
 * quoting is escape-compatible for the printable-ASCII content the fixtures
 * use.
 */
function buildOpenStepPlist(value: PlistValue): string {
  if (value instanceof Uint8Array) {
    return `<${[...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")}>`;
  }
  if (Array.isArray(value)) {
    return `(${value.map(buildOpenStepPlist).join(", ")})`;
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(
      ([key, entry]) => `${JSON.stringify(key)} = ${buildOpenStepPlist(entry!)};`,
    );
    return `{ ${entries.join(" ")} }`;
  }
  return JSON.stringify(String(value));
}

/** Produces plutil-canonical fixture bytes on darwin, our own output elsewhere. */
function makeFixtures(): Record<string, Fixture> {
  const fixtures: Record<string, Fixture> = {};
  if (process.platform === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "rork-plist-compare-"));
    try {
      for (const [name, value] of Object.entries(shapes)) {
        const path = join(dir, "doc.plist");
        const openStep = buildOpenStepPlist(value);
        writeFileSync(path, openStep);
        execFileSync("plutil", ["-lint", path]);
        writeFileSync(path, buildPlist(value));
        execFileSync("plutil", ["-convert", "binary1", path]);
        const binary = new Uint8Array(readFileSync(path));
        execFileSync("plutil", ["-convert", "xml1", path]);
        const xml = readFileSync(path, "utf8");
        fixtures[name] = { binary, openStep, value, xml };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    console.log("plutil is unavailable off macOS; fixtures use this library's writers\n");
    for (const [name, value] of Object.entries(shapes)) {
      fixtures[name] = {
        binary: buildBinaryPlist(value),
        openStep: buildOpenStepPlist(value),
        value,
        xml: buildPlist(value),
      };
    }
  }
  return fixtures;
}

function batchNsPerOp(fn: () => unknown, iterations: number): number {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  return Number(process.hrtime.bigint() - start) / iterations;
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
}

const BATCHES = 15;
const TARGET_BATCH_NS = 60e6;

type Entry = [label: string, fn: () => unknown];
type Result = [label: string, nsPerOp: number];

/** Runs the entries interleaved and returns nanoseconds per operation each. */
function compare(entries: Entry[]): Result[] {
  const calibrated = entries.map(([label, fn]) => {
    fn();
    const pilot = batchNsPerOp(fn, 3);
    const iterations = Math.max(3, Math.min(30_000, Math.round(TARGET_BATCH_NS / pilot)));
    batchNsPerOp(fn, Math.max(3, iterations >> 2));
    return { fn, iterations, label, samples: [] as number[] };
  });
  for (let batch = 0; batch < BATCHES; batch++) {
    for (const entry of calibrated) {
      entry.samples.push(batchNsPerOp(entry.fn, entry.iterations));
    }
  }
  return calibrated.map(({ label, samples }) => [label, median(samples)]);
}

function formatTime(ns: number): string {
  if (ns < 1e3) {
    return `${ns.toFixed(0)} ns`;
  }
  if (ns < 1e6) {
    return `${(ns / 1e3).toFixed(1)} µs`;
  }
  return `${(ns / 1e6).toFixed(2)} ms`;
}

const fixtures = makeFixtures();

/** Geometric-mean multiplier vs rork-plist per operation, printed at the end. */
const summary = new Map<string, number[]>();

for (const [name, { binary, openStep, value, xml }] of Object.entries(fixtures)) {
  const buf = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);
  // The fixtures avoid the corners where the value models differ (no bigint,
  // and data payloads are Buffers), so one runtime value serves every library.
  const foreignValue = value as PlistPackageValue;

  const operations: [operation: string, entries: Entry[]][] = [
    [
      "parse XML",
      [
        ["rork-plist", () => parsePlist(xml)],
        ["plist", () => plistParse(xml)],
        ["@expo/plist", () => expoPlist.parse(xml)],
      ],
    ],
    [
      "build XML",
      [
        ["rork-plist", () => buildPlist(value)],
        ["plist", () => plistBuild(foreignValue)],
        ["@expo/plist", () => expoPlist.build(value)],
      ],
    ],
    [
      "parse OpenStep",
      [
        ["rork-plist", () => parseOpenStepPlist(openStep)],
        ["plist", () => plistParseOpenStep(openStep)],
      ],
    ],
    [
      "parse binary",
      [
        ["rork-plist", () => parseBinaryPlist(binary)],
        ["rork-plist (data: view)", () => parseBinaryPlist(binary, { data: "view" })],
        ["plist", () => plistParseBinary(binary)],
        ["bplist-parser", () => bplistParser.parseBuffer(buf)],
      ],
    ],
    [
      "build binary",
      [
        ["rork-plist", () => buildBinaryPlist(value)],
        ["plist", () => plistBuildBinary(foreignValue)],
        ["bplist-creator", () => bplistCreator(value)],
      ],
    ],
  ];

  console.log(
    `\n=== ${name} — XML ${(xml.length / 1024).toFixed(1)} KiB, binary ${(binary.length / 1024).toFixed(1)} KiB ===`,
  );
  for (const [operation, entries] of operations) {
    const results = compare(entries);
    const best = Math.min(...results.map(([, ns]) => ns));
    // The like-for-like baseline is our fastest mode for the operation. For
    // binary parse that is `data: "view"`, which matches the aliasing
    // semantics every other binary parser here uses unconditionally.
    const baseline = Math.min(...results.filter(([label]) => label.startsWith("rork-plist")).map(([, ns]) => ns));
    console.log(`  ${operation}`);
    for (const [label, ns] of results) {
      const marker = ns === best ? "fastest" : `${(ns / best).toFixed(2)}x slower`;
      console.log(`    ${label.padEnd(24)} ${formatTime(ns).padStart(9)}  ${marker}`);
      if (!label.startsWith("rork-plist")) {
        const key = `${operation} | ${label}`;
        const entry = summary.get(key) ?? [];
        entry.push(ns / baseline);
        summary.set(key, entry);
      }
    }
  }
}

console.log("\n=== geometric mean vs rork-plist across the three documents ===");
for (const [key, multipliers] of summary) {
  const geometricMean = Math.exp(multipliers.reduce((total, m) => total + Math.log(m), 0) / multipliers.length);
  console.log(`  ${key.padEnd(38)} ${geometricMean.toFixed(2)}x`);
}
