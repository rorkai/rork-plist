/**
 * rork-plist — zero-dependency Apple property list parser and builder.
 *
 * The library is a single ESM artifact with named exports and no
 * environment-conditional entry points, so the same code path runs in
 * browsers, Node.js, Bun, Electron, Cloudflare Workers, and React Native.
 *
 * ```ts
 * import { parsePlist, buildPlist } from "rork-plist";
 *
 * const value = parsePlist(xmlText);
 * const xml = buildPlist({ device: "iPhone17,1", enabled: true });
 * ```
 *
 * @module
 */

export { decodeBase64, encodeBase64 } from "./base64";
export { buildPlistAs } from "./build-as";
export { buildBinaryPlist } from "./build-binary";
export { buildOpenStepPlist, type BuildOpenStepPlistOptions } from "./build-openstep";
export { buildPlist, type BuildPlistOptions } from "./build";
export { PlistBuildError, PlistParseError, type PlistErrorPosition } from "./errors";
export { detectPlistFormat, parsePlist, parsePlistDictionary } from "./parse";
export { parseBinaryPlist } from "./parse-binary";
export { parseOpenStepPlist } from "./parse-openstep";
export type { ParsePlistOptions } from "./parse-options";
export {
  isPlistDictionary,
  PlistUid,
  type PlistArray,
  type PlistDictionary,
  type PlistFormat,
  type PlistValue,
} from "./types";
