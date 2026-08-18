import type { ColumnInfo, DbObject, QueryTab } from "@/lib/types";

/**
 * Tables and views have rows; a function is only ever its source, and a
 * diagram is the schema rather than anything in it.
 *
 * The one place that answers this. Everything downstream — whether a tab gets
 * an editor, a pager, a filter bar, a `select` to run, a column fetch — is
 * gated on it, so a kind that has no rows only has to say so once.
 */
export const hasRows = (o: DbObject | null): boolean =>
  o !== null && o.kind !== "function" && o.kind !== "diagram";

export function viewsFor(object: DbObject | null): QueryTab["view"][] {
  if (!object) return [];
  if (object.kind === "diagram") return ["diagram"];
  if (object.kind === "function") return ["definition"];
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
