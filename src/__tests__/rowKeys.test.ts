/**
 * The rule that decides which row a write reaches.
 *
 * Every case here is one where getting it wrong means an UPDATE landing on a
 * row the user did not mean, or on all of them. The status bar and the store
 * both read this function, so a drift here also drifts the preview away from
 * what actually runs.
 */
import { expect, test } from "bun:test";
import { rowKeysFor } from "@/lib/utils/rowKeys";
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
