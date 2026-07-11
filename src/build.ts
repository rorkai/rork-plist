/**
 * The generic property list building entry point.
 *
 * {@link buildPlist} mirrors {@link parsePlist} in shape. The parser detects
 * the format from the input, and since a value carries nothing to detect,
 * the builder takes the format as an option instead, with XML as the
 * default. The per-format builders (see {@link "./build-xml"},
 * {@link "./build-binary"}, and {@link "./build-openstep"}) remain the
 * explicit entry points; this module only owns the dispatch, so a growing
 * {@link PlistFormat} is a compile error here rather than a silent gap in
 * every consumer's hand-rolled builder table.
 *
 * @module
 */

import { buildBinaryPlist } from "./build-binary";
import { buildOpenStepPlist } from "./build-openstep";
import { buildXmlPlist } from "./build-xml";
import type { PlistFormat, PlistValue } from "./types";

/**
 * Options accepted by {@link buildPlist}.
 */
export interface BuildPlistOptions {
  /**
   * The serialization format to produce. The default is `"xml"`, so existing
   * callers that never chose a format keep getting the XML document they
   * always got.
   */
  format?: PlistFormat;

  /**
   * Indentation unit for the text formats, or `false` for a single-line
   * body. The default is a tab, the unit the platform tooling emits. The
   * binary format has no layout, so it ignores this option.
   */
  indent?: string | false;
}

/**
 * Serializes a value as a property list in the chosen format.
 *
 * The return type follows the format — `Uint8Array` for `"binary"`, a
 * document string for `"xml"` and `"openstep"` — and collapses to
 * `string | Uint8Array` when the format is only known at runtime, most
 * commonly from {@link detectPlistFormat} when rewriting an existing
 * document in its original on-disk format:
 *
 * ```ts
 * const source = await readFile("Info.plist");
 * const info = parsePlistDictionary(source);
 * info["CFBundleIdentifier"] = "com.example.rebranded";
 * await writeFile("Info.plist", buildPlist(info, { format: detectPlistFormat(source) }));
 * ```
 *
 * @param value The value to serialize. See {@link PlistValue} for the model
 *   and each format's builder for its format-specific restrictions.
 * @param options See {@link BuildPlistOptions}.
 * @returns The serialized document, typed by the `format` option.
 * @throws PlistBuildError when the value cannot be represented, the same
 *   errors the format's builder raises.
 * @throws TypeError when `format` is not a known format, which the type
 *   system cannot rule out for JavaScript callers.
 */
export function buildPlist(value: PlistValue, options?: BuildPlistOptions & { format?: "xml" | "openstep" }): string;
export function buildPlist(value: PlistValue, options: BuildPlistOptions & { format: "binary" }): Uint8Array;
export function buildPlist(value: PlistValue, options?: BuildPlistOptions): string | Uint8Array;
export function buildPlist(value: PlistValue, options: BuildPlistOptions = {}): string | Uint8Array {
  const format = options.format ?? "xml";
  const indent = options.indent;
  switch (format) {
    case "xml":
      return buildXmlPlist(value, indent === undefined ? {} : { indent });
    case "binary":
      return buildBinaryPlist(value);
    case "openstep":
      return buildOpenStepPlist(value, indent === undefined ? {} : { indent });
    default: {
      // The satisfies check keeps the switch exhaustive at compile time
      // while the throw covers JavaScript callers the compiler cannot see.
      format satisfies never;
      throw new TypeError(`unknown property list format ${JSON.stringify(format)}`);
    }
  }
}
