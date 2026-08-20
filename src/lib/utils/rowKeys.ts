import type { ColumnInfo, QueryResult, RowKey } from "@/lib/types";

/**
 * Whether a row on screen can be named, and by what.
 *
 * `missing` carries the column that made the answer no, so the caller can say
 * which one rather than "something went wrong"; `null` there means the table
 * has no primary key at all.
 */
export type RowIdentity =
  | { ok: true; keys: RowKey[] }
  | { ok: false; missing: string | null };

/**
 * The row's identity, read out of the row already on screen.
 *
 * The rule that decides which row a write reaches, and there is exactly one
 * copy of it: the status bar uses it to show the statement that is about to
 * run, and the store uses it to build the statement that actually runs. Two
 * copies would let the preview drift from the write, which is the one place
 * this application must not be approximately right.
 *
 * A key that is not in the result, or is NULL, cannot identify anything —
 * better to refuse than to send a `where` that matches the wrong row, or every
 * row. The backend checks this identity against the catalogue again and
 * rejects anything else; this is the client's half of the same rule.
 */
export function rowKeysFor(
  columns: ColumnInfo[] | null,
  result: QueryResult,
  rowIndex: number,
): RowIdentity {
  const row = result.rows[rowIndex];
  if (!row) return { ok: false, missing: null };

  const keys: RowKey[] = [];
  for (const info of columns ?? []) {
    if (!info.primaryKey) continue;
    const at = result.columns.findIndex((c) => c.name === info.name);
    const value = at >= 0 ? row[at] : undefined;
    if (value === undefined || value === null) return { ok: false, missing: info.name };
    keys.push({ column: info.name, value });
  }

  return keys.length === 0 ? { ok: false, missing: null } : { ok: true, keys };
}

/**
 * A row's identity as one string, so it can be staged like a Redis key is.
 *
 * `staged` is a list of strings shared by all three staging gestures, and the
 * grid's rule for what it holds is deliberate: identities, never row indices.
 * The rows are rebuilt on every page and a stale index would paint the wrong
 * row red, which on a delete is the one mistake that cannot be walked back.
 *
 * The column order is the catalogue's, because `rowKeysFor` emits it that way,
 * so the same row always produces the same string.
 */
export const rowStageKey = (keys: RowKey[]): string =>
  JSON.stringify(keys.map((k) => [k.column, k.value]));

/**
 * The staged rows that are still on screen, as the identities a delete needs.
 *
 * The counterpart of `stagedKeysIn` for tables, and it exists for the same
 * reason: a row staged before a page turn is one the user can no longer see,
 * and acting on it would be the app destroying something it stopped showing
 * them. Screen order, so the preview reads down the grid.
 */
export function stagedRowsIn(
  columns: ColumnInfo[] | null,
  result: QueryResult,
  staged: Set<string>,
): RowKey[][] {
  const out: RowKey[][] = [];
  for (let i = 0; i < result.rows.length; i++) {
    const identity = rowKeysFor(columns, result, i);
    if (identity.ok && staged.has(rowStageKey(identity.keys))) out.push(identity.keys);
  }
  return out;
}
