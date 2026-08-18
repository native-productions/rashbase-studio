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

test("no two commands share a binding", () => {
  const bound = [...COMMANDS_BY_ID.values()].flatMap((c) => (c.keys ? [c.keys] : []));
  expect(bound.length).toBe(new Set(bound).size);
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
