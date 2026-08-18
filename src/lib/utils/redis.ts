/**
 * The keyspace layer: everything that turns a key-value store into rows.
 *
 * Pure and dependency-free on purpose. This is the whole reason the grid, the
 * row panel, the JSON tree, the cell editor and the expanded editor needed no
 * changes to browse Redis: a page of keys is converted to the same
 * `QueryResult` those surfaces already draw, once, here.
 *
 * Kept out of the store and the components for the same reason `utils/sql.ts`
 * is: this decides which keys a filter reaches and which cell holds what, and
 * both are worth reading and testing as one thing.
 */

import type {
  ColumnMeta,
  Filter,
  KeyEntry,
  KeyFilter,
  KeyPage,
  QueryResult,
  RowKey,
} from "@/lib/types";

/**
 * The columns a keyspace tab draws, in order.
 *
 * `value` last because it is the widest and the only one that ever wraps; the
 * three narrow facts about a key come first, where they can be scanned down a
 * column. `key` is not right-aligned or coloured: it is the identity, and the
 * one thing on the row that should read as plain text.
 */
export const KEY_COLUMNS: ColumnMeta[] = [
  { name: "key", typeName: "key", typeClass: "text" },
  { name: "type", typeName: "type", typeClass: "bool" },
  // Right-aligned and tabular through `CLASS_STYLE.number`, which is what makes
  // a column of expiries comparable at a glance.
  { name: "ttl", typeName: "seconds", typeClass: "number" },
  { name: "size", typeName: "bytes/len", typeClass: "number" },
  // `json` rather than `text` so a hash or a list picks up the string colour and
  // the row panel offers its tree. A plain string value parses as nothing and
  // falls back to being drawn as text, which is correct.
  { name: "value", typeName: "value", typeClass: "json" },
];

/** Column positions, named once so nothing indexes this grid by magic number. */
export const KEY_COL = { key: 0, type: 1, ttl: 2, size: 3, value: 4 } as const;

/** Which columns a write can land on. Everything else describes the key. */
export const WRITABLE_KEY_COLUMNS = new Set(["value", "ttl"]);

/**
 * Renders a TTL the way a person reads one.
 *
 * `-1` is Redis for "never expires" and `-2` for "no such key". Both are
 * printed as words rather than as the raw sentinel: a column of `-1`s reads as
 * an error, and the whole point of the column is to be scannable.
 */
export function formatTtl(ttl: number | null): string | null {
  if (ttl === null) return null;
  if (ttl === -1) return "never";
  if (ttl === -2) return "gone";
  if (ttl < 60) return `${ttl}s`;

  const parts: [number, string][] = [
    [Math.floor(ttl / 86400), "d"],
    [Math.floor((ttl % 86400) / 3600), "h"],
    [Math.floor((ttl % 3600) / 60), "m"],
    [ttl % 60, "s"],
  ];
  // Two units, largest first. "2d 4h" is the answer; "2d 4h 17m 3s" is a
  // precision nobody reading an expiry column asked for.
  return (
    parts
      .filter(([n]) => n > 0)
      .slice(0, 2)
      .map(([n, unit]) => `${n}${unit}`)
      .join(" ") || "0s"
  );
}

/**
 * Parses what the TTL editor accepted back into seconds for the wire.
 *
 * Accepts what it prints, so a value can be edited in place rather than
 * retyped from scratch: `never`, blank, `900`, `15m`, `2d 4h`. Returns `null`
 * for "no expiry", and `undefined` when the text is not a duration at all.
 */
export function parseTtl(text: string): number | null | undefined {
  const raw = text.trim().toLowerCase();
  if (raw === "" || raw === "never" || raw === "-1") return null;
  if (/^\d+$/.test(raw)) return Number(raw);

  const units: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
  const matches = [...raw.matchAll(/(\d+)\s*([dhms])/g)];
  if (matches.length === 0) return undefined;
  // Anything left over means the text was only partly a duration, which is a
  // typo rather than a value: refusing beats sending half of what was meant.
  if (raw.replace(/(\d+)\s*([dhms])/g, "").trim() !== "") return undefined;

  return matches.reduce((total, [, n, unit]) => total + Number(n) * units[unit!]!, 0);
}

/**
 * Turns the filter bar into a keyspace filter.
 *
 * The two fields cost very differently and the split is the whole point.
 * `pattern` is pushed down to the server and is nearly free; `contains` can
 * only be answered by reading every value the walk touches. Conditions on the
 * key fold into one glob because the server takes exactly one `MATCH`, and the
 * last one typed wins rather than being silently ANDed into something the
 * server cannot express.
 */
export function keyFilterFrom(filters: Filter[]): KeyFilter {
  let pattern: string | null = null;
  let contains: string | null = null;

  for (const f of filters) {
    const value = f.values[0] ?? "";
    if (value === "" && f.op !== "isNull" && f.op !== "isNotNull") continue;

    // A filter with no column named is about the key: that is the field you
    // reach for without knowing anything, and it is the cheap one.
    if (f.column === "value") {
      contains = value;
      continue;
    }

    switch (f.op) {
      // Verbatim. `nvp:na:*` is a pattern the user wrote, and escaping or
      // wrapping it would break the one gesture globbing exists for.
      case "matches":
        pattern = value;
        break;
      case "prefix":
        pattern = `${escapeGlob(value)}*`;
        break;
      case "eq":
        pattern = escapeGlob(value);
        break;
      case "contains":
      default:
        pattern = `*${escapeGlob(value)}*`;
        break;
    }
  }

  return { pattern, contains, caseSensitive: false };
}

/**
 * Escapes the glob metacharacters, so a prefix means the literal text.
 *
 * `matches` deliberately skips this: there the value *is* a pattern, and
 * escaping it would leave no way to write one. That difference is the reason
 * both operators are offered, and it mirrors how `escapeLike` and LIKE relate
 * on the SQL side.
 */
export function escapeGlob(value: string): string {
  return value.replace(/([\\*?[\]])/g, "\\$1");
}

/**
 * A page of keys as a result set.
 *
 * The one function this whole feature rests on: after this, a keyspace is
 * something the existing grid already knows how to draw, page, select in, and
 * edit. Nothing downstream learns that Redis exists.
 */
export function keyPageToResult(page: KeyPage, durationMs = 0): QueryResult {
  return {
    columns: KEY_COLUMNS,
    rows: page.keys.map((entry) => [
      entry.key,
      entry.kind,
      formatTtl(entry.ttl),
      entry.size === null ? null : String(entry.size),
      entry.preview,
    ]),
    // What the walk found, which for a keyspace is what is on screen: there is
    // no server-side count of "rows this filter would match" to be honest about.
    rowsAffected: page.keys.length,
    truncated: false,
    durationMs,
  };
}

/**
 * The identity of a keyspace row: its key, and nothing else.
 *
 * A key *is* its own primary key, which is a stronger guarantee than the
 * Postgres path's search through the catalogue for one. Returned in the same
 * shape `rowKeysFor` produces so the write path, the status bar preview, and
 * the backend all keep taking one kind of argument.
 */
export function keyRowIdentity(result: QueryResult, row: number): RowKey[] | null {
  const key = result.rows[row]?.[KEY_COL.key];
  return key === null || key === undefined ? null : [{ column: "key", value: key }];
}

/** Every staged row's key, in the order they appear on screen. */
export function stagedKeysIn(result: QueryResult, staged: Set<string>): string[] {
  return result.rows
    .map((row) => row[KEY_COL.key])
    .filter((key): key is string => key !== null && key !== undefined && staged.has(key));
}

/**
 * The command a commit is about to run, for the status bar to print.
 *
 * Quoted the way the console would take them back, so what is shown is
 * something that could be pasted and run. Long lists are elided in the middle
 * rather than the end: the first and last key are what tell you the range you
 * marked, and the count is stated separately anyway.
 */
export function deletePreview(keys: string[], shown = 3): string {
  const quoted = keys.map((k) => (/^[\w:.\-@]+$/.test(k) ? k : JSON.stringify(k)));
  if (quoted.length <= shown + 1) return `DEL ${quoted.join(" ")}`;
  const head = quoted.slice(0, shown).join(" ");
  return `DEL ${head} … ${quoted[quoted.length - 1]}`;
}

/**
 * Whether a key's value can be written from the row panel.
 *
 * Strings and hashes only. A list, set, or sorted set has no single-cell
 * equivalent — "edit a set member" is an add and a remove, not an assignment —
 * so those are read-only here and changed from the console, and this returns
 * the sentence saying so rather than leaving a cell that silently does nothing.
 */
export function keyEditableReason(kind: string, column: string): string | null {
  if (column === "ttl") return null;
  if (column !== "value") {
    return column === "key"
      ? "A key cannot be renamed here. Delete it and write it under the new name."
      : `${column} describes the key rather than holding it.`;
  }
  if (kind === "string" || kind === "hash") return null;
  return `A ${kind} is changed by its own commands. Use ⌘T for the console.`;
}

/** The type of the key on a row, which decides whether its value is writable. */
export const keyKindAt = (result: QueryResult, row: number): string =>
  result.rows[row]?.[KEY_COL.type] ?? "";

/** One key entry, for tests and for anything building a page by hand. */
export const emptyKeyPage = (): KeyPage => ({
  keys: [] as KeyEntry[],
  cursor: 0,
  scanned: 0,
  exhausted: true,
  total: null,
});
