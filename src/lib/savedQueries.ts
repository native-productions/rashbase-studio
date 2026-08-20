/**
 * Statements the user asked to keep.
 *
 * `localStorage` rather than the Rust side, for the same reason as
 * `pinnedTabs`: this is the user's own scratch shelf, not data, and nothing on
 * the backend reads it. Scoped to a connection because a query names that
 * server's tables and means nothing against another.
 *
 * Only the statement is stored. No results, no timings, no error — a saved
 * query is re-run, never replayed.
 */
const KEY = "rashbase.savedQueries.v1";

/** Longest default name, before the ellipsis. Roughly one chip wide. */
const NAME_LIMIT = 36;

export interface SavedQuery {
  id: string;
  connectionId: string;
  name: string;
  sql: string;
  savedAt: number;
}

/**
 * Anything read here was written by a previous version of this app, so a shape
 * that no longer parses is dropped rather than allowed to draw a broken chip.
 */
export function loadSavedQueries(): SavedQuery[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (q): q is SavedQuery =>
        !!q &&
        typeof q.id === "string" &&
        typeof q.connectionId === "string" &&
        typeof q.name === "string" &&
        typeof q.sql === "string" &&
        typeof q.savedAt === "number",
    );
  } catch {
    return [];
  }
}

export function saveSavedQueries(queries: SavedQuery[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(queries));
  } catch {
    /* A full or disabled store costs the shelf, nothing more. */
  }
}

/**
 * The name a query gets when the user does not give it one.
 *
 * The statement itself, on one line. Naming is optional precisely because the
 * first forty characters of a query are usually enough to recognise it, and a
 * prompt in the way of ⌘S would make saving cost more than re-typing.
 */
export function defaultName(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > NAME_LIMIT ? `${flat.slice(0, NAME_LIMIT).trimEnd()}…` : flat;
}
