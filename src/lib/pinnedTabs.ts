import type { DbObject, QueryTab } from "@/lib/types";

/**
 * Which tabs come back the next time the app opens.
 *
 * `localStorage` rather than the Rust side: this is a window layout preference,
 * not data, and nothing else needs to read it. Only pinned tabs are stored, and
 * only what identifies them — no rows, no results, no fetched definitions.
 */
const KEY = "rashbase.pinnedTabs.v1";

export type PinnedTab = {
  connectionId: string;
  object: DbObject | null;
  sql: string;
};

/**
 * Anything written here was written by a previous version of this app, so it is
 * read defensively: a shape that no longer parses is dropped rather than
 * allowed to open a broken tab.
 */
export function loadPinnedTabs(): PinnedTab[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p): p is PinnedTab =>
        !!p &&
        typeof p.connectionId === "string" &&
        typeof p.sql === "string" &&
        (p.object === null ||
          (typeof p.object?.schema === "string" &&
            typeof p.object?.name === "string" &&
            typeof p.object?.kind === "string")),
    );
  } catch {
    return [];
  }
}

/** A tab with no connection cannot be reopened against anything, so it is not kept. */
export function savePinnedTabs(tabs: QueryTab[]) {
  const pinned = tabs.flatMap((t) =>
    t.pinned && t.connectionId
      ? [{ connectionId: t.connectionId, object: t.object, sql: t.sql }]
      : [],
  );
  try {
    localStorage.setItem(KEY, JSON.stringify(pinned));
  } catch {
    /* A full or disabled store costs the user the pin, nothing more. */
  }
}
