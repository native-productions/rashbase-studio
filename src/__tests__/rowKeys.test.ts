/**
 * The rule that decides which row a write reaches.
 *
 * Every case here is one where getting it wrong means an UPDATE landing on a
 * row the user did not mean, or on all of them. The status bar and the store
 * both read this function, so a drift here also drifts the preview away from
 * what actually runs.
 */
import { expect, test } from "bun:test";
import { rowKeysFor, rowStageKey, stagedRowsIn } from "@/lib/utils/rowKeys";
import type { ColumnInfo, ColumnMeta, QueryResult } from "@/lib/types";

const info = (name: string, primaryKey = false): ColumnInfo => ({
  name,
  dataType: "text",
  notNull: false,
  default: null,
  primaryKey,
  comment: null,
});

const meta = (name: string): ColumnMeta => ({ name, typeName: "text", typeClass: "text" });

const result = (names: string[], rows: (string | null)[][]): QueryResult => ({
  columns: names.map(meta),
  rows,
  rowsAffected: 0,
  durationMs: 0,
});

test("a single-column key names the row by that column", () => {
  const r = rowKeysFor(
    [info("id", true), info("email")],
    result(["id", "email"], [["7", "a@b.c"]]),
    0,
  );
  expect(r).toEqual({ ok: true, keys: [{ column: "id", value: "7" }] });
});

test("a composite key carries every part, in definition order", () => {
  // Order matters: the backend numbers the bound parameters by this sequence.
  const r = rowKeysFor(
    [info("tenant", true), info("seq", true), info("payload")],
    result(["payload", "seq", "tenant"], [["{}", "9", "a-b-c"]]),
    0,
  );
  expect(r).toEqual({
    ok: true,
    keys: [
      { column: "tenant", value: "a-b-c" },
      { column: "seq", value: "9" },
    ],
  });
});

test("a key column missing from the result names itself in the refusal", () => {
  // `select email from users` cannot identify a row, and the user needs to be
  // told which column would have been needed rather than "something failed".
  const r = rowKeysFor([info("id", true), info("email")], result(["email"], [["a@b.c"]]), 0);
  expect(r).toEqual({ ok: false, missing: "id" });
});

test("a NULL key identifies nothing, even though the column is there", () => {
  const r = rowKeysFor([info("id", true)], result(["id"], [[null]]), 0);
  expect(r).toEqual({ ok: false, missing: "id" });
});

test("a table with no primary key refuses without naming a column", () => {
  const r = rowKeysFor([info("level"), info("body")], result(["level", "body"], [["warn", "x"]]), 0);
  expect(r).toEqual({ ok: false, missing: null });
});

test("columns that have not arrived yet refuse rather than write unkeyed", () => {
  expect(rowKeysFor(null, result(["id"], [["1"]]), 0)).toEqual({ ok: false, missing: null });
});

test("a row index past the end refuses", () => {
  // Reachable when a page is replaced while an editor is open.
  expect(rowKeysFor([info("id", true)], result(["id"], [["1"]]), 5)).toEqual({
    ok: false,
    missing: null,
  });
});

test("the key is read from the row asked for, not the first one", () => {
  const r = rowKeysFor([info("id", true)], result(["id"], [["1"], ["2"], ["3"]]), 2);
  expect(r).toEqual({ ok: true, keys: [{ column: "id", value: "3" }] });
});

/**
 * What a staged row is remembered by.
 *
 * The failure this names: staging by row index. Indices are rebuilt on every
 * page and a stale one paints — and then deletes — a different row than the one
 * the user marked. Identity has to survive the rows moving under it, and two
 * reads of the same row have to produce the same string or the mark disappears
 * the moment the grid re-renders.
 */
test("a row's stage key is stable and distinguishes rows", () => {
  const columns = [info("id", true), info("email")];
  const r = result(["id", "email"], [["1", "a@x"], ["2", "b@x"]]);

  const first = rowKeysFor(columns, r, 0);
  const again = rowKeysFor(columns, r, 0);
  expect(first.ok && again.ok).toBe(true);
  expect(rowStageKey((first as { keys: never[] }).keys)).toBe(
    rowStageKey((again as { keys: never[] }).keys),
  );

  const second = rowKeysFor(columns, r, 1);
  expect(rowStageKey((first as { keys: never[] }).keys)).not.toBe(
    rowStageKey((second as { keys: never[] }).keys),
  );
});

/**
 * Only what is on screen. A row staged before a page turn is one the user can
 * no longer see, and deleting it would be the app destroying something it
 * stopped showing them.
 */
test("staged rows still on screen are returned, in screen order", () => {
  const columns = [info("id", true)];
  const r = result(["id"], [["1"], ["2"], ["3"]]);
  const staged = new Set([
    rowStageKey([{ column: "id", value: "3" }]),
    rowStageKey([{ column: "id", value: "1" }]),
    // Staged on a page that has since been turned away from.
    rowStageKey([{ column: "id", value: "99" }]),
  ]);

  expect(stagedRowsIn(columns, r, staged)).toEqual([
    [{ column: "id", value: "1" }],
    [{ column: "id", value: "3" }],
  ]);
});

/** No primary key means no identity, so nothing can be staged against it. */
test("rows that cannot be named are never staged", () => {
  const r = result(["id"], [["1"]]);
  expect(stagedRowsIn([info("id")], r, new Set(["anything"]))).toEqual([]);
  expect(stagedRowsIn(null, r, new Set(["anything"]))).toEqual([]);
});
