/**
 * This decides whether the app runs the statement the user typed or a rewritten
 * one. A wrong "yes" breaks working SQL, or re-runs a write on every page click.
 * A wrong "no" costs only the pager, so every ambiguous case here is asserted
 * to land on "no".
 */
import { expect, test } from "bun:test";
import { maskLiterals, pagedSql, pageable, unpageableReason } from "@/lib/utils/statement";

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

test("masking keeps the string the same length", () => {
  const sql = "select 'a;b' -- note\nfrom t /* x */";
  expect(maskLiterals(sql)).toHaveLength(sql.length);
});

test("a semicolon inside a literal is not a statement boundary", () => {
  expect(maskLiterals("select 'a;b'")).toBe("select      ");
  expect(maskLiterals('select "a;b"')).toBe("select      ");
});

test("a doubled quote does not end the literal", () => {
  // Without this, everything after `o''brien` reads as being outside the string,
  // and the `;` inside it looks like a second statement.
  const sql = "select 'o''brien;' , x";
  expect(maskLiterals(sql)).toBe("select" + " ".repeat(13) + ", x");
});

test("line comments end at the newline and keep it", () => {
  expect(maskLiterals("select 1 -- ;drop\nfrom t")).toBe("select 1         \nfrom t");
});

test("block comments nest, the way Postgres lexes them", () => {
  // A non-nesting scanner would stop at the first `*/` and treat `;` as real.
  expect(maskLiterals("a /* x /* y */ ; */ b")).toBe("a                   b");
});

test("dollar quoting swallows everything up to the matching tag", () => {
  expect(maskLiterals("select $fn$ ';drop' $fn$ , x")).toBe("select                   , x");
  expect(maskLiterals("select $$ a;b $$")).toBe("select          ");
});

test("a backslash escapes only inside an E-string", () => {
  // E'\'' is one string holding a quote. Treating the backslash as ordinary
  // would end the literal early and leave the rest of the line exposed.
  expect(maskLiterals("select E'\\'' , x")).toBe("select" + " ".repeat(7) + ", x");
  // A bare E on the end of an identifier is not an escape-string prefix.
  expect(maskLiterals("select somee'x' , y")).toBe("select somee    , y");
});

test("an unterminated literal swallows the rest, rather than leaking it", () => {
  expect(maskLiterals("select 'oops; drop table t")).toBe("select                    ");
});

// ---------------------------------------------------------------------------
// What may be paged
// ---------------------------------------------------------------------------

test("a plain select is pageable", () => {
  expect(unpageableReason(`SELECT * FROM "users" WHERE "deletedAt" IS NULL`)).toBeNull();
  expect(pageable("select * from users")).toBe(true);
  expect(pageable("  \n select 1  ")).toBe(true);
});

test("one trailing semicolon is punctuation, not a second statement", () => {
  expect(pageable("select * from users;")).toBe(true);
  expect(pageable("select * from users;  \n")).toBe(true);
  expect(pageable("select * from users; -- done")).toBe(true);
});

test("a read-only CTE is pageable", () => {
  expect(pageable("with recent as (select * from orders) select * from recent")).toBe(true);
});

test("a real second statement is not", () => {
  expect(unpageableReason("select 1; select 2")).toBe(
    "the script has more than one statement",
  );
  expect(pageable("set work_mem = '1GB'; select * from users")).toBe(false);
});

test("anything that is not a select is not", () => {
  expect(unpageableReason("insert into t values (1)")).toBe(
    "INSERT does not return a page of rows",
  );
  expect(pageable("update t set a = 1")).toBe(false);
  expect(pageable("explain select * from t")).toBe(false);
  expect(pageable("show all")).toBe(false);
  expect(pageable("")).toBe(false);
  expect(pageable("   ")).toBe(false);
});

test("a statement that already limits itself is left alone", () => {
  expect(unpageableReason("select * from t limit 50")).toBe(
    "the statement sets its own limit",
  );
  expect(pageable("select * from t offset 10")).toBe(false);
  expect(pageable("select * from t fetch first 10 rows only")).toBe(false);
  // A union's limit belongs to the whole statement, so it counts too.
  expect(pageable("select a from x union select b from y limit 5")).toBe(false);
});

test("a limit inside a subquery does not stop the outer statement being paged", () => {
  // The inner limit shapes the data; it is not the statement's own page.
  expect(pageable("select * from (select * from t limit 10) inner_t")).toBe(true);
});

test("a data-modifying CTE is refused, because paging would re-run the write", () => {
  // The failure this whole function exists to prevent: clicking Next would
  // run the DELETE a second time.
  expect(unpageableReason("with gone as (delete from t returning *) select * from gone")).toBe(
    "the statement writes rows, so it must not be re-run per page",
  );
  expect(pageable("with x as (insert into t values (1) returning *) select * from x")).toBe(
    false,
  );
  expect(pageable("with x as (update t set a = 1 returning *) select * from x")).toBe(false);
});

test("row locking is refused, because Postgres rejects it in a subquery", () => {
  expect(unpageableReason("select * from t for update")).toBe("row locking cannot be paged");
  expect(pageable("select * from t for share")).toBe(false);
});

test("SELECT INTO is refused, because it writes a table", () => {
  expect(pageable("select * into backup from users")).toBe(false);
});

test("a write word inside a literal or a comment is not a write", () => {
  expect(pageable("select * from audit where action = 'delete'")).toBe(true);
  expect(pageable("select * from t -- delete this later")).toBe(true);
  expect(pageable('select "delete" from t')).toBe(true);
});

test("a column whose name merely contains a keyword is not a keyword", () => {
  expect(pageable("select deleted_at, limit_amount, offset_days from t")).toBe(true);
});

// ---------------------------------------------------------------------------
// The wrapped statement
// ---------------------------------------------------------------------------

test("the user's SQL goes in untouched", () => {
  expect(pagedSql(`SELECT * FROM "users" WHERE "deletedAt" IS NULL`, 1000, 0)).toBe(
    'select * from (\nSELECT * FROM "users" WHERE "deletedAt" IS NULL\n) as _rashbase_page limit 1000;',
  );
});

test("the first page omits the offset, later pages carry it", () => {
  expect(pagedSql("select 1", 200, 0)).not.toContain("offset");
  expect(pagedSql("select 1", 200, 400)).toContain("limit 200 offset 400");
});

test("fractional paging cannot reach the statement", () => {
  expect(pagedSql("select 1", 200.7, 12.9)).toContain("limit 200 offset 12");
});

test("a trailing semicolon is removed, or it would end the subquery early", () => {
  expect(pagedSql("select 1;", 10, 0)).toBe(
    "select * from (\nselect 1\n) as _rashbase_page limit 10;",
  );
  // Found through the mask, so a trailing comment does not hide it.
  expect(pagedSql("select 1; -- done", 10, 0)).toBe(
    "select * from (\nselect 1\n) as _rashbase_page limit 10;",
  );
});

test("a semicolon inside a literal survives, because it is data", () => {
  expect(pagedSql("select 'a;'", 10, 0)).toContain("select 'a;'\n)");
});
