/**
 * Class strings and metrics shared by more than one surface.
 *
 * A value only earns a place here once a second file needs it. A number that
 * means something in exactly one component stays in that component, where it
 * can be read next to the layout it describes.
 */

import type { QueryTab } from "@/lib/types";

/**
 * Distance a floating panel keeps from the window edge.
 *
 * One number, three readers: the context menu nudging itself inward, the cell
 * editor deciding where it fits, and the anchored-panel hook deciding whether
 * to flip upward. Three copies of it was three chances for a panel to sit
 * flush against the edge in one place and not another.
 */
export const PANEL_MARGIN = 8;

/**
 * Looks of a menu panel, without its positioning: `absolute` and `fixed` are
 * both `position` utilities, and Tailwind emits them in its own order rather
 * than the order they appear in a class string, so a panel that wanted to be
 * fixed could silently come out absolute. Each consumer states its own.
 */
export const MENU_PANEL =
  "menu-anim overflow-y-auto rounded-md border border-line bg-overlay p-1 shadow-xl shadow-black/50 focus:outline-none";

export const MENU_ITEM =
  "flex w-full cursor-default items-center gap-2 rounded px-1.5 py-1 text-[12px]";

/**
 * Text input in a form.
 *
 * Filled rather than outlined, and one row height (28px) shared with every
 * other control in a form so a column of them has a straight edge. The focus
 * ring is inside the box: an outline outside it would nudge the row.
 */
export const INPUT_CLS =
  "h-7 w-full rounded-md bg-field px-2 text-[12px] text-ink placeholder:text-ink-muted hover:bg-field-hover focus:bg-field-hover focus:outline focus:outline-1 focus:-outline-offset-1 focus:outline-accent";

/** Compact text input inside a popover. */
export const INPUT_COMPACT_CLS =
  "min-w-0 flex-1 rounded border border-line-soft bg-base px-1.5 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none";

/** Sticky column heading in a non-virtualised list. */
export const TABLE_HEAD_CLS =
  "sticky top-0 z-10 flex h-7 items-center border-b border-line bg-raised px-2 font-sans text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase";

/** How long a typeahead buffer survives between keystrokes. */
export const TYPEAHEAD_RESET_MS = 600;

export const VIEW_LABEL: Record<QueryTab["view"], string> = {
  data: "Data",
  structure: "Structure",
  definition: "Definition",
  diagram: "Diagram",
};
