/**
 * Format-parametrized serialization entry point.
 *
 * The per-format builders are plain functions, so code that learns the
 * target format at runtime — most commonly from {@link detectPlistFormat}
 * when rewriting an existing document — would otherwise assemble its own
 * dispatch table. That table lives here instead, and the exhaustive switch
 * makes a growing {@link PlistFormat} a compile error rather than a silent
 * gap in every consumer.
 *
 * @module
 */

import { buildPlist } from "./build";
import { buildBinaryPlist } from "./build-binary";
import { buildOpenStepPlist } from "./build-openstep";
import type { PlistFormat, PlistValue } from "./types";

/**
 * Serializes a value in the given property list format.
 *
 * The return type follows the format — `Uint8Array` for `"binary"`, a
 * document string for `"xml"` and `"openstep"` — and collapses to
 * `string | Uint8Array` when the format is only known at runtime, which is
 * what file and network sinks accept anyway.
 *
 * Each format builds with its defaults. A caller that needs the
 * format-specific options keeps using that format's builder directly.
 *
 * ```ts
 * const source = await readFile("Info.plist");
 * const info = parsePlistDictionary(source);
 * info["CFBundleIdentifier"] = "com.example.rebranded";
 * await writeFile("Info.plist", buildPlistAs(info, detectPlistFormat(source)));
 * ```
 *
 * @param value The value to serialize. See {@link PlistValue} for the model.
 * @param format The serialization format to produce.
 * @returns The serialized document, typed by `format`.
 * @throws PlistBuildError when the value cannot be represented, the same
 *   errors the format's builder raises.
 * @throws TypeError when `format` is not a known format, which the type
 *   system cannot rule out for JavaScript callers.
 */
export function buildPlistAs(value: PlistValue, format: "binary"): Uint8Array;
export function buildPlistAs(value: PlistValue, format: "xml" | "openstep"): string;
export function buildPlistAs(value: PlistValue, format: PlistFormat): string | Uint8Array;
export function buildPlistAs(value: PlistValue, format: PlistFormat): string | Uint8Array {
  switch (format) {
    case "binary":
      return buildBinaryPlist(value);
    case "xml":
      return buildPlist(value);
    case "openstep":
      return buildOpenStepPlist(value);
    default: {
      // The satisfies check keeps the switch exhaustive at compile time
      // while the throw covers JavaScript callers the compiler cannot see.
      format satisfies never;
      throw new TypeError(`unknown property list format ${JSON.stringify(format)}`);
    }
  }
}
