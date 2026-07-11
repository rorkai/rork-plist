# Roadmap

This document tracks where rork-plist goes next and, just as importantly, what
it will not do. Every item follows the project's working method: behavior is
specified by what Apple's own tooling does (`plutil`, CoreFoundation), verified
empirically, and protected by tests and benchmarks before it ships.

## Where the library stands (v0.4.0)

- Parses and builds all three plist formats — XML (UTF-8 and UTF-16), binary
  `bplist00`, and OpenStep — from a single zero-dependency artifact that
  behaves identically in every JavaScript runtime.
- A sweep of 25,000 real macOS plist files parses everything in scope, and a
  1,000-file differential against `plutil` agrees on 1,000. The only files
  outside scope today are 9 keyed archives, which fail on their UID objects.
- Fastest measured parse and build times across the popular npm plist packages
  in both XML and binary (see the Performance section of the README).
- 10.8 kB minified+gzipped for the whole package; tree-shaking reduces that to
  7.4 kB for `parsePlist` alone and about 2 kB for a single builder.

## Shipped

### UID values — the last format gap (merged, ships in 0.6.0)

Keyed archives now parse like any other binary plist. `PlistUid` carries the
object-table index, the binary parser and builder handle the `0x8x` marker
with the platform's own width rules, and XML round-trips the `CF$UID`
dictionary shape both ways. The corpus sweep parses all 25,000 real files
with the `plutil` differential agreeing 1000 of 1000, and an interleaved A/B
against the previous release shows the recognition costs nothing measurable
on documents without UIDs.

## Planned

`bplist00` files written by NSKeyedArchiver (Dock preferences, Xcode UI state,
many `com.apple.*` caches) contain UID objects, marker byte `0x8x`. The parser
currently rejects them; `plutil` does not. This is the one remaining class of
real-world files the library cannot read — 9 of 25,000 in the corpus sweep.

Scope:

- Add a `PlistUid` value to the model carrying the unsigned index.
- Parse the `0x8x` marker in the binary parser; build it back in the binary
  builder so keyed archives round-trip losslessly.
- Decide the XML and OpenStep representations by probing `plutil -convert`
  on UID-bearing fixtures first, then match its output exactly. (Expected from
  prior observation: XML renders a UID as a one-key `CF$UID` integer
  dictionary; confirm before implementing.)
- Corpus sweep must reclassify keyed archives from "outside scope" to parsed,
  and the `plutil` differential must keep agreeing.

Acceptance: every plist `plutil` reads, this library reads.

### 2. Keyed-archive resolution helper (target: 0.7.0)

Parsing UIDs yields the raw archive graph: a `$objects` table, a `$top` entry
point, and UID references between them. Reading the actual data still requires
understanding that encoding. A `resolveKeyedArchive()` helper that follows
`$top` through `$objects` and replaces UIDs with the values they reference
would make these files directly usable.

Design questions to settle during implementation, against Foundation's own
unarchiving behavior: how to surface `$class` metadata, how to represent
shared references, and whether cycles resolve to shared objects or fail with
a clear error. Ships as a separate release so the UID model can stabilize
first.

### 3. Continuous accuracy protection in CI

The accuracy claims are currently re-verified by running the corpus sweep and
fuzzer by hand. CI should hold that line on every pull request:

- A structure-aware fuzzer for the binary parser (the OpenStep grammar fuzzer
  already exists in the test suite; the binary format deserves the same).
- A macOS job that runs the `plutil` differential over committed fixtures,
  so grammar drift between this library and the platform is caught at review
  time rather than at the next manual sweep.

### 4. Document the bundle-size story in the README

Measured numbers worth publishing alongside the performance chart: 10.8 kB
gzipped for all three formats in both directions, 7.4 kB tree-shaken for
`parsePlist`, roughly 2 kB for a single builder. The comparison matters
because headline sizes elsewhere can hide platform-conditional entry points
that delegate XML parsing to the host browser — the same packages cost several
times more where a bundled parser actually runs, and per-environment entry
points are exactly what this library refuses to have.

### 5. Export `detectPlistFormat()`

The format-sniffing logic that `parsePlist` uses for dispatch is useful on its
own; downstream code keeps reimplementing flavors of it. Export a small
`detectPlistFormat(input): "xml" | "binary" | "openstep"` with a documented
contract: it reports which parser `parsePlist` would dispatch to, without
parsing. Binary detection is exact (magic bytes); text detection follows the
dispatch heuristic — text that is not XML is OpenStep by construction.

## Investigated: very large file throughput (July 2026)

The sweep's "77 MiB/s for files ≥ 2 MiB" broke down into three separate
findings once profiled:

- **The sweep number was pessimistic.** Corpus timings are single shots taken
  while carrying garbage-collector debt from thousands of earlier files;
  steady-state throughput on the same worst files measured about twice the
  sweep figure.
- **Data-heavy XML was genuinely slow, and is now fixed.** Profiles of the
  slowest XML files (security allowlists full of 20-byte hash `<data>`
  elements) showed over half the parse inside base64 validation: two
  regular-expression passes, a whitespace-stripped copy of the input, a
  pooled native buffer, and a copy out of the pool — fixed costs paid tens of
  thousands of times for 34-character payloads. Short inputs now decode on a
  single-pass scratch-buffer path that validates and decodes together and
  falls back to the general path for anything irregular, so all rejection
  messages still come from one place. The worst files improved from
  14.7 ms to 8.0 ms and from 24.1 ms to 9.7 ms (roughly 250 MiB/s), with the
  cross-library benchmarks, the full test suite, and the `plutil`
  differential all unchanged.
- **Large payloads decode through the standard codec where it exists.** The
  ECMAScript `Uint8Array.fromBase64` API validates and decodes in one native
  pass; on engines that ship it, a synthetic 6.5 MiB data-heavy document
  parses in 0.9 ms versus 7.7 ms through the `Buffer` path. The codec now
  tiers per input — small-input fast path, standard codec, `Buffer`,
  portable JavaScript — with identical observable behavior everywhere,
  pinned by probing and a seeded differential test. Base64 whitespace was
  aligned to ASCII whitespace (form feed included) to match both the
  standard codec and the platform parser; rejected input always re-reports
  through the library's own validation so error types and messages never
  vary by host. Stock Node does not ship the API yet, so its hot paths are
  unchanged until it does.
- **Binary emoji-index files are paying for the object model, not the
  parser.** The slowest binary files hold ~63,000 tiny dictionaries keyed by
  sparse numeric strings, a shape that forces V8 into dictionary-mode
  property stores; a store-free instrumented parse of the same file runs
  25% faster, bounding what any parser-side work could recover. Producing
  plain JavaScript objects is the library's contract, so this cost stays.

## Non-goals

- **`bplist15` / `bplist16`.** Zero occurrences in 25,000 real files. The
  platform's own writers emit `bplist00`. Revisit only with evidence.
- **A type parameter on `parsePlist<T>()`.** It would be a cast wearing a
  costume. Callers who know the document shape should write `as T` at the
  call site, where the assumption is visible.
- **Per-environment entry points.** Delegating XML parsing to a host
  `DOMParser` in browsers would shrink the headline bundle number at the cost
  of engine-dependent behavior, weaker validation, and runtimes with no DOM at
  all. One artifact, identical behavior everywhere, is the contract.
- **Comment- and whitespace-preserving parsing.** Round-trip source editing
  (as needed for `project.pbxproj` files) is a different contract from value
  parsing, with its own trivia model and emission conventions. It belongs in
  a dedicated tool, not in the value parser.
- **Streaming APIs.** Property lists are whole-document formats; the binary
  format's offset table sits at the end of the file. Incremental parsing has
  no correct implementation worth shipping.
