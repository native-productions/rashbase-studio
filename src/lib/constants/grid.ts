import type { TypeClass } from "@/lib/types";

/** Rows per page for a freshly opened table. */
export const DEFAULT_PAGE_LIMIT = 200;

/**
 * Rows a freshly opened query tab keeps.
 *
 * Higher than a table page because a query is usually a question, and most
 * answers fit well under this — so the cap stays out of the way instead of
 * being something to raise on every other run. It is still low enough that
 * `select * from users` on a big table returns in the time a click deserves,
 * rather than moving tens of megabytes into the window.
 */
export const DEFAULT_QUERY_LIMIT = 1000;

/** Rows per page the footer menu offers. */
export const PAGE_SIZE_PRESETS = [50, 100, 200, 500, 1000];

// ---------------------------------------------------------------------------
// Grid metrics
//
// Shared with the Structure view, which reuses them so that switching views
// does not feel like landing in a different application.
// ---------------------------------------------------------------------------

export const ROW_H = 24;
export const HEADER_H = 28;
export const MIN_COL = 56;
export const MAX_AUTO_COL = 420;

/** Geist Mono at 12px advances ~7.2px per character. */
export const CH = 7.2;

/** How far PageUp and PageDown move the selection. */
export const PAGE_JUMP = 25;

/** Rows sampled when fitting column widths. See `autoWidths`. */
export const WIDTH_SAMPLE = 200;

/**
 * Colour and alignment carry type information, so a column of integers reads as
 * numeric at a glance without anyone having to check the header.
 */
export const CLASS_STYLE: Record<TypeClass, string> = {
  number: "text-num text-right tabular-nums",
  bool: "text-bool",
  temporal: "text-ink-muted",
  json: "text-str",
  uuid: "text-ink-muted",
  binary: "text-ink-faint",
  array: "text-str",
  text: "text-ink",
  other: "text-ink",
};
