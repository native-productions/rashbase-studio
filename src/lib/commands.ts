import { selectedSql } from "@/lib/activeEditor";
import { hasRows, isKeyspace } from "@/lib/utils/tabs";
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
  // Ahead of `query.cancel`, and both bound to Escape. The keyboard layer takes
  // the first *enabled* command that matches, so the order here is the priority:
  // staged deletions are the more urgent thing to be able to call off, and a tab
  // can only ever be in one of the two states anyway.
  {
    id: "keys.clearStaged",
    label: "Clear staged deletions",
    group: "Query",
    keys: "Esc",
    enabled: () => {
      const tab = activeTab(s());
      return !!tab && isKeyspace(tab.object) && tab.staged.length > 0;
    },
    run: () => {
      const tab = activeTab(s());
      if (tab) s().clearStaged(tab.id);
    },
  },
  {
    id: "keys.commitStaged",
    label: "Delete staged keys",
    group: "Query",
    keys: "⌘S",
    // The rows are already red and the status bar already prints the command,
    // so this is the confirmation rather than the request for one.
    enabled: () => {
      const tab = activeTab(s());
      return !!tab && isKeyspace(tab.object) && tab.staged.length > 0;
    },
    run: () => {
      const tab = activeTab(s());
      if (tab) void s().commitStaged(tab.id);
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

  {
    id: "export.objects",
    label: "Export tables…",
    group: "Query",
    // ⌘E is the cell expander, which is used far more often than an export is.
    keys: "⌘⇧E",
    enabled: () => !!s().activeConnectionId,
    run: () => {
      const connectionId = s().activeConnectionId;
      if (!connectionId) return;
      // Whatever is picked in the sidebar, or nothing — the dialog carries the
      // whole tree, so opening it with an empty set is a valid place to start.
      const { selection } = s();
      const keys = selection.connectionId === connectionId ? selection.keys : [];
      s().setExportTarget({ connectionId, keys });
    },
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
    // No binding. It is set once and then left alone, and every ⌘-letter this
    // app could reach is worth more to something used daily.
    id: "view.translucency",
    label: "Toggle window translucency",
    group: "View",
    run: () => s().toggleTranslucency(),
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
    id: "view.diagram",
    label: "Show schema diagram",
    group: "View",
    keys: "⌘D",
    // Enabled on any open connection rather than only when the schema is
    // known. This id is also a native menu item, and a menu entry that greys
    // itself out is a worse answer than one that says which gesture to use.
    enabled: () => {
      const id = s().activeConnectionId;
      return !!id && !!s().open[id];
    },
    run: () => {
      const target = diagramSchema();
      if (!target) {
        s().setToast({
          kind: "info",
          text: "Right-click a connection in the sidebar to pick which schema to draw.",
        });
        return;
      }
      s().openObjectTab(target.connectionId, {
        schema: target.schema,
        name: target.schema,
        kind: "diagram",
      });
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

/**
 * Which schema "show me the diagram" means, or null when it is ambiguous.
 *
 * The tab you are looking at first — asking for a diagram while a table is open
 * almost always means that table's schema — and otherwise the connection's only
 * schema. With several schemas and nothing open there is no answer worth
 * guessing at, so the command goes dim and the sidebar's right-click is where
 * you say which one.
 */
function diagramSchema(): { connectionId: string; schema: string } | null {
  const connectionId = s().activeConnectionId;
  if (!connectionId) return null;

  const open = activeTab(s());
  if (open?.connectionId === connectionId && open.object) {
    return { connectionId, schema: open.object.schema };
  }

  const schemas = s().schemas[connectionId] ?? [];
  return schemas.length === 1 ? { connectionId, schema: schemas[0]!.name } : null;
}

export const COMMANDS_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function runCommand(id: string) {
  const cmd = COMMANDS_BY_ID.get(id);
  if (!cmd) return;
  if (cmd.enabled && !cmd.enabled()) return;
  void cmd.run();
}
