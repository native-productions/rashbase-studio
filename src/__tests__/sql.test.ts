import { expect, test } from "bun:test";
import {
  dropStatement,
  filterWhere,
  insertStatement,
  quoteIdent,
  quoteLiteral,
  selectStatement,
  tableCountSql,
  tablePageSql,
  truncateStatement,
  updatePreview,
  updateStatement,
} from "@/lib/utils/sql";
import type { Filter, FilterOp } from "@/lib/types";

const COLUMNS = [
  { name: "id", primaryKey: true },
  { name: "email", primaryKey: false },
  { name: "createdAt", primaryKey: false },
];

test("doubles embedded quotes so an identifier cannot end early", () => {
  expect(quoteIdent("users")).toBe('"users"');
  expect(quoteIdent("MixedCase")).toBe('"MixedCase"');
  expect(quoteIdent('a"; drop table users; --')).toBe('"a""; drop table users; --"');
});

test("first page of an unsorted table omits the offset", () => {
  expect(tablePageSql({ schema: "public", table: "users", limit: 200, offset: 0 })).toBe(
    'select * from "public"."users" limit 200;',
  );
});

test("later pages carry the offset", () => {
  expect(tablePageSql({ schema: "public", table: "users", limit: 200, offset: 400 })).toBe(
    'select * from "public"."users" limit 200 offset 400;',
  );
});

test("sort lands between the table and the limit", () => {
  expect(
    tablePageSql({
      schema: "public",
      table: "users",
      sort: { column: "createdAt", dir: "desc" },
      limit: 50,
      offset: 50,
    }),
  ).toBe('select * from "public"."users" order by "createdAt" desc limit 50 offset 50;');
});

test("fractional limits and offsets cannot reach the statement", () => {
  expect(tablePageSql({ schema: "s", table: "t", limit: 200.7, offset: 12.9 })).toBe(
    'select * from "s"."t" limit 200 offset 12;',
  );
});

test("select names every column", () => {
  expect(selectStatement("public", "users", COLUMNS)).toBe(
    'select "id", "email", "createdAt"\nfrom "public"."users"\nlimit 500;',
  );
});

test("select falls back to a star when the columns are unknown", () => {
  expect(selectStatement("public", "users", [])).toBe('select *\nfrom "public"."users"\nlimit 500;');
});

test("insert numbers its placeholders from one", () => {
  expect(insertStatement("public", "users", COLUMNS)).toBe(
    'insert into "public"."users" ("id", "email", "createdAt")\nvalues ($1, $2, $3);',
  );
});

test("update sets the non-key columns and keys on the primary key", () => {
  expect(updateStatement("public", "users", COLUMNS)).toBe(
    'update "public"."users"\nset "email" = $1,\n    "createdAt" = $2\nwhere "id" = $3;',
  );
});

test("update without a primary key refuses to write a bare where", () => {
  const sql = updateStatement("public", "logs", [
    { name: "level", primaryKey: false },
    { name: "body", primaryKey: false },
  ]);
  expect(sql).toContain("-- no primary key");
  // The dangerous version of this statement is one that runs against everything.
  expect(sql).not.toMatch(/where\s*;/);
});

test("drop names the right object kind and never cascades", () => {
  expect(dropStatement("public", "users", "table")).toBe('drop table "public"."users";');
  expect(dropStatement("public", "active_users", "view")).toBe(
    'drop view "public"."active_users";',
  );
  expect(dropStatement("public", "daily", "matview")).toBe(
    'drop materialized view "public"."daily";',
  );
  expect(dropStatement("public", "users", "table")).not.toContain("cascade");
});

test("truncate targets one table", () => {
  expect(truncateStatement("public", "users")).toBe('truncate table "public"."users";');
});

test("statement builders quote identifiers", () => {
  expect(insertStatement("public", 'we"ird', [{ name: 'a"b', primaryKey: false }])).toBe(
    'insert into "public"."we""ird" ("a""b")\nvalues ($1);',
  );
});

// ---------------------------------------------------------------------------
// The pending write, as the status bar shows it
// ---------------------------------------------------------------------------

test("the preview keeps the value as a parameter, because that is what runs", () => {
  expect(
    updatePreview({
      schema: "public",
      table: "users",
      column: "email",
      keys: [{ column: "id", value: "2" }],
    }),
  ).toBe(`update "public"."users" set "email" = $1 where "id" = '2'`);
});

test("a composite key shows every part of the row's identity", () => {
  expect(
    updatePreview({
      schema: "app",
      table: "events",
      column: "payload",
      keys: [
        { column: "tenant", value: "a-b-c" },
        { column: "seq", value: "9" },
      ],
    }),
  ).toBe(`update "app"."events" set "payload" = $1 where "tenant" = 'a-b-c' and "seq" = '9'`);
});

test("a key value with a quote in it stays readable and closed", () => {
  expect(
    updatePreview({
      schema: "public",
      table: "t",
      column: "c",
      keys: [{ column: "name", value: "o'brien" }],
    }),
  ).toBe(`update "public"."t" set "c" = $1 where "name" = 'o''brien'`);
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

let filterSeq = 0;
const f = (column: string | null, op: FilterOp, ...values: string[]): Filter => ({
  id: `f${++filterSeq}`,
  column,
  op,
  values,
});

const COLS = ["id", "email"];

test("doubles embedded quotes so a value cannot end the literal", () => {
  expect(quoteLiteral("plain")).toBe("'plain'");
  expect(quoteLiteral("o'brien")).toBe("'o''brien'");
  expect(quoteLiteral("'; drop table users; --")).toBe("'''; drop table users; --'");
});

test("a NUL never reaches the statement", () => {
  expect(quoteLiteral("a\0b")).toBe("'ab'");
});

test("comparisons emit a quoted literal, which Postgres coerces to the column type", () => {
  expect(filterWhere([f("id", "eq", "5")], COLS)).toBe(`"id" = '5'`);
  expect(filterWhere([f("id", "gte", "5")], COLS)).toBe(`"id" >= '5'`);
  expect(filterWhere([f("id", "neq", "5")], COLS)).toBe(`"id" <> '5'`);
});

test("multiple filters are ANDed", () => {
  expect(filterWhere([f("id", "gt", "5"), f("email", "eq", "a@b.c")], COLS)).toBe(
    `"id" > '5' and "email" = 'a@b.c'`,
  );
});

test("text operators cast the column so they work on any type", () => {
  expect(filterWhere([f("id", "ilike", "%5%")], COLS)).toBe(`("id")::text ilike '%5%'`);
  expect(filterWhere([f("id", "contains", "5")], COLS)).toBe(`("id")::text ilike '%5%'`);
});

test("contains escapes wildcards, like passes them through", () => {
  expect(filterWhere([f("email", "contains", "50%_off")], COLS)).toBe(
    `("email")::text ilike '%50\\%\\_off%'`,
  );
  expect(filterWhere([f("email", "like", "50%")], COLS)).toBe(`("email")::text like '50%'`);
});

test("in splits one field into a list", () => {
  expect(filterWhere([f("id", "in", " 1, 2 ,3 ")], COLS)).toBe(`"id" in ('1', '2', '3')`);
  expect(filterWhere([f("id", "notIn", "1")], COLS)).toBe(`"id" not in ('1')`);
});

test("an in list that parses to nothing produces no condition, never in ()", () => {
  expect(filterWhere([f("id", "in", " , , ")], COLS)).toBeNull();
  expect(filterWhere([f("id", "in", "")], COLS)).toBeNull();
});

test("a half-typed filter contributes nothing rather than a guess", () => {
  expect(filterWhere([f("id", "between", "5")], COLS)).toBeNull();
  expect(filterWhere([f("id", "between", "5", "")], COLS)).toBeNull();
  expect(filterWhere([f("id", "eq")], COLS)).toBeNull();
  // The complete one still runs.
  expect(filterWhere([f("id", "eq"), f("email", "eq", "a")], COLS)).toBe(`"email" = 'a'`);
});

test("between takes both bounds in order", () => {
  expect(filterWhere([f("id", "between", "1", "9")], COLS)).toBe(`"id" between '1' and '9'`);
  expect(filterWhere([f("id", "notBetween", "1", "9")], COLS)).toBe(
    `"id" not between '1' and '9'`,
  );
});

test("null checks need no value and read the column uncast", () => {
  expect(filterWhere([f("email", "isNull")], COLS)).toBe(`"email" is null`);
  expect(filterWhere([f("email", "isNotNull")], COLS)).toBe(`"email" is not null`);
});

test("any column ORs the condition across every column, each cast to text", () => {
  expect(filterWhere([f(null, "contains", "ab")], COLS)).toBe(
    `(("id")::text ilike '%ab%' or ("email")::text ilike '%ab%')`,
  );
  expect(filterWhere([f(null, "eq", "7")], COLS)).toBe(
    `(("id")::text = '7' or ("email")::text = '7')`,
  );
});

test("any column with no columns known contributes nothing", () => {
  expect(filterWhere([f(null, "contains", "ab")], [])).toBeNull();
});

test("where lands between the table and the order by", () => {
  expect(
    tablePageSql({
      schema: "public",
      table: "users",
      filters: [f("email", "contains", "a")],
      columns: COLS,
      sort: { column: "id", dir: "desc" },
      limit: 200,
      offset: 200,
    }),
  ).toBe(
    `select * from "public"."users" where ("email")::text ilike '%a%' order by "id" desc limit 200 offset 200;`,
  );
});

test("no filters leaves the page statement exactly as it was", () => {
  expect(
    tablePageSql({ schema: "public", table: "users", filters: [], columns: COLS, limit: 200, offset: 0 }),
  ).toBe('select * from "public"."users" limit 200;');
});

test("count carries the same where as the page", () => {
  expect(
    tableCountSql({ schema: "public", table: "users", filters: [f("id", "eq", "5")], columns: COLS }),
  ).toBe(`select count(*) from "public"."users" where "id" = '5';`);
  expect(tableCountSql({ schema: "public", table: "users" })).toBe(
    'select count(*) from "public"."users";',
  );
});
