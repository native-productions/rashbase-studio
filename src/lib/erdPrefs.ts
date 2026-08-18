/**
 * Where the user put the tables, and what the canvas looks like.
 *
 * `localStorage` for the same reason as `pinnedTabs`: this is window layout,
 * not data. Read defensively, because anything in here was written by a
 * previous version of the app and a shape that no longer parses should cost the
 * user their arrangement, not the diagram.
 */

const KEY = "rashbase.erd.v1";

export interface ErdPrefs {
  /** Table name to canvas position. Absent tables fall back to auto-layout. */
  positions: Record<string, { x: number; y: number }>;
  /** Dot grid on, or a blank canvas. */
  dots: boolean;
  /** Whether nodes show every column rather than just their keys. */
  expanded: boolean;
}

export const DEFAULT_PREFS: ErdPrefs = { positions: {}, dots: true, expanded: false };

/**
 * Keyed the way the store keys its own per-schema caches, so a connection that
 * goes away can be cleaned out by splitting on the same separator.
 */
export const prefsKey = (connectionId: string, schema: string) => `${connectionId}::${schema}`;

type Store = Record<string, ErdPrefs>;

function readAll(): Store {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Store;
  } catch {
    return {};
  }
}

export function loadErdPrefs(key: string): ErdPrefs {
  const entry = readAll()[key];
  if (!entry || typeof entry !== "object") return DEFAULT_PREFS;
  const positions = entry.positions;
  return {
    // Each field is checked on its own: a file written before `expanded`
    // existed should still restore the positions it does have.
    positions:
      positions && typeof positions === "object" && !Array.isArray(positions) ? positions : {},
    dots: typeof entry.dots === "boolean" ? entry.dots : DEFAULT_PREFS.dots,
    expanded: typeof entry.expanded === "boolean" ? entry.expanded : DEFAULT_PREFS.expanded,
  };
}

export function saveErdPrefs(key: string, prefs: ErdPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [key]: prefs }));
  } catch {
    /* A full or disabled store costs the arrangement, nothing more. */
  }
}
