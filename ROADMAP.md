# Roadmap

This roadmap collects the work we consider worth doing next, in rough order.
It is a statement of intent, not a schedule. Items graduate by shipping in a
minor release, and anything here can be reshuffled when real usage teaches
us something new.

Two principles decide what belongs on this list. Behavior is specified by
what the platform's own tooling does, verified empirically, and protected by
tests and benchmarks before it ships. And anything a consumer must hand-roll
twice is a candidate for first-class API.

## Near term

### Keyed-archive resolution

Parsing UIDs yields the raw archive graph: a `$objects` table, a `$top`
entry point, and UID references between them. Reading the actual data still
requires understanding that encoding. A `resolveKeyedArchive()` helper that
follows `$top` through `$objects` and replaces UIDs with the values they
reference would make Dock preferences, Xcode UI state, and similar files
directly usable. Design questions to settle against the platform's own
unarchiving behavior: how to surface `$class` metadata, how to represent
shared references, and whether cycles resolve to shared objects or fail
with a clear error.

### Continuous accuracy protection in CI

The accuracy claims are re-verified today by running the corpus sweep and
fuzzer by hand. CI should hold that line on every pull request: a
structure-aware fuzzer for the binary parser (the OpenStep grammar fuzzer
already exists in the test suite), and a macOS job that runs the `plutil`
differential over committed fixtures, so grammar drift between this library
and the platform is caught at review time rather than at the next manual
sweep.

### Instruction-count benchmarking

Wall-clock benchmarks cannot resolve regressions below a few percent, and
the noise floor moves with every machine and build. The kernel's
per-process retired-instruction counters (`proc_pid_rusage`) measure the
work itself: with a fixed workload, deterministic engine scheduling, and
differential iteration scaling, repeated runs agree to a few hundredths of
a percent. A `bench:instructions` harness built on that would let macOS CI
flag performance regressions of a few instructions per call — the method
has already located a two-instruction dispatch cost that timing could not
separate from noise.

### Document the bundle-size story

Measured numbers worth publishing alongside the performance chart: about
11 kB minified and gzipped for all three formats in both directions, and
substantially less tree-shaken — a single parser or builder costs a few
kilobytes. The comparison matters because headline sizes elsewhere can hide
platform-conditional entry points that delegate parsing to the host
browser; per-environment entry points are exactly what this library refuses
to have.

## Toward 1.0

The value model, grammar behaviors, and the generic parse and build entry
points have stabilized, so 1.0 is less about features and more about
formalizing the contract: one documentation pass over the public surface
with the README examples verified against the shipped types, and from 1.0
on, semver majors gating every breaking change, including type-level ones.

## Non-goals

Some things stay out deliberately.

- **`bplist15` / `bplist16`.** Zero occurrences in 25,000 real files. The
  platform's own writers emit `bplist00`. Revisit only with evidence.
- **A type parameter on `parsePlist<T>()`.** It would be a cast wearing a
  costume. Callers who know the document shape should write `as T` at the
  call site, where the assumption is visible — or use
  `parsePlistDictionary` and narrow from there.
- **Per-environment entry points.** Delegating XML parsing to a host DOM
  parser in browsers would shrink the headline bundle number at the cost of
  engine-dependent behavior, weaker validation, and runtimes with no DOM at
  all. One artifact, identical behavior everywhere, is the contract.
- **Comment- and whitespace-preserving parsing.** Round-trip source editing
  (as needed for `project.pbxproj` files) is a different contract from
  value parsing, with its own trivia model and emission conventions. It
  belongs in a dedicated tool, not in the value parser.
- **Streaming APIs.** Property lists are whole-document formats; the binary
  format's offset table sits at the end of the file. Incremental parsing
  has no correct implementation worth shipping.
