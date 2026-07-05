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
 */
/* oxlint-disable no-console -- printing results to stdout is this script's output */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import expoPlistModule from "@expo/plist";
import bplistCreator from "bplist-creator";
import bplistParser from "bplist-parser";
import {
  build as plistBuild,
  buildBinary as plistBuildBinary,
  parse as plistParse,
  parseBinary as plistParseBinary,
} from "plist";

import { buildBinaryPlist, buildPlist, parseBinaryPlist, parsePlist } from "../dist/index.js";

// @expo/plist ships a CommonJS default export that ESM sees double-wrapped.
const expoPlist = expoPlistModule.default ?? expoPlistModule;

/** Deterministic pseudo-random bytes, as a Buffer so every library accepts them. */
function bytes(length, seed) {
  const out = Buffer.alloc(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = state & 0xff;
  }
  return out;
}

const shapes = {
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

/** Produces plutil-canonical fixture bytes on darwin, our own output elsewhere. */
function makeFixtures() {
  const fixtures = {};
  if (process.platform === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "rork-plist-compare-"));
    try {
      for (const [name, value] of Object.entries(shapes)) {
        const path = join(dir, "doc.plist");
        writeFileSync(path, buildPlist(value));
        execFileSync("plutil", ["-convert", "binary1", path]);
        const binary = new Uint8Array(readFileSync(path));
        execFileSync("plutil", ["-convert", "xml1", path]);
        const xml = readFileSync(path, "utf8");
        fixtures[name] = { value, xml, binary };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    console.log("plutil is unavailable off macOS; fixtures use this library's writers\n");
    for (const [name, value] of Object.entries(shapes)) {
      fixtures[name] = { value, xml: buildPlist(value), binary: buildBinaryPlist(value) };
    }
  }
  return fixtures;
}

function batchNsPerOp(fn, iterations) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  return Number(process.hrtime.bigint() - start) / iterations;
}

function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

const BATCHES = 15;
const TARGET_BATCH_NS = 60e6;

/** Runs `[label, fn]` entries interleaved and returns `[label, nsPerOp]` pairs. */
function compare(entries) {
  const calibrated = entries.map(([label, fn]) => {
    fn();
    const pilot = batchNsPerOp(fn, 3);
    const iterations = Math.max(3, Math.min(30_000, Math.round(TARGET_BATCH_NS / pilot)));
    batchNsPerOp(fn, Math.max(3, iterations >> 2));
    return { fn, iterations, label, samples: [] };
  });
  for (let batch = 0; batch < BATCHES; batch++) {
    for (const entry of calibrated) {
      entry.samples.push(batchNsPerOp(entry.fn, entry.iterations));
    }
  }
  return calibrated.map(({ label, samples }) => [label, median(samples)]);
}

function formatTime(ns) {
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
const summary = new Map();

for (const [name, { value, xml, binary }] of Object.entries(fixtures)) {
  const buf = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);

  const operations = [
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
        ["plist", () => plistBuild(value)],
        ["@expo/plist", () => expoPlist.build(value)],
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
        ["plist", () => plistBuildBinary(value)],
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
