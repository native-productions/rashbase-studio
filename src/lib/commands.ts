import { selectedSql } from "@/lib/activeEditor";
import { hasRows } from "@/lib/utils/tabs";
import { useApp, activeTab } from "@/store/app";

/**
 * One registry drives both the keyboard layer and the command palette.
 *
 * Registering a command in two places is how keybindings and palettes drift
 * apart, so there is exactly one list and both consumers read it.
 */
export interface Command {
  id: string;
  label: string;
  group: string;
  /** Display form, e.g. "⌘⏎". Parsed by `hotkeys.ts`, so keep the shape. */
  keys?: string;
  run: () => void | Promise<void>;
  enabled?: () => boolean;
}

const s = () => useApp.getState();

export const COMMANDS: Command[] = [
  // ---- Query ------------------------------------------------------------
  {
    id: "query.run",
    label: "Run query",
    group: "Query",
    keys: "⌘⏎",
    enabled: () => !!activeTab(s()),
    run: () => {
      const tab = activeTab(s());
      // A selection means "run just this", which is how you test one statement
      // inside a long script without deleting the rest.
      if (tab) void s().runQuery(tab.id, selectedSql() ?? undefined);
    },
  },
  {
    id: "query.cancel",
    label: "Cancel running query",
    group: "Query",
    keys: "Esc",
    enabled: () => !!activeTab(s())?.running,
    run: () => {
      const tab = activeTab(s());
      if (tab) void s().cancelQuery(tab.id);
    },
  },
  {
    id: "query.refresh",
    label: "Refresh result",
    group: "Query",
    keys: "⌘R",
    enabled: () => !!activeTab(s()),
    run: () => {
      const tab = activeTab(s());
      if (tab) void s().runQuery(tab.id);
    },
  },

  {
    id: "filter.add",
    label: "Filter rows",
    group: "Query",
    keys: "⌘F",
    // Same condition as the filter bar itself, so the palette never offers a
    // command that opens nothing.
    enabled: () => {
      const tab = activeTab(s());
      return !!tab && tab.view === "data" && hasRows(tab.object);
    },
    run: () => {
      const tab = activeTab(s());
      if (tab) s().setFilterEditor({ tabId: tab.id, index: null });
    },
  },

  // ---- Tabs -------------------------------------------------------------
  {
    id: "tab.new",
    label: "New query tab",
    group: "Tabs",
    keys: "⌘T",
    run: () => s().openTab(),
  },
  {
    id: "tab.close",
    label: "Close tab",
    group: "Tabs",
    keys: "⌘W",
    enabled: () => !!s().activeTabId,
    run: () => {
      const id = s().activeTabId;
      if (id) s().closeTab(id);
    },
  },
  {
    id: "tab.next",
    label: "Next tab",
    group: "Tabs",
    keys: "⌃⇥",
    run: () => s().cycleTab(1),
  },
  {
    id: "tab.prev",
    label: "Previous tab",
    group: "Tabs",
    keys: "⌃⇧⇥",
    run: () => s().cycleTab(-1),
  },

  // ---- Connections ------------------------------------------------------
  {
    id: "connection.new",
    label: "New connection",
    group: "Connection",
    keys: "⌘⇧N",
    run: () => s().setSheet(true, null),
  },
  {
    id: "connection.database",
    label: "Switch database",
    group: "Connection",
    keys: "⌘⇧K",
    // The list comes off an open session, so there is nothing to offer until
    // one exists.
    enabled: () => {
      const id = s().activeConnectionId;
      return !!id && !!s().open[id];
    },
    run: () => {
      const id = s().activeConnectionId;
      if (!id) return;
      s().setPalette(s().palette === "databases" ? null : "databases");
      void s().loadDatabases(id);
    },
  },
  {
    id: "connection.disconnect",
    label: "Disconnect current",
    group: "Connection",
    enabled: () => !!s().activeConnectionId,
    run: () => {
      const id = s().activeConnectionId;
      if (id) void s().disconnect(id);
    },
  },

  // ---- View -------------------------------------------------------------
  {
    id: "view.sidebar",
    label: "Toggle sidebar",
    group: "View",
    keys: "⌘B",
    run: () => s().toggleSidebar(),
  },
  {
    id: "view.palette",
    label: "Command palette",
    group: "View",
    keys: "⌘K",
    run: () => s().setPalette(s().palette === "commands" ? null : "commands"),
  },
  {
    id: "view.rowPanel",
    label: "Toggle row panel",
    group: "View",
    keys: "⌘I",
    run: () => s().toggleRowPanel(),
  },
  {
    id: "view.expandCell",
    label: "Expand cell",
    group: "View",
    keys: "⌘E",
    enabled: () => !!activeTab(s())?.selection,
    run: () => {
      const tab = activeTab(s());
      if (!tab?.selection) return;
      s().openCellView(tab.id, tab.selection.row, tab.selection.col);
    },
  },
  {
    id: "view.tables",
    label: "Go to table",
    group: "View",
    keys: "⌘P",
    enabled: () => !!s().activeConnectionId,
    run: () => {
      const id = s().activeConnectionId;
      if (!id) return;
      s().setPalette(s().palette === "tables" ? null : "tables");
      void s().loadAllTables(id);
    },
  },
];

export const COMMANDS_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function runCommand(id: string) {
  const cmd = COMMANDS_BY_ID.get(id);
  if (!cmd) return;
  if (cmd.enabled && !cmd.enabled()) return;
  void cmd.run();
}
