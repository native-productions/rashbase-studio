/**
 * What the store actually sends when the user runs the editor.
 *
 * The analyzer is tested on its own in `statement.test.ts`; this covers the
 * wiring around it, which is where a correct decision can still reach the
 * database as the wrong statement — the editor's text rewritten under the
 * caret, a cap that never arrives, or a page that pages the wrong SQL.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import type { QueryTab } from "@/lib/types";

const calls: { name: string; args: Record<string, unknown> }[] = [];

/** Rows the fake backend returns. Set per test to shape the pager. */
let rowsBack = 0;
const TOTAL = 38_412;

mock.module("@tauri-apps/api/core", () => ({
  invoke: (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name !== "execute_query") return Promise.resolve([]);
    return Promise.resolve([
      {
        columns: [{ name: "id", typeName: "int4", typeClass: "number" }],
        rows: Array.from({ length: rowsBack }, (_, i) => [String(i)]),
        rowsAffected: TOTAL,
        truncated: rowsBack < TOTAL,
        durationMs: 1,
      },
    ]);
  },
}));

const { useApp } = await import("@/store/app");

const tab = (patch: Partial<QueryTab> = {}): QueryTab => ({
  id: "q1",
  connectionId: "c",
  title: "Query 1",
  object: null,
  page: { limit: 1000, offset: 0 },
  paged: false,
  pageNote: null,
  sort: null,
  filters: [],
  rowCount: null,
  view: "data",
  columns: null,
  indexes: null,
  selection: null,
  definition: null,
  sql: "",
  results: [],
  activeResultIndex: 0,
  running: false,
  error: null,
  clientMs: null,
  ...patch,
});

const put = (patch: Partial<QueryTab>) =>
  useApp.setState({ tabs: [tab(patch)], activeTabId: "q1" });

const ran = () => calls.filter((c) => c.name === "execute_query");
const lastRun = () => ran().at(-1)?.args as { sql: string; maxRows: number | null } | undefined;
const current = () => useApp.getState().tabs[0]!;

beforeEach(() => {
  calls.length = 0;
  rowsBack = 1000;
});

test("a plain select is wrapped, and the cap rides along", () => {
  put({ sql: `SELECT * FROM "users" WHERE "deletedAt" IS NULL` });
  return useApp
    .getState()
    .runQuery("q1")
    .then(() => {
      expect(lastRun()?.sql).toBe(
        'select * from (\nSELECT * FROM "users" WHERE "deletedAt" IS NULL\n) as _rashbase_page limit 1000;',
      );
      // Belt and braces: the wrap already limits, but a driver that ignored it
      // would still not be able to push 38k rows through the window.
      expect(lastRun()?.maxRows).toBe(1000);
      expect(current().paged).toBe(true);
      expect(current().pageNote).toBeNull();
    });
});

test("the editor's own text is never rewritten", async () => {
  const typed = "select * from users";
  put({ sql: typed });
  await useApp.getState().runQuery("q1");
  // The statement sent is wrapped; the statement on the tab is what was typed.
  expect(lastRun()?.sql).not.toBe(typed);
  expect(current().sql).toBe(typed);
});

test("a statement that cannot be wrapped is sent verbatim, capped, and says why", async () => {
  put({ sql: "set work_mem = '1GB'; select * from users" });
  await useApp.getState().runQuery("q1");

  expect(lastRun()?.sql).toBe("set work_mem = '1GB'; select * from users");
  expect(lastRun()?.maxRows).toBe(1000);
  expect(current().paged).toBe(false);
  expect(current().pageNote).toBe("the script has more than one statement");
});

test("a write is never wrapped, so paging cannot re-run it", async () => {
  put({ sql: "with gone as (delete from t returning *) select * from gone" });
  await useApp.getState().runQuery("q1");

  expect(lastRun()?.sql).toBe("with gone as (delete from t returning *) select * from gone");
  expect(current().paged).toBe(false);
});

test("next page re-runs the typed SQL at the new offset", async () => {
  put({ sql: "select * from users" });
  await useApp.getState().runQuery("q1");
  useApp.getState().goPage("q1", 1);
  await Promise.resolve();
  await Promise.resolve();

  expect(current().page.offset).toBe(1000);
  expect(lastRun()?.sql).toContain("limit 1000 offset 1000");
  expect(lastRun()?.sql).toContain("select * from users");
});

test("changing the page size goes back to the first page", async () => {
  put({ sql: "select * from users", page: { limit: 1000, offset: 3000 } });
  useApp.getState().setPageLimit("q1", 200);
  await Promise.resolve();
  await Promise.resolve();

  expect(current().page).toEqual({ limit: 200, offset: 0 });
  expect(lastRun()?.sql).toContain("limit 200");
  expect(lastRun()?.sql).not.toContain("offset");
});

test("editing the statement drops the page you were on", () => {
  put({ sql: "select * from users", page: { limit: 1000, offset: 2000 } });
  useApp.getState().setTabSql("q1", "select * from orders");
  expect(current().page.offset).toBe(0);
});

test("a table tab still runs its own generated SQL, unwrapped", async () => {
  put({
    object: { schema: "public", name: "users", kind: "table" },
    sql: 'select * from "public"."users" limit 200;',
    page: { limit: 200, offset: 0 },
  });
  await useApp.getState().runQuery("q1");

  expect(lastRun()?.sql).toBe('select * from "public"."users" limit 200;');
  expect(current().paged).toBe(false);
  expect(current().pageNote).toBe("the rows come from a table tab");
});
