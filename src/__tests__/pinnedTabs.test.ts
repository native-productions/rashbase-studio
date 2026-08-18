import { expect, test, beforeEach } from "bun:test";
import { loadPinnedTabs, savePinnedTabs } from "@/lib/pinnedTabs";
import type { QueryTab } from "@/lib/types";

const store = new Map<string, string>();
// Bun has no `localStorage`; the module reads it off the global at call time.
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

function tab(p: Partial<QueryTab>): QueryTab {
  return { id: "t", connectionId: "c1", pinned: false, object: null, sql: "", ...p } as QueryTab;
}

beforeEach(() => store.clear());

test("it keeps only pinned tabs, and only what identifies them", () => {
  savePinnedTabs([
    tab({ id: "a", pinned: true, sql: "select 1" }),
    tab({ id: "b", pinned: false, sql: "select 2" }),
  ]);
  expect(loadPinnedTabs()).toEqual([{ connectionId: "c1", object: null, sql: "select 1" }]);
});

test("it drops a pinned tab that has no connection to reopen against", () => {
  savePinnedTabs([tab({ pinned: true, connectionId: null })]);
  expect(loadPinnedTabs()).toEqual([]);
});

test("it ignores stored entries it cannot read", () => {
  store.set("rashbase.pinnedTabs.v1", '[{"connectionId":1},{"connectionId":"c1","sql":"x","object":null},"junk"]');
  expect(loadPinnedTabs()).toEqual([{ connectionId: "c1", sql: "x", object: null }]);
});

test("it survives a store holding something that is not JSON", () => {
  store.set("rashbase.pinnedTabs.v1", "{oops");
  expect(loadPinnedTabs()).toEqual([]);
});
