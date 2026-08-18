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
