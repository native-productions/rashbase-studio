/**
 * The registry is what the keyboard layer and the palette both read, so a
 * binding that is claimed twice or a command whose `enabled` disagrees with the
 * surface it opens are both failures that only show up under a fingertip.
 */
import { expect, test } from "bun:test";
import { COMMANDS_BY_ID, runCommand } from "@/lib/commands";
import { useApp } from "@/store/app";
import type { QueryTab } from "@/lib/types";

const tableTab = (patch: Partial<QueryTab> = {}): QueryTab => ({
  id: "tab-1",
  connectionId: "c",
  title: "users",
  object: { schema: "public", name: "users", kind: "table" },
  page: { limit: 200, offset: 0 },
  cursors: [],
  scan: null,
  staged: [],
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

/**
 * A keyspace tab: the same shape, pointed at a flat namespace instead of a
 * relation. `staged` is what the delete gesture fills, and what decides which
 * of the two commands bound to Escape answers.
 */
const keyspaceTab = (patch: Partial<QueryTab> = {}): QueryTab =>
  tableTab({
    object: { schema: "db0", name: "db0", kind: "keyspace" },
    cursors: [0],
    scan: { scanned: 0, exhausted: true },
    staged: [],
    ...patch,
  });

/** A queue tab: rows that are jobs, whose mark means retry rather than delete. */
const queueTab = (patch: Partial<QueryTab> = {}): QueryTab =>
  tableTab({
    object: { schema: "emails", name: "emails", kind: "queue" },
    staged: [],
    ...patch,
  });

/** Every binding must be claimed exactly once, or the first one silently wins. */
function claimants(keys: string): string[] {
  return [...COMMANDS_BY_ID.values()].filter((c) => c.keys === keys).map((c) => c.id);
}

test("⌘F is registered on the filter command, and only on it", () => {
  expect(COMMANDS_BY_ID.get("filter.add")?.keys).toBe("⌘F");
  expect(claimants("⌘F")).toEqual(["filter.add"]);
});

test("⌘I is registered on the row panel, and only on it", () => {
  expect(COMMANDS_BY_ID.get("view.rowPanel")?.keys).toBe("⌘I");
  expect(claimants("⌘I")).toEqual(["view.rowPanel"]);
});

test("⌘⇧K switches database and ⌘⇧N opens the connection sheet", () => {
  // These two traded places. The pairing is what makes a stale hint in the
  // empty state or a sidebar tooltip show up here rather than under a fingertip.
  expect(claimants("⌘⇧K")).toEqual(["connection.database"]);
  expect(claimants("⌘⇧N")).toEqual(["connection.new"]);
});

/**
 * A binding may be shared, but only by commands that can say when they do not
 * apply.
 *
 * The keyboard layer takes the first *enabled* match, so a shared binding is
 * safe exactly when every command holding it declares `enabled`. One that does
 * not is always enabled, so it would swallow the keystroke forever and leave
 * everything after it permanently unreachable — silently, since nothing would
 * throw and the palette would still list them all.
 */
test("a shared binding is only ever held by commands that can be disabled", () => {
  const byKeys = new Map<string, string[]>();
  for (const c of COMMANDS_BY_ID.values()) {
    if (c.keys) byKeys.set(c.keys, [...(byKeys.get(c.keys) ?? []), c.id]);
  }

  for (const [keys, ids] of byKeys) {
    if (ids.length === 1) continue;
    for (const id of ids) {
      const cmd = COMMANDS_BY_ID.get(id)!;
      expect(`${keys}:${id}:${typeof cmd.enabled}`).toBe(`${keys}:${id}:function`);
    }
  }
});

/**
 * Escape is held by two commands, and which one answers depends on the tab.
 * Before the keyboard layer checked `enabled`, the first in the registry took
 * the key whether or not it could act, and the second was dead.
 */
test("escape clears staged deletions and cancels a query, each in its own state", () => {
  const staged = COMMANDS_BY_ID.get("keys.clearStaged")!;
  const cancel = COMMANDS_BY_ID.get("query.cancel")!;
  expect(staged.keys).toBe("Esc");
  expect(cancel.keys).toBe("Esc");

  // A keyspace tab with marks: staged wins, cancel stands down.
  useApp.setState({ tabs: [keyspaceTab({ staged: ["a"] })], activeTabId: "tab-1" });
  expect(staged.enabled!()).toBe(true);
  expect(cancel.enabled!()).toBe(false);

  // A running query with nothing marked: the other way round.
  useApp.setState({ tabs: [tableTab({ running: true })], activeTabId: "tab-1" });
  expect(staged.enabled!()).toBe(false);
  expect(cancel.enabled!()).toBe(true);
});

test("⌘S deletes staged keys, and is offered only when something is staged", () => {
  const commit = COMMANDS_BY_ID.get("keys.commitStaged")!;
  expect(commit.keys).toBe("⌘S");

  useApp.setState({ tabs: [keyspaceTab({ staged: [] })], activeTabId: "tab-1" });
  expect(commit.enabled!()).toBe(false);

  useApp.setState({ tabs: [keyspaceTab({ staged: ["nvp:na:1"] })], activeTabId: "tab-1" });
  expect(commit.enabled!()).toBe(true);

  // Never on a table tab, whose rows are deleted by a statement the user writes.
  useApp.setState({ tabs: [tableTab()], activeTabId: "tab-1" });
  expect(commit.enabled!()).toBe(false);
});

test("clearing staged deletions sends nothing and leaves the rows alone", () => {
  useApp.setState({
    tabs: [keyspaceTab({ staged: ["a", "b"] })],
    activeTabId: "tab-1",
  });
  runCommand("keys.clearStaged");
  expect(useApp.getState().tabs[0]!.staged).toEqual([]);
});

test("⌘F opens the filter editor on the active table tab", () => {
  useApp.setState({ tabs: [tableTab()], activeTabId: "tab-1", filterEditor: null });

  runCommand("filter.add");
  expect(useApp.getState().filterEditor).toEqual({ tabId: "tab-1", index: null });
});

test("it stays shut where there are no rows to filter", () => {
  useApp.setState({ tabs: [tableTab({ view: "structure" })], filterEditor: null });
  runCommand("filter.add");
  expect(useApp.getState().filterEditor).toBeNull();

  useApp.setState({ tabs: [tableTab({ object: null })] });
  runCommand("filter.add");
  expect(useApp.getState().filterEditor).toBeNull();
});

test("⌘I toggles the row panel both ways", () => {
  useApp.setState({ rowPanel: false });
  runCommand("view.rowPanel");
  expect(useApp.getState().rowPanel).toBe(true);
  runCommand("view.rowPanel");
  expect(useApp.getState().rowPanel).toBe(false);
});


/**
 * ⌘S means one of three things and never two.
 *
 * Three staging gestures share the `staged` list and the same key. The failure
 * this names is silent: a row-delete command whose `enabled` says only "not a
 * keyspace" also answers on a queue tab, so ⌘S on staged retries would run a
 * delete path that finds no rows and quietly clears the marks instead of
 * retrying anything.
 */
test("⌘S on a queue with staged jobs retries rather than deleting rows", () => {
  useApp.setState({
    tabs: [
      queueTab({
        staged: ["7"],
        queue: { state: "failed", diagram: null, counts: null, jobs: null } as never,
      }),
    ],
    activeTabId: "tab-1",
    splitTabId: null,
    focusedPane: "main",
  });

  expect(COMMANDS_BY_ID.get("rows.commitStaged")?.enabled?.()).toBe(false);
  expect(COMMANDS_BY_ID.get("rows.clearStaged")?.enabled?.()).toBe(false);
});

test("⌘S on a keyspace with staged keys deletes keys rather than rows", () => {
  useApp.setState({
    tabs: [keyspaceTab({ staged: ["nvp:na:1"] })],
    activeTabId: "tab-1",
    splitTabId: null,
    focusedPane: "main",
  });

  expect(COMMANDS_BY_ID.get("keys.commitStaged")?.enabled?.()).toBe(true);
  expect(COMMANDS_BY_ID.get("rows.commitStaged")?.enabled?.()).toBe(false);
});

test("a table row can only be staged once its primary key is known", () => {
  const columns = [
    { name: "id", dataType: "text", notNull: true, default: null, primaryKey: true, comment: null },
  ];

  // The definition has not arrived yet, so no row can be named.
  useApp.setState({
    tabs: [tableTab({ staged: ["whatever"], columns: null })],
    activeTabId: "tab-1",
    splitTabId: null,
    focusedPane: "main",
  });
  expect(COMMANDS_BY_ID.get("rows.commitStaged")?.enabled?.()).toBe(false);

  useApp.setState({ tabs: [tableTab({ staged: ["whatever"], columns })] });
  expect(COMMANDS_BY_ID.get("rows.commitStaged")?.enabled?.()).toBe(true);
});
