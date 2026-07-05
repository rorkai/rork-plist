/**
 * rork-plist — zero-dependency Apple property list parser and builder.
 *
 * The library is a single ESM artifact with named exports and no
 * environment-conditional entry points: the same code path runs in
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
export { buildBinaryPlist } from "./build-binary";
export { buildPlist, type BuildPlistOptions } from "./build";
export { PlistBuildError, PlistParseError, type PlistErrorPosition } from "./errors";
export { parsePlist } from "./parse";
export { parseBinaryPlist } from "./parse-binary";
export type { ParsePlistOptions } from "./parse-options";
export type { PlistArray, PlistDictionary, PlistValue } from "./types";
