/**
 * What the app looks like and how it opens tabs.
 *
 * `localStorage` for the same reason as `pinnedTabs.ts` and `translucency.ts`:
 * these are appearance and layout, not data, and nothing on the Rust side needs
 * to read them. A preference that gates a *secret* is the opposite case and
 * lives in `security.json` backend-side, where a compromised webview cannot
 * rewrite it.
 *
 * Read defensively, field by field. Anything in here was written by a previous
 * version of the app, and a shape that no longer parses should cost the user
 * one preference rather than all of them.
 */

const KEY = "rashbase.prefs.v1";

export type Theme = "dark" | "light";
export type TabBehaviour = "new" | "idle";

export interface Prefs {
  theme: Theme;
  /**
   * Multiplier on every size in the window, applied as `zoom` on the root.
   *
   * One of `FONT_SCALES` rather than a free slider. Every text size in this app
   * is a hardcoded px while every spacing utility is already rem, so scaling
   * the root font-size would grow the padding and leave the text where it is;
   * `zoom` moves all of it together, including the grid metrics and the column
   * widths measured in JS. The cost is that the titlebar has to cancel it out —
   * see `Titlebar.tsx` — so each step is a number that has been checked against
   * the traffic lights, not an arbitrary one.
   *
   * The SQL editor cancels it too, for a different reason: under `zoom` WebKit
   * reports element geometry and pointer coordinates in two different spaces,
   * and a click lands several characters from where it was aimed. `DESIGN.md`
   * has the measurements.
   */
  fontScale: number;
  tabBehaviour: TabBehaviour;
}

export const FONT_SCALES = [0.9, 1, 1.15, 1.3] as const;

export const DEFAULT_PREFS: Prefs = {
  theme: "dark",
  fontScale: 1,
  tabBehaviour: "new",
};

/** Snaps to the nearest offered step, so a stored value from any build lands
 *  on something the segmented control can actually show as chosen. */
export function clampScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PREFS.fontScale;
  return FONT_SCALES.reduce((best, step) =>
    Math.abs(step - value) < Math.abs(best - value) ? step : best,
  );
}

/** Pure, so the fallbacks can be tested without a window. */
export function parsePrefs(raw: unknown): Prefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_PREFS;
  const p = raw as Partial<Record<keyof Prefs, unknown>>;
  return {
    theme: p.theme === "light" || p.theme === "dark" ? p.theme : DEFAULT_PREFS.theme,
    fontScale: clampScale(p.fontScale),
    tabBehaviour:
      p.tabBehaviour === "idle" || p.tabBehaviour === "new"
        ? p.tabBehaviour
        : DEFAULT_PREFS.tabBehaviour,
  };
}

export function loadPrefs(): Prefs {
  try {
    return parsePrefs(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    /* A disabled or corrupt store costs the user the preference, nothing more. */
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* Same: the window still looks right for this session. */
  }
}

/**
 * Puts the preference on the document, which is where the CSS reads it.
 *
 * `data-theme` selects a palette; `--ui-scale` is the zoom factor. Both are
 * attributes on the root rather than state passed through React, because the
 * portalled dialogs mount on `body` and would otherwise be outside whatever
 * provider held them.
 */
export function applyPrefs(prefs: Prefs) {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.style.setProperty("--ui-scale", String(prefs.fontScale));
}
