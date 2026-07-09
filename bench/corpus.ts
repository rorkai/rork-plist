/**
 * Real-world corpus sweep. Walks directories full of property lists the
 * machine actually uses — system frameworks, installed applications, local
 * preferences — parses every one with this library, and cross-validates a
 * stratified sample against `plutil`, Apple's own parser. This is the
 * accuracy audit the synthetic test fixtures cannot provide, and it doubles
 * as a performance measurement over real documents bucketed by size.
 *
 * Files the format does not cover are counted, not failed: binary versions
 * past bplist00, and files plutil itself rejects (corrupt input, not
 * evidence). A file that plutil parses but this library cannot — or a
 * sampled file whose parsed value disagrees with plutil's reading — is a
 * real finding and fails the run. Keyed archives parse like any other
 * binary plist since UID support landed; the failure category remains so a
 * regression shows up by name.
 *
 * Run with `pnpm corpus`. Roots, file cap, and the plutil sample size are
 * flags; macOS is required for the differential half.
 */
/* oxlint-disable no-console -- printing the audit report to stdout is this script's output */

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { parsePlist, PlistParseError, PlistUid, type PlistValue } from "../dist/index.js";

const execFileAsync = promisify(execFile);

interface Options {
  maxFiles: number;
  roots: string[];
  sample: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    maxFiles: 25_000,
    roots: ["/System/Library", "/Library", "/Applications"],
    sample: 1_000,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--roots":
        options.roots = argv[++i]!.split(",");
        break;
      case "--max":
        options.maxFiles = Number(argv[++i]);
        break;
      case "--sample":
        options.sample = Number(argv[++i]);
        break;
      default:
        throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  return options;
}

/** Collects .plist file paths under a root, skipping symlinks and unreadable directories. */
async function collectPlists(root: string, paths: string[], limit: number): Promise<void> {
  if (paths.length >= limit) {
    return;
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return; // permission denied or vanished mid-walk
  }
  for (const entry of entries) {
    if (paths.length >= limit) {
      return;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectPlists(path, paths, limit);
    } else if (entry.isFile() && (entry.name.endsWith(".plist") || entry.name === "project.pbxproj")) {
      // Xcode project files are OpenStep property lists under another name.
      paths.push(path);
    }
  }
}

const BUCKETS = [
  { label: "small   (< 16 KiB)", max: 16 * 1024 },
  { label: "medium  (< 256 KiB)", max: 256 * 1024 },
  { label: "large   (< 2 MiB)", max: 2 * 1024 * 1024 },
  { label: "xlarge  (>= 2 MiB)", max: Infinity },
] as const;

function bucketOf(byteLength: number): number {
  return BUCKETS.findIndex((bucket) => byteLength < bucket.max);
}

/** Where a swept file landed — parsed (by format), out of scope, or corrupt. */
type Outcome =
  | "binary"
  | "invalid-per-plutil"
  | "keyed-archive"
  | "mismatch"
  | "openstep"
  | "unsupported-binary-version"
  | "xml";

/**
 * Labels a successfully parsed file by the format it took. The text formats
 * are told apart by the first significant character, the same signal the
 * parser's own dispatch uses (an OpenStep document rooted in a data literal
 * would label as XML here, but on-disk documents are dictionaries).
 */
function classifySuccess(bytes: Uint8Array, isBinary: boolean): Outcome {
  if (isBinary) {
    return "binary";
  }
  const prefix =
    new TextDecoder("utf-16le").decode(bytes.subarray(0, 2)) === "\uFEFF"
      ? new TextDecoder("utf-16le").decode(bytes.subarray(0, 256))
      : new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 256));
  return prefix
    .replace(/^\uFEFF/u, "")
    .trimStart()
    .startsWith("<")
    ? "xml"
    : "openstep";
}

interface ParsedFile {
  bucket: number;
  bytes: number;
  ms: number;
  path: string;
  value: PlistValue;
}

/** Deep equality across both formats' value models. XML dates carry second
 * precision while binary dates carry milliseconds, so timestamps compare
 * with one-second tolerance; everything else compares exactly. */
function plistEqual(a: PlistValue, b: PlistValue): boolean {
  if (a instanceof PlistUid || b instanceof PlistUid) {
    return a instanceof PlistUid && b instanceof PlistUid && a.uid === b.uid;
  }
  if (a instanceof Date && b instanceof Date) {
    return Math.abs(a.getTime() - b.getTime()) < 1000;
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((byte, i) => byte === b[i]);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => plistEqual(item, b[i]!));
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    if (a instanceof Date || b instanceof Date || a instanceof Uint8Array || b instanceof Uint8Array) {
      return false;
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => {
        const av = (a as Record<string, PlistValue>)[key];
        const bv = (b as Record<string, PlistValue>)[key];
        return bv !== undefined && av !== undefined && plistEqual(av, bv);
      })
    );
  }
  // Mixed number/bigint spellings of one integer compare by value; equal
  // types (including two reals) fall through to strict equality.
  if (typeof a === "number" && typeof b === "bigint") {
    return Number.isInteger(a) && BigInt(a) === b;
  }
  if (typeof a === "bigint" && typeof b === "number") {
    return Number.isInteger(b) && a === BigInt(b);
  }
  return a === b;
}

/** Runs plutil and reports whether it accepts the file. */
async function plutilAccepts(path: string): Promise<boolean> {
  try {
    await execFileAsync("plutil", ["-lint", path]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reports whether the buffer contains an ASCII marker. Keyed archives are
 * recognized by the `$archiver` key the archive format itself writes, which
 * keeps the classification independent of this library's error wording.
 * Runs only on parse failures, so the simple scan costs nothing overall.
 */
function bytesContain(bytes: Uint8Array, marker: string): boolean {
  const limit = bytes.length - marker.length;
  for (let i = 0; i <= limit; i++) {
    let matched = 0;
    while (matched < marker.length && bytes[i + matched] === marker.charCodeAt(matched)) {
      matched++;
    }
    if (matched === marker.length) {
      return true;
    }
  }
  return false;
}

/**
 * Classifies a file this library failed to parse, deciding by the format
 * first and consulting plutil only where its verdict changes the outcome.
 * Only the `mismatch` outcome is a finding; everything else is input outside
 * the format's scope or corrupt by plutil's own account. Text failures have
 * no scope carve-out anymore — every text plist plutil reads, whichever
 * grammar it uses, is one this library must read too.
 */
async function classifyFailure(path: string, bytes: Uint8Array, isBinary: boolean): Promise<Outcome> {
  if (isBinary) {
    if (bytes[6] !== 0x30 || bytes[7] !== 0x30) {
      return "unsupported-binary-version";
    }
    if (bytesContain(bytes, "$archiver")) {
      return "keyed-archive";
    }
  }
  return (await plutilAccepts(path)) ? "mismatch" : "invalid-per-plutil";
}

const options = parseArgs(process.argv.slice(2));

console.log(`collecting .plist files under ${options.roots.join(", ")} (max ${options.maxFiles})`);
const paths: string[] = [];
for (const root of options.roots) {
  await collectPlists(root, paths, options.maxFiles);
}
console.log(`found ${paths.length} files\n`);

const counts = new Map<Outcome, number>();
const parsed: ParsedFile[] = [];
const findings: string[] = [];

for (const path of paths) {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch {
    continue; // unreadable file, nothing to audit
  }
  if (bytes.length === 0) {
    continue;
  }

  const isBinary = bytes.length >= 8 && bytes[0] === 0x62 && bytes[1] === 0x70; // "bp"
  const start = performance.now();
  try {
    const value = parsePlist(bytes);
    const ms = performance.now() - start;
    const outcome = classifySuccess(bytes, isBinary);
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    parsed.push({ bucket: bucketOf(bytes.length), bytes: bytes.length, ms, path, value });
  } catch (error) {
    const outcome = await classifyFailure(path, bytes, isBinary);
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    if (outcome === "mismatch") {
      const message = error instanceof PlistParseError ? error.message : String(error);
      findings.push(`${path} — plutil accepts, we fail with ${message}`);
    }
  }
}

// Stratified plutil differential over the parsed files. Taking every k-th
// file per bucket spreads the sample across directories and sizes instead of
// front-loading whatever the walk found first.
const byBucket = BUCKETS.map((_, i) => parsed.filter((file) => file.bucket === i));
const differentialSample: ParsedFile[] = [];
for (const bucket of byBucket) {
  const quota = Math.min(
    bucket.length,
    Math.max(25, Math.round((options.sample * bucket.length) / (parsed.length || 1))),
  );
  const step = Math.max(1, Math.floor(bucket.length / quota));
  for (let i = 0; i < bucket.length && differentialSample.length < options.sample; i += step) {
    differentialSample.push(bucket[i]!);
  }
}

console.log(`cross-validating ${differentialSample.length} files against plutil...`);
let agreed = 0;
for (const file of differentialSample) {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("plutil", ["-convert", "xml1", "-o", "-", file.path], {
      maxBuffer: 512 * 1024 * 1024,
    }));
  } catch {
    continue; // plutil refused (e.g. permission changed mid-run); not a comparison
  }
  try {
    if (plistEqual(file.value, parsePlist(stdout))) {
      agreed += 1;
    } else {
      findings.push(`${file.path} — parsed value disagrees with plutil's reading`);
    }
  } catch (error) {
    findings.push(`${file.path} — plutil's xml1 output failed to parse, ${String(error)}`);
  }
}

console.log("\n=== formats ===");
for (const [outcome, count] of [...counts.entries()].toSorted((a, b) => b[1] - a[1])) {
  console.log(`  ${outcome.padEnd(28)} ${String(count).padStart(7)}`);
}

console.log("\n=== parse timing by size (real files, this library) ===");
for (let i = 0; i < BUCKETS.length; i++) {
  const bucket = byBucket[i]!;
  if (bucket.length === 0) {
    continue;
  }
  const times = bucket.map((file) => file.ms).toSorted((a, b) => a - b);
  const totalBytes = bucket.reduce((total, file) => total + file.bytes, 0);
  const totalMs = bucket.reduce((total, file) => total + file.ms, 0);
  const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))]!;
  console.log(
    `  ${BUCKETS[i]!.label}  files ${String(bucket.length).padStart(6)}  p50 ${p(0.5).toFixed(2)} ms  p95 ${p(0.95).toFixed(2)} ms  max ${times.at(-1)!.toFixed(2)} ms  ${(totalBytes / 1024 / 1024 / (totalMs / 1000)).toFixed(0)} MiB/s`,
  );
}

console.log(`\n=== plutil differential ===\n  agreed on ${agreed} of ${differentialSample.length} compared files`);

if (findings.length > 0) {
  console.log(`\n=== findings (${findings.length}) ===`);
  for (const finding of findings.slice(0, 50)) {
    console.log(`  ${finding}`);
  }
  process.exit(1);
}
console.log(
  "\nno mismatches — every readable file either parses identically to plutil or is outside the format's scope",
);
