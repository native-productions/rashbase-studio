/**
 * `tabIdle` decides which tab the "open in an idle tab" preference is allowed
 * to overwrite, and every failure here is silent. A tab holding a staged
 * deletion or an active filter that gets recycled does not error — it just
 * quietly becomes a different table, and the marks the user made are gone with
 * nothing on screen to say they ever existed.
 *
 * So each thing that makes a tab busy is asserted on its own. A single test
 * against a fully-idle tab would still pass with any one of these conditions
 * dropped from the implementation.
 */
import { expect, test } from "bun:test";
import { tabIdle } from "@/lib/utils/tabs";
import type { DbObject, QueryTab } from "@/lib/types";

const TABLE: DbObject = { schema: "public", name: "users", kind: "table" };

function tab(p: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "t1",
    connectionId: "c1",
    object: TABLE,
    pinned: false,
    running: false,
    filters: [],
    staged: [],
    selectedRows: [],
    sql: "select * from public.users",
    ...p,
  } as QueryTab;
}

test("a table tab with nothing outstanding on it is idle", () => {
  expect(tabIdle(tab(), null)).toBe(true);
});

test("a filter is a question still being asked", () => {
  expect(tabIdle(tab({ filters: [{} as never] }), null)).toBe(false);
});

test("a staged deletion is a confirmation still pending", () => {
  expect(tabIdle(tab({ staged: ["users:1"] }), null)).toBe(false);
});

test("rows picked out are the answer to 'which ones', typed by hand", () => {
  expect(tabIdle(tab({ selectedRows: ["users:1"] }), null)).toBe(false);
});

test("a pin survives close-other-tabs, so it survives this", () => {
  expect(tabIdle(tab({ pinned: true }), null)).toBe(false);
});

test("a running query has a cancel waiting on it", () => {
  expect(tabIdle(tab({ running: true }), null)).toBe(false);
});

test("the split pane's tab is on screen next to the one being opened", () => {
  expect(tabIdle(tab({ id: "split" }), "split")).toBe(false);
  expect(tabIdle(tab({ id: "other" }), "split")).toBe(true);
});

/**
 * The one asymmetry worth stating: an object tab's SQL is generated, so it
 * means nothing. A query tab's SQL was typed, so it means everything.
 */
test("typed SQL on a query tab is work; generated SQL on an object tab is not", () => {
  expect(tabIdle(tab({ object: null, sql: "" }), null)).toBe(true);
  expect(tabIdle(tab({ object: null, sql: "   \n " }), null)).toBe(true);
  expect(tabIdle(tab({ object: null, sql: "delete from users" }), null)).toBe(false);
  expect(tabIdle(tab({ object: TABLE, sql: "select * from public.users" }), null)).toBe(true);
});
