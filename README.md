# rork-plist

[![CI](https://github.com/rorkai/rork-plist/actions/workflows/ci.yml/badge.svg)](https://github.com/rorkai/rork-plist/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/rork-plist)](https://www.npmjs.com/package/rork-plist)

Zero-dependency Apple plist parser and builder for any JavaScript runtime: browsers, Node.js, Bun, Electron, Cloudflare Workers, and React Native.

```ts
import { readFile } from "node:fs/promises";
import { parsePlist, buildPlist } from "rork-plist";

const value = parsePlist(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>name</key>
	<string>Rork</string>
	<key>payload</key>
	<data>AQL+</data>
</dict>
</plist>`);
// { name: "Rork", payload: Uint8Array [1, 2, 254] }

const xml = buildPlist({ device: "iPhone17,1", enabled: true });

// A buffer is auto-detected: binary bplist00, otherwise UTF-8 XML.
const fromBundle = parsePlist(await readFile("Info.plist")); // Uint8Array in, value out
```

> The `await` above runs at the top level of an ESM module; inside CommonJS or a function, wrap it in an `async` function.

## Why

Property lists are the wire format of Apple's ecosystem — authentication exchanges, provisioning profiles, device services, project metadata. Code that speaks those protocols increasingly runs everywhere at once: a web app in the browser, an API on an edge runtime, a desktop app's Node process, a CLI inside a sandbox.

`rork-plist` is designed for exactly that situation:

- **Zero dependencies.** The plist grammar is a small, closed vocabulary defined by the [PropertyList-1.0 DTD](https://www.apple.com/DTDs/PropertyList-1.0.dtd). It does not need a general-purpose XML stack; a dedicated scanner is smaller, faster, and immune to entity-expansion attacks by construction. Binary plists decode straight from a `DataView` with no native addon or WASM blob.
- **One artifact, one code path.** A single ESM file with named exports. No environment-conditional entry points, no CommonJS default-export ambiguity, no reliance on ambient globals like `DOMParser` or `Buffer`. What you test locally is what runs in production, whatever the bundler.
- **`Uint8Array` native.** `<data>` parses to `Uint8Array` and any `ArrayBufferView` serializes from exactly its view window — never its whole backing buffer, so subarray views into larger protocol buffers encode correctly.
- **Loud failure modes.** Corrupt base64, malformed numbers, unbalanced markup, unrepresentable values — everything fails with a typed error carrying position (parse) or value-path (build) context. Payloads are never silently truncated or dropped.

## Install

```sh
pnpm add rork-plist
```

## API

### `parsePlist(input, options?)`

Parses a property list into JavaScript values. `input` is `string | Uint8Array`:

- a **string** is parsed as XML;
- a **`Uint8Array`** is parsed as binary when it carries the `bplist00` magic, and otherwise decoded as UTF-8 and parsed as XML.

XML accepts complete documents (XML declaration, DOCTYPE, `<plist>` wrapper) as well as bare root elements.

```ts
import { parsePlist, PlistParseError } from "rork-plist";

try {
  const value = parsePlist(input); // XML string, or bytes of either format
} catch (error) {
  if (error instanceof PlistParseError) {
    console.error(error.message); // "unknown element <widget> (line 4, column 2)"
    console.error(error.position); // { offset, line, column }
  }
}
```

### `parseBinaryPlist(bytes, options?)`

Parses a binary (`bplist00`) property list explicitly, skipping the format sniffing `parsePlist` does. Use it when you already know the input is binary; otherwise `parsePlist` handles both.

Both parsers accept the same options:

| Option     | Default  | Description                                                                                                                                                                     |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`     | `"copy"` | How binary `<data>` payloads relate to the input buffer: `"copy"` gives payloads that own their memory; `"view"` gives `subarray` views that alias the input and skip the copy. |
| `maxDepth` | `512`    | Maximum `<dict>`/`<array>` nesting before parsing fails; bounds stack growth and, for binary, caps reference cycles.                                                            |

Use `data: "view"` to pull fields out of a large document you control and will not mutate — parsing a data-heavy document this way runs at the cost of the scan alone, with zero payload copying. The default stays `"copy"` because views cut both ways: writing through one corrupts the source bytes, and retaining one keeps the entire input buffer alive.

### `buildPlist(value, options?)`

Serializes a value as a complete XML property list document.

```ts
import { buildPlist, PlistBuildError } from "rork-plist";

buildPlist({ token: new Uint8Array([1, 2, 254]) });
buildPlist(largeDocument, { indent: false }); // single-line body
```

Options:

| Option   | Default | Description                                          |
| -------- | ------- | ---------------------------------------------------- |
| `indent` | `"\t"`  | Indentation unit, or `false` for a single-line body. |

A dictionary key whose value is `undefined` is omitted, matching `JSON.stringify`, so optional and conditionally-set fields need no manual stripping. `PlistBuildError` names the path of the offending value (for example `$.profiles[2].name`) when a value otherwise has no property list representation: `null`, `undefined` outside a dictionary value (a root or array `undefined`, since dropping an array element would shift indices), functions, class instances, `NaN`, infinities, lone surrogates, or characters XML 1.0 cannot carry.

### `buildBinaryPlist(value)`

Serializes a value as a binary (`bplist00`) property list, returning a `Uint8Array`. Scalars (including repeated dictionary keys) are deduplicated so the output stays compact. The value-model rules are identical to `buildPlist`, with two format-driven differences: dates keep full millisecond precision (binary stores a raw timestamp), and there is no four-digit-year limit. Circular references are detected and rejected.

```ts
import { buildBinaryPlist } from "rork-plist";

const bytes = buildBinaryPlist({ device: "iPhone17,1", enabled: true });
```

### `encodeBase64(bytes)` / `decodeBase64(text)`

The strict RFC 4648 codec used for `<data>` elements, exported because protocol code usually needs one. `decodeBase64` tolerates whitespace and omitted padding but rejects everything else.

## Value mapping

The mapping is identical for XML and binary input. `Date` values keep millisecond precision from binary, second precision from XML.

| Plist element         | JavaScript value                                       |
| --------------------- | ------------------------------------------------------ |
| `<string>`, `<key>`   | `string`                                               |
| `<integer>`           | `number`, or `bigint` beyond `Number.MAX_SAFE_INTEGER` |
| `<real>`              | `number`                                               |
| `<true/>`, `<false/>` | `boolean`                                              |
| `<date>`              | `Date` (UTC)                                           |
| `<data>`              | `Uint8Array`                                           |
| `<array>`             | `PlistValue[]`                                         |
| `<dict>`              | plain object, keys in document order                   |

## Behavior notes

Parsing follows the grammar accepted by Apple's own tooling; the test suite cross-validates generated and parsed documents against the platform plist utility on macOS.

- **Binary plists** (`bplist00`) are supported both ways: `parsePlist` auto-detects binary vs. XML from a buffer (or use `parseBinaryPlist`), and `buildBinaryPlist` emits binary while `buildPlist` emits XML. On read, UID objects (used by keyed archives, not plain property lists) are rejected and sets are widened to arrays, matching the platform tooling; an object referenced from several places resolves to one shared instance, as the reference reader does. On write, dates keep millisecond precision and are not limited to four-digit years, unlike the XML text format.

- **64-bit integers.** `<integer>` covers the full signed/unsigned 64-bit window `[-(2^63), 2^64 - 1]`; values beyond that fail to parse and to build. Values that exceed `Number.MAX_SAFE_INTEGER` parse as `bigint`, so identifiers and tokens never lose precision silently. Hexadecimal spellings (`0x1F`, `-0x10`) parse like the reference implementation.
- **Reals.** `nan`, `inf`, `-inf`, and `infinity` spellings parse to the corresponding IEEE 754 values. Building rejects `NaN` and infinities — emitting them is almost always a caller bug in the protocols this library serves.
- **Dates.** The wire layout is second-precision UTC (`2026-07-04T10:20:30Z`) — the only layout the reference parser accepts. Building truncates sub-second time.
- **Data.** Corrupt base64 raises `PlistParseError` instead of decoding to a truncated payload. Empty data serializes as `<data></data>`, the form the reference parser accepts.
- **Dictionaries.** Duplicate keys resolve to the last occurrence, matching the reference parser. A literal `__proto__` key becomes an own property; parsing untrusted documents cannot pollute prototypes. Building omits keys whose value is `undefined` (like `JSON.stringify`); a `null` value, or `undefined` in an array or at the root, is rejected instead.
- **Tolerated input.** Comments, processing instructions, a DOCTYPE, attributes, a byte order mark, CDATA in strings, unpadded or whitespace-wrapped base64, missing `<plist>` wrappers, and content after `</plist>` are all accepted, mirroring the reference parser.
- **Output layout.** Documents are emitted in the reference writer's layout — header, `<plist version="1.0">`, root element at column zero, one indentation unit per level — so output diffs cleanly against Apple tool output.

## Performance

Run benchmarks with `pnpm bench`; it builds first and measures the published artifact.

<p align="center">
  <img src="assets/performance.svg" alt="Benchmark table: in XML form, an auth response parses in 3.4 microseconds and builds in 1.1 microseconds, a 500-entry device list parses in 0.72 milliseconds and builds in 0.42 milliseconds, and a data-heavy profile parses in 0.71 milliseconds and builds in 79 microseconds; in binary form, the auth response parses in 1.1 microseconds and builds in 2.1 microseconds, the device list parses in 0.20 milliseconds and builds in 0.50 milliseconds, and the profile parses in 20 microseconds and builds in 20 microseconds" width="880" />
</p>

| Document                        | Format | Size    | Parse   | Build   | Parse speed | Build speed |
| ------------------------------- | ------ | ------- | ------- | ------- | ----------- | ----------- |
| auth response                   | XML    | 1.5 KiB | 3.4 µs  | 1.1 µs  | ~430 MiB/s  | ~1.2 GiB/s  |
| auth response                   | binary | 0.9 KiB | 1.1 µs  | 2.1 µs  | ~800 MiB/s  | ~420 MiB/s  |
| device list (500 dated entries) | XML    | 179 KiB | 0.72 ms | 0.42 ms | ~240 MiB/s  | ~420 MiB/s  |
| device list (500 dated entries) | binary | 55 KiB  | 0.20 ms | 0.50 ms | ~270 MiB/s  | ~110 MiB/s  |
| profile (data-heavy)            | XML    | 658 KiB | 0.71 ms | 79 µs   | ~900 MiB/s  | ~7.9 GiB/s  |
| profile (data-heavy)            | binary | 493 KiB | 20 µs   | 20 µs   | ~24 GiB/s   | ~24 GiB/s   |

Measured on an Apple M5 Max, Node.js 24, single thread. With `data: "view"`, the data-heavy profile parses in ~1 µs — the structural scan alone, no payload copies.

Binary reads beat XML reads because object lengths are explicit — nothing is scanned — and `<data>` payloads transfer as plain byte copies instead of base64 decoding, which is why the data-heavy profile parses at memory-copy speed. By default parsed values own their memory: payloads are copied out of the input buffer, never aliased into it, so mutating a parsed value can never corrupt the source document and holding a small payload never pins a large input buffer alive; `data: "view"` trades that guarantee away explicitly. Binary writes split by shape: dictionary-heavy documents pay for the format's object table — per-value interning that streaming XML text does not need — while data-heavy documents build far faster in binary because payload bytes are copied once instead of base64-encoded. The dispatch checks that route `parsePlist` between formats are branch-predicted noise; the XML numbers are identical with binary support in the tree.

### Key performance features

- **Single pass, no intermediate representation** — documents scan directly into values; there is no DOM, token stream, or event tree to build and then walk.
- **Zero allocations per element** — the ten element names match against interned constants by code-unit comparison, so tag-dense documents produce no per-tag garbage.
- **Precomputed lookup tables** — base64 decodes through a 128-entry reverse table, and character classification never round-trips through strings.
- **Native fast paths, portable fallbacks** — base64 uses the host codec where one exists, strings that need no escaping pass through after a single native scan, and common integers convert without arbitrary-precision handling. Every fast path has a pure-JavaScript fallback with identical observable behavior.

## Development

```sh
pnpm install
pnpm test         # vitest, including plutil cross-validation on macOS
pnpm typecheck    # tsc --noEmit
pnpm lint         # oxlint
pnpm format       # oxfmt
pnpm checks       # format check + lint + typecheck + test
pnpm bench        # vitest bench
pnpm build        # tsdown → dist/
```

The layout follows the usual conventions: the public API lives in `src/` with
one module per concern (`parse`, `build`, `base64`, `errors`, `types`),
shared non-exported helpers live in `src/internal/`, tests live in `tests/`
and exercise the public entry point, and benchmarks live in `bench/`.

CI runs the same `pnpm checks` gate on Linux and macOS; the macOS jobs
include the plutil cross-validation suite.

## Releasing

Releases publish to npm from CI with [provenance](https://docs.npmjs.com/generating-provenance-statements) via [trusted publishing](https://docs.npmjs.com/trusted-publishers) — no long-lived tokens are stored in the repository.

1. Bump `version` in `package.json` and merge to `main`.
2. Create a GitHub release with an `X.Y.Z` tag matching the new version.
3. The release workflow verifies the tag, runs the full gate (including
   plutil cross-validation on the macOS runner), and publishes.

## License

Apache-2.0
