/**
 * Options and limits shared by the XML and binary property list parsers.
 *
 * They live in their own module so {@link "./parse"} (which dispatches to the
 * binary parser) and {@link "./parse-binary"} can both depend on them without
 * forming an import cycle.
 *
 * @module
 */

/**
 * Options accepted by the property list parsers.
 */
export interface ParsePlistOptions {
  /**
   * How `<data>` payloads in a binary plist relate to the input buffer.
   *
   * - `"copy"` (default): each payload is copied out, so parsed values own
   *   their memory — mutating a payload cannot corrupt the source document,
   *   and holding a small payload does not pin a large input buffer alive.
   * - `"view"`: each payload is a `subarray` view aliasing the input buffer,
   *   skipping the copy. Use this to pull a few fields out of a large
   *   document the caller controls and will not mutate or reuse. Writing
   *   through a view corrupts the source bytes, and any retained view keeps
   *   the whole backing buffer reachable.
   *
   * XML `<data>` decodes from base64 into fresh bytes, so this option has no
   * effect on the XML path.
   */
  data?: "copy" | "view";

  /**
   * Maximum `<dict>`/`<array>` nesting depth before parsing fails.
   *
   * Each container level recurses once, so this bound caps stack growth on
   * adversarial documents. For binary plists it doubles as cycle protection:
   * object references can form loops, and a cyclic graph exceeds the depth
   * limit instead of recursing forever. The default of 512 is far deeper than
   * any real-world property list while staying well inside every JavaScript
   * engine's default stack.
   */
  maxDepth?: number;
}

/** Default for {@link ParsePlistOptions.maxDepth}. */
export const DEFAULT_MAX_DEPTH = 512;
