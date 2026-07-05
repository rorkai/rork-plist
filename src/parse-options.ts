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
