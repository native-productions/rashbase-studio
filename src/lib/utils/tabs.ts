import { keyEditableReason, keyKindAt, KEY_COLUMNS } from "@/lib/utils/redis";
import type { ColumnInfo, DbObject, QueryTab } from "@/lib/types";

/**
 * Tables, views, and a keyspace have rows; a function is only ever its source,
 * and a diagram is the schema rather than anything in it.
 *
 * The one place that answers this. Everything downstream — whether a tab gets
 * an editor, a pager, a filter bar, a `select` to run, a column fetch — is
 * gated on it, so a kind that has no rows only has to say so once.
 */
export const hasRows = (o: DbObject | null): boolean =>
  o !== null && o.kind !== "function" && o.kind !== "diagram";

/**
 * Whether this tab is a flat key namespace rather than a relation.
 *
 * The one test that separates the two worlds, asked wherever a surface has to
 * page by cursor instead of offset, filter by glob instead of `where`, or write
 * by key instead of by primary key.
 */
export const isKeyspace = (o: DbObject | null): boolean => o?.kind === "keyspace";

export function viewsFor(object: DbObject | null): QueryTab["view"][] {
  if (!object) return [];
  if (object.kind === "diagram") return ["diagram"];
  if (object.kind === "function") return ["definition"];
  // A keyspace has no structure to show: every key is its own shape, which is
  // the whole difference between this and a table.
  if (object.kind === "keyspace") return ["data"];
  if (object.kind === "view" || object.kind === "matview") {
    return ["data", "structure", "definition"];
  }
  return ["data", "structure"];
}

/**
 * Why this tab's cells cannot be written, or null when they can.
 *
 * One sentence, one source. The grid uses it to decide whether a double click
 * does anything, and the row panel prints it, so the reason a cell is inert is
 * never something the user has to work out for themselves.
 */
export function editableReason(tab: QueryTab): string | null {
  if (!tab.object) return "Results of a query are not editable.";
  // A key is its own identity, so there is no catalogue to consult and nothing
  // to refuse at the tab level: what can be written is decided per cell, by
  // which column it is in and what type the key holds.
  if (tab.object.kind === "keyspace") return null;
  if (tab.object.kind !== "table") return `A ${tab.object.kind} has no rows of its own to edit.`;
  if (!tab.columns) return "Reading the table definition…";
  if (!tab.columns.some((c) => c.primaryKey)) {
    return `${tab.object.schema}.${tab.object.name} has no primary key, so a single row cannot be identified.`;
  }
  return null;
}

/**
 * The columns an "any column" filter expands over.
 *
 * Read from the rows already on screen rather than from the table definition,
 * which is only fetched when the Structure view is opened and would leave the
 * filter silently covering nothing on a tab the user never switched.
 */
export const tabColumns = (tab: QueryTab): string[] =>
  (tab.results[0]?.columns ?? tab.columns ?? []).map((c) => c.name);

/**
 * Why this one cell cannot be written, or null when it can.
 *
 * The per-cell counterpart of `editableReason`, and the only version that means
 * anything on a keyspace: a row there holds one writable value, one writable
 * TTL, and three facts about the key that are not fields at all. On every other
 * kind of tab this defers to the tab-level answer, which is what keeps a single
 * sentence behind every inert cell in the app.
 */
export function cellEditableReason(tab: QueryTab, col: number): string | null {
  const tabReason = editableReason(tab);
  if (tabReason !== null) return tabReason;
  if (!isKeyspace(tab.object)) return null;

  const result = tab.results[tab.activeResultIndex];
  const column = result?.columns[col]?.name ?? KEY_COLUMNS[col]?.name ?? "";
  const selection = tab.selection;
  const kind = result && selection ? keyKindAt(result, selection.row) : "";
  return keyEditableReason(kind, column);
}

/**
 * The enum labels behind a column, or null when it is not an enum.
 *
 * Takes the fetched definition rather than the tab so the cell editor, which
 * knows nothing about tabs, can ask the same question the row panel asks.
 * `null` columns means the definition has not arrived — on a query tab it never
 * will, and those cells are not editable anyway, so the picker can never appear
 * somewhere it would have nothing to write to.
 */
export function enumValuesFor(
  columns: ColumnInfo[] | null,
  columnName: string,
): string[] | null {
  const values = columns?.find((c) => c.name === columnName)?.enumValues;
  return values && values.length > 0 ? values : null;
}

/** Whether a column accepts NULL, which decides if the picker offers it. */
export function nullableColumn(columns: ColumnInfo[] | null, columnName: string): boolean {
  return !columns?.find((c) => c.name === columnName)?.notNull;
}
