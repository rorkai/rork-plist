import { bench, describe } from "vitest";

// Benchmarks measure the built artifact — the code consumers actually run —
// because vitest's on-the-fly module transform keeps cross-module constants
// as property reads that the bundled output inlines. `pnpm bench` builds
// first.
import {
  buildBinaryPlist,
  buildOpenStepPlist,
  buildPlist,
  parseBinaryPlist,
  parseOpenStepPlist,
  parsePlist,
} from "../dist/index";
import { shapes, stringifyLeaves } from "./fixtures";

for (const [name, value] of Object.entries(shapes)) {
  const xml = buildPlist(value);
  const binary = buildBinaryPlist(value);
  const openStepValue = stringifyLeaves(value);
  const openStep = buildOpenStepPlist(openStepValue);

  describe(`parse ${name} (xml ${(xml.length / 1024).toFixed(1)} KiB, binary ${(binary.length / 1024).toFixed(1)} KiB, openstep ${(openStep.length / 1024).toFixed(1)} KiB)`, () => {
    bench("parsePlist (xml)", () => {
      parsePlist(xml);
    });
    bench("parseBinaryPlist", () => {
      parseBinaryPlist(binary);
    });
    bench("parseOpenStepPlist", () => {
      parseOpenStepPlist(openStep);
    });
  });

  describe(`build ${name}`, () => {
    bench("buildPlist (xml)", () => {
      buildPlist(value);
    });
    bench("buildBinaryPlist", () => {
      buildBinaryPlist(value);
    });
    bench("buildOpenStepPlist", () => {
      buildOpenStepPlist(openStepValue);
    });
  });
}
