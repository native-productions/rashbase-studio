/**
 * What ⌘S means on a tab that came from a chip.
 *
 * The failure is silent and cumulative: without the link, saving an edited
 * saved query makes a second chip instead of updating the first, and after a
 * few passes the shelf holds four near-identical statements with no way to
 * tell which one the tab is actually showing. Nothing throws, and the loss is
 * only visible weeks later.
 */
import { beforeEach, expect, mock, test } from "bun:test";

const store = new Map<string, string>();
// Bun has no `localStorage`; the module reads it off the global at call time.
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

// Nothing under test reaches the backend, but importing the store pulls in the
// IPC wrapper, which cannot resolve outside a webview.
mock.module("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no ipc")) }));

const { useApp } = await import("@/store/app");

/** A query tab holding `sql`, as the only tab in the store. */
function withTab(sql: string, savedQueryId: string | null = null) {
  useApp.setState({
    tabs: [
      {
        id: "t1",
        connectionId: "c1",
        object: null,
        sql,
        savedQueryId,
        page: { limit: 500, offset: 0 },
      } as never,
    ],
    activeTabId: "t1",
    focusedPane: "main",
  });
}

beforeEach(() => {
  store.clear();
  useApp.setState({ savedQueries: [], renamingQueryId: null });
});

const saved = () => useApp.getState().savedQueries;
const tab = () => useApp.getState().tabs[0]!;

test("saving an unlinked tab keeps a new query and links the tab to it", () => {
  withTab("select 1");
  useApp.getState().saveQuery("t1");

  expect(saved()).toHaveLength(1);
  expect(saved()[0]).toMatchObject({ sql: "select 1", name: "select 1", connectionId: "c1" });
  expect(tab().savedQueryId).toBe(saved()[0]!.id);
  // The name field opens on the chip that just appeared.
  expect(useApp.getState().renamingQueryId).toBe(saved()[0]!.id);
});

test("saving an edited saved query updates it rather than keeping a second copy", () => {
  withTab("select 1");
  useApp.getState().saveQuery("t1");
  const id = saved()[0]!.id;
  useApp.getState().renameSavedQuery(id, "Ones");

  useApp.setState({ tabs: [{ ...tab(), sql: "select 2" } as never] });
  useApp.getState().saveQuery("t1");

  expect(saved()).toHaveLength(1);
  expect(saved()[0]).toMatchObject({ id, sql: "select 2", name: "Ones" });
  // No chip appeared, so nothing is waiting to be named.
  expect(useApp.getState().renamingQueryId).toBe(null);
});

test("saving as new forks a linked tab, and the tab follows the fork", () => {
  withTab("select 1");
  useApp.getState().saveQuery("t1");
  const first = saved()[0]!.id;

  useApp.setState({ tabs: [{ ...tab(), sql: "select 2" } as never] });
  useApp.getState().saveQueryAsNew("t1");

  expect(saved().map((q) => q.sql)).toEqual(["select 1", "select 2"]);
  expect(tab().savedQueryId).not.toBe(first);
  expect(tab().savedQueryId).toBe(saved()[1]!.id);
});

test("deleting a query unlinks the tabs showing it, leaving the statement alone", () => {
  withTab("select 1");
  useApp.getState().saveQuery("t1");
  useApp.getState().deleteSavedQuery(saved()[0]!.id);

  expect(saved()).toHaveLength(0);
  expect(tab().savedQueryId).toBe(null);
  expect(tab().sql).toBe("select 1");
  // And ⌘S from here keeps a new one rather than updating a query that is gone.
  useApp.getState().saveQuery("t1");
  expect(saved()).toHaveLength(1);
});

test("opening a query reuses a tab with nothing to lose and opens a new one otherwise", () => {
  withTab("select 1");
  useApp.getState().saveQueryAsNew("t1");
  const first = saved()[0]!.id;

  // Empty tab: reused, and now linked.
  useApp.setState({ tabs: [{ ...tab(), sql: "", savedQueryId: null } as never] });
  useApp.getState().openSavedQuery(first);
  expect(useApp.getState().tabs).toHaveLength(1);
  expect(tab().savedQueryId).toBe(first);

  // Edited: the statement in the tab is unsaved work, so it is left standing.
  useApp.setState({ tabs: [{ ...tab(), sql: "select 99" } as never] });
  useApp.getState().openSavedQuery(first);
  expect(useApp.getState().tabs).toHaveLength(2);
  expect(useApp.getState().tabs[0]!.sql).toBe("select 99");
  expect(useApp.getState().tabs[1]!.savedQueryId).toBe(first);
});

test("an emptied name field means the default, not a nameless query", () => {
  withTab("select count(*) from users");
  useApp.getState().saveQuery("t1");
  useApp.getState().renameSavedQuery(saved()[0]!.id, "   ");
  expect(saved()[0]!.name).toBe("select count(*) from users");
});
