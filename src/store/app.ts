import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import { CREDENTIAL_UNREADABLE, SSH_SECRET_REQUIRED } from "@/lib/constants/errors";
import { DEFAULT_PAGE_LIMIT, DEFAULT_QUERY_LIMIT } from "@/lib/constants/grid";
import {
  dropStatement,
  tableCountSql,
  tablePageSql,
  truncateStatement,
} from "@/lib/utils/sql";
import { asDbError } from "@/lib/utils/errors";
import { loadPinnedTabs, savePinnedTabs } from "@/lib/pinnedTabs";
import {
  defaultName,
  loadSavedQueries,
  saveSavedQueries,
  type SavedQuery,
} from "@/lib/savedQueries";
import { applyTranslucency, loadTranslucency, saveTranslucency } from "@/lib/translucency";
import { applyPrefs, loadPrefs, savePrefs, type Prefs } from "@/lib/prefs";
import { biometricSupport, DEFAULT_POLICY, type BiometricSupport } from "@/lib/security";
import { isServerOnly, siblingSessions } from "@/lib/utils/connections";
import { isKeyspaceDriver } from "@/lib/constants/connection";
import {
  formatTtl,
  keyFilterFrom,
  keyPageToResult,
  keyRowIdentity,
  parseTtl,
  stagedKeysIn,
} from "@/lib/utils/redis";
import {
  cellEditableReason,
  hasRows,
  isKeyspace,
  isQueue,
  rowsDeletable,
  tabColumns,
  tabIdle,
} from "@/lib/utils/tabs";
import {
  DEFAULT_PREFIX,
  EVENT_MEMORY,
  EVENT_PAGE,
  QUEUE_LIMIT,
  RETRYABLE_STATES,
} from "@/lib/constants/bullmq";
import { edgeRates, jobsToResult, retryOutcome, stagedJobsIn } from "@/lib/utils/bullmq";
import { rowKeysFor, rowStageKey, stagedRowsIn } from "@/lib/utils/rowKeys";
import { rangeBetween, toggle as toggleKey } from "@/lib/utils/selection";
import { pagedSql, unpageableReason } from "@/lib/utils/statement";
import type {
  ColumnRef,
  ConnectionConfig,
  ConnectionInfo,
  DbError,
  DbObject,
  Filter,
  FunctionEntry,
  PaletteMode,
  QueueEntry,
  QueryTab,
  SchemaEntry,
  SchemaGraph,
  SecurityPolicy,
  Sort,
  TableEntry,
} from "@/lib/types";

/** Which half of a split the tab is in. One pane is `main` and nothing else. */
export type PaneId = "main" | "split";

let tabSeq = 0;
function newTab(connectionId: string | null, object: DbObject | null = null): QueryTab {
  tabSeq += 1;
  return {
    id: `tab-${tabSeq}`,
    connectionId,
    title: object ? object.name : `Query ${tabSeq}`,
    object,
    pinned: false,
    // A table page and a query cap are the same number in different clothes,
    // so they share the field — but not the default. A table is browsed a page
    // at a time; a query is usually a question whose answer should fit.
    page: { limit: object ? DEFAULT_PAGE_LIMIT : DEFAULT_QUERY_LIMIT, offset: 0 },
    cursors: [],
    scan: null,
    staged: [],
    selectedRows: [],
    paged: false,
    pageNote: null,
    sort: null,
    filters: [],
    rowCount: null,
    view:
      object?.kind === "diagram"
        ? "diagram"
        : // A queue has rows — its jobs — but `hasRows` is false for it, because
          // that flag gates the machinery that assumes a relation. The view it
          // shows is still the data one, and `viewsFor` offers only that.
          hasRows(object) || object?.kind === "queue"
          ? "data"
          : "definition",
    columns: null,
    indexes: null,
    graph: null,
    savedQueryId: null,
    queue:
      object?.kind === "queue"
        ? {
            prefix: DEFAULT_PREFIX,
            counts: {},
            paused: false,
            legacyPaused: 0,
            state: null,
            jobs: [],
            order: "recent-first",
            total: 0,
            readAtEventId: "",
            // Null, not an empty map: nothing has been measured yet, and an
            // empty map would draw every edge as idle before the first poll.
            rates: null,
            lastEventId: "",
            events: [],
            live: true,
          }
        : null,
    selection: null,
    definition: null,
    sql: hasRows(object)
      ? tablePageSql({
          schema: object!.schema,
          table: object!.name,
          limit: DEFAULT_PAGE_LIMIT,
          offset: 0,
        })
      : "",
    results: [],
    activeResultIndex: 0,
    running: false,
    error: null,
    clientMs: null,
  };
}

interface AppState {
  connections: ConnectionConfig[];
  open: Record<string, ConnectionInfo>;
  activeConnectionId: string | null;

  /** Databases on each connection's server, keyed by connection id. */
  databases: Record<string, string[]>;
  /**
   * BullMQ queues found on each connection, keyed by connection id.
   *
   * Beside `databases` rather than inside it: a queue is not a database, and
   * one Redis database holds all of an application's queues at once.
   */
  queues: Record<string, QueueEntry[]>;
  /** What the last discovery walk cost, so the sidebar can state it. */
  queueScan: Record<string, { scanned: number; exhausted: boolean }>;
  schemas: Record<string, SchemaEntry[]>;
  tables: Record<string, TableEntry[]>;
  functions: Record<string, FunctionEntry[]>;
  expandedSchemas: Record<string, boolean>;
  /**
   * Schema graphs, keyed `connectionId::schema`.
   *
   * Beside `tab.graph` rather than instead of it, and the difference is what
   * forgets them. A diagram tab's copy dies with the tab, which is right for
   * something drawn once and panned around. The editor's foreign-key
   * completion asks on every `join` in every tab, so its copy lives as long as
   * the connection does.
   */
  graphs: Record<string, SchemaGraph>;

  /** The user's saved statements, every connection's, newest last. */
  savedQueries: SavedQuery[];
  /**
   * The chip whose name is being typed, or null.
   *
   * ⌘S saves and opens the field in one move rather than asking first: the
   * name is optional, and a prompt in front of every save would cost more than
   * the statement is worth. Held in the store because the command that starts
   * the rename and the bar that draws the field are not the same component.
   */
  renamingQueryId: string | null;

  tabs: QueryTab[];
  activeTabId: string | null;
  /**
   * The tab in the second pane, or null for one pane.
   *
   * A second id rather than a list of panes: two is what a screen this wide
   * holds, and everything that reads "the tab" — the status bar, every
   * command — needs one answer, which `focusedPane` gives it.
   */
  splitTabId: string | null;
  /** Which of the two the keyboard is talking to. */
  focusedPane: PaneId;

  sidebarVisible: boolean;
  /**
   * Whether the desktop shows through the chrome. Here rather than in a
   * settings module because the command palette is the only surface that
   * changes it, and the palette reads this store.
   */
  translucent: boolean;
  /**
   * Theme, font scale, and what opening an object does to the tab strip.
   *
   * Beside `translucent` rather than folded into it: both are appearance, but
   * translucency is one switch the palette has always owned, and these three
   * are the Settings sheet's own. Persisted by `lib/prefs.ts`.
   */
  prefs: Prefs;
  /** Whether the Settings sheet is open. */
  settings: boolean;
  /**
   * The Touch ID policy, mirrored from the backend.
   *
   * A mirror for drawing with, not the thing being obeyed: the gate is in
   * `commands/security.rs`, in front of the keystore read. Everything here
   * decides is what the Settings sheet and the sidebar lock glyph show.
   */
  security: SecurityPolicy;
  /** What this platform can actually offer. Resolved once, at launch. */
  biometrics: BiometricSupport;
  /**
   * Whether the app is behind the launch prompt.
   *
   * Starts true so the very first frame is the lock screen rather than the
   * workspace: `loadSecurity` is what lets it go, and it does so immediately
   * when the policy says the app is not locked. The alternative — start
   * unlocked, lock once the policy arrives — shows the connection list for one
   * frame, which is the one thing the lock exists to prevent.
   */
  locked: boolean;
  palette: PaletteMode | null;
  /**
   * `credentialLost` means the sheet was opened because the stored password
   * could not be read, which changes what an empty password field means: the
   * saved secret is not worth keeping, so blank clears it instead.
   *
   * `sshSecretLost` is the same situation one layer down, on the tunnel's
   * passphrase or jump-host password. Two flags rather than one, because the
   * sheet has two secret fields and reopening on the wrong one asks the user
   * to retype something that was never the problem.
   */
  sheet: {
    open: boolean;
    editing: ConnectionConfig | null;
    credentialLost: boolean;
    sshSecretLost: boolean;
  };
  /**
   * Which filter the editor is open on. Lives here rather than in the bar so
   * ⌘F can open it. `index: null` means a filter that does not exist yet.
   */
  filterEditor: { tabId: string; index: number | null } | null;
  /**
   * The row panel. Global rather than per tab, like `sidebarVisible`: it is a
   * decision about the workspace, not about one table.
   */
  rowPanel: boolean;
  /**
   * The open cell editor. Here rather than in the grid because the status bar
   * renders the statement it is about to run, and because the grid and the row
   * panel are two doors into the same edit.
   */
  /**
   * The one cell being written to, and which surface opened it. Both the grid
   * and the row panel can start an edit on the same cell, and without the
   * `where` tag both would draw an editor for it at once.
   */
  cellEdit: {
    tabId: string;
    row: number;
    col: number;
    draft: string;
    isNull: boolean;
    where: "grid" | "panel";
  } | null;
  /**
   * The cell open in the expanded editor, if any.
   *
   * Separate from `cellEdit` because expanding is also how a value is *read*:
   * a query result cannot be written to and still deserves somewhere to show a
   * jsonb document at full size. The write, when there is one, is handed back
   * to `cellEdit` so there is still exactly one path to the database.
   */
  cellView: { tabId: string; row: number; col: number } | null;
  /**
   * What the app is waiting on a server for: keyed by the thing that is
   * waiting, valued by what to call it out loud.
   *
   * One map rather than a flag per call, because the surfaces that need this
   * are not the ones that start it. The sidebar row that was clicked wants a
   * spinner in place of its status dot, and the status bar wants a sentence,
   * and neither of them is where `connect` is awaited. A connection over an
   * SSH tunnel can take ten seconds; ten seconds of nothing is the app looking
   * broken.
   */
  busy: Record<string, string>;
  toast: { kind: "error" | "info"; text: string } | null;
  /**
   * A refusal that has to be read rather than glimpsed.
   *
   * A toast is right for "deleted 3 rows" and wrong for a foreign key
   * violation: that one arrives with a detail line naming the referencing table
   * and the row that holds the reference, which is the whole of what the user
   * needs and far too much to fit in a corner that fades after six seconds.
   * Errors that end a write the user explicitly confirmed go here instead.
   */
  errorDialog: { title: string; error: DbError } | null;

  /**
   * Which sidebar objects are picked, and where a range measures from.
   *
   * Keyed `schema.name` and scoped to one connection: a selection made in one
   * database means nothing in another, and carrying it across would offer to
   * export tables that are not there. Read only when `connectionId` matches
   * the active one, which is why nothing has to clear it on disconnect.
   */
  selection: { connectionId: string | null; keys: string[]; anchor: string | null };
  /**
   * The connection an open export dialog belongs to, and the objects it opened
   * with. `null` when the dialog is shut. The dialog owns everything after
   * that, including which objects end up checked.
   */
  exportTarget: { connectionId: string; keys: string[] } | null;

  loadConnections: () => Promise<void>;
  connect: (config: ConnectionConfig, password?: string, sshSecret?: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
  saveConnection: (
    config: ConnectionConfig,
    password?: string,
    sshSecret?: string,
  ) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;

  setActiveConnection: (id: string) => void;
  loadDatabases: (connectionId: string) => Promise<void>;
  /** Walks for BullMQ queues. Only when the user opens the section: matching
   *  `<prefix>:*:meta` across a large keyspace is a real cost. */
  loadQueues: (connectionId: string, reload?: boolean) => Promise<void>;
  openDatabase: (fromConnectionId: string, name: string) => Promise<void>;
  toggleSchema: (connectionId: string, schema: string) => Promise<void>;
  loadAllTables: (connectionId: string) => Promise<void>;
  reloadSchema: (connectionId: string, schema: string) => Promise<void>;
  dropObject: (connectionId: string, schema: string, name: string, kind: string) => Promise<void>;
  truncateTable: (connectionId: string, schema: string, name: string) => Promise<void>;

  openTab: (connectionId?: string | null) => void;
  openObjectTab: (connectionId: string, object: DbObject, pane?: PaneId) => void;
  closeTab: (id: string) => void;
  /** Puts an existing tab in the second pane. */
  openInSplit: (id: string) => void;
  closeSplit: () => void;
  focusPane: (pane: PaneId) => void;
  /** Closes every tab except this one and the pinned ones. */
  closeOtherTabs: (id: string) => void;
  togglePinTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  cycleTab: (delta: number) => void;
  setTabSql: (id: string, sql: string) => void;
  setActiveResult: (tabId: string, index: number) => void;
  runQuery: (tabId: string, sqlOverride?: string) => Promise<void>;
  cancelQuery: (tabId: string) => Promise<void>;

  setPageLimit: (tabId: string, limit: number) => void;
  goPage: (tabId: string, delta: number) => void;
  toggleSort: (tabId: string, column: string) => void;
  setFilters: (tabId: string, filters: Filter[]) => void;
  /** Opens the table a foreign key points at, filtered to the row it names. */
  openRelation: (connectionId: string, target: ColumnRef, value: string) => void;
  setFilterEditor: (editor: AppState["filterEditor"]) => void;
  countExactRows: (tabId: string) => Promise<void>;
  /** Walks a keyspace page. `delta` of 0 re-reads, 1 is Next, -1 is Prev. */
  goKeyPage: (tabId: string, delta: -1 | 0 | 1) => Promise<void>;
  /** Marks or unmarks a key for deletion. The mark is the confirmation. */
  /** Picks whole rows out of the grid, by the identity `staged` also uses. */
  pickRows: (tabId: string, keys: string[]) => void;
  toggleRowPick: (tabId: string, key: string) => void;
  clearRowPicks: (tabId: string) => void;
  /** Marks every picked row, or the one given when nothing is picked. */
  stageRows: (tabId: string, fallback: string | null) => void;
  toggleStaged: (tabId: string, key: string) => void;
  clearStaged: (tabId: string) => void;
  /** Runs the staged deletion and drops the rows without moving the cursor. */
  commitStaged: (tabId: string) => Promise<void>;

  /** Opens one state's jobs under the diagram, or closes them with `null`. */
  selectQueueState: (tabId: string, state: string | null) => Promise<void>;
  /** Pages the open state's jobs. `delta` of 0 re-reads. */
  goJobPage: (tabId: string, delta: -1 | 0 | 1) => Promise<void>;
  setQueueLive: (tabId: string, live: boolean) => void;
  /** One poll: the counts, and whatever the event stream recorded since the
   *  last one. Cheap enough to run every second, which is the point. */
  pollQueue: (tabId: string) => Promise<void>;
  /**
   * What ⌘R and the refresh control do: the counts *and* the rows.
   *
   * Separate from `pollQueue` because it is asked for rather than automatic,
   * and therefore has to be visible. A poll running every second may not touch
   * the busy indicator — it would flash once a second forever — but a refresh
   * nobody can see is a key that appears not to work.
   */
  refreshQueue: (tabId: string) => Promise<void>;
  /** Retries every staged job. `reset` clears `attemptsMade` as well, which is
   *  the difference between one more attempt and the whole allowance back. */
  commitRetry: (tabId: string, reset: boolean) => Promise<void>;
  ensureColumns: (tabId: string) => Promise<void>;
  setTabView: (tabId: string, view: QueryTab["view"]) => Promise<void>;
  /** Fetches a diagram tab's schema graph. No-op on any other kind of tab. */
  loadSchemaGraph: (tabId: string) => Promise<void>;
  /**
   * Reads a schema's tables, columns and foreign keys, once per connection and
   * schema.
   *
   * Answers the graph rather than writing it somewhere the caller has to go and
   * read, because the caller is a completion source that is already awaiting.
   * Null means the read failed, which the popup shows as no suggestions rather
   * than as an error over the editor.
   */
  ensureGraph: (connectionId: string, schema: string) => Promise<SchemaGraph | null>;

  /**
   * Keeps the tab's statement.
   *
   * An update when the tab is already showing a saved query, and a new one
   * otherwise. A tab that came from a chip and was then edited is still that
   * query, so ⌘S there means "this is what it should say" — offering to make a
   * second copy is how a shelf fills up with four nearly identical statements
   * and no way to tell which one is current.
   */
  saveQuery: (tabId: string) => void;
  /** Keeps the tab's statement as a separate query, link or no link. */
  saveQueryAsNew: (tabId: string) => void;
  renameSavedQuery: (id: string, name: string) => void;
  deleteSavedQuery: (id: string) => void;
  /** Opens or closes the inline name field on one chip. */
  setRenamingQuery: (id: string | null) => void;
  /**
   * Puts a saved statement in front of the user.
   *
   * Into the current tab when that tab has nothing of its own to lose,
   * otherwise into a new one: replacing an unsaved statement to show a saved
   * one would be a write nobody asked for.
   */
  openSavedQuery: (id: string) => void;

  setSelection: (tabId: string, selection: QueryTab["selection"]) => void;
  selectCell: (tabId: string, row: number, col: number) => void;
  toggleRowPanel: () => void;
  closeRowPanel: () => void;

  beginEdit: (tabId: string, row: number, col: number, where?: "grid" | "panel") => void;
  setEditDraft: (draft: string) => void;
  setEditNull: (isNull: boolean) => void;
  cancelEdit: () => void;
  commitEdit: () => Promise<void>;

  openCellView: (tabId: string, row: number, col: number) => void;
  closeCellView: () => void;
  commitCellView: (text: string | null) => Promise<void>;

  toggleSidebar: () => void;
  toggleTranslucency: () => void;
  setPrefs: (patch: Partial<Prefs>) => void;
  setSettings: (open: boolean) => void;
  loadSecurity: () => Promise<void>;
  unlock: () => Promise<void>;
  setSecurity: (patch: Partial<SecurityPolicy>) => Promise<void>;
  setConnectionBiometric: (id: string, on: boolean) => Promise<void>;
  setPalette: (mode: PaletteMode | null) => void;
  setSheet: (open: boolean, editing?: ConnectionConfig | null, credentialLost?: boolean) => void;
  /** A plain click: this row is where a range would start, and nothing is picked. */
  anchorSelection: (connectionId: string, key: string) => void;
  toggleSelected: (connectionId: string, key: string) => void;
  /** `order` is the flat list of rows as drawn, so a range follows the eye. */
  selectRange: (connectionId: string, order: string[], key: string) => void;
  clearSelection: () => void;
  setExportTarget: (target: AppState["exportTarget"]) => void;

  setToast: (toast: AppState["toast"]) => void;
  setErrorDialog: (dialog: AppState["errorDialog"]) => void;
}

const tableKey = (connectionId: string, schema: string) => `${connectionId}::${schema}`;

/**
 * Names for the entries in `busy`.
 *
 * Here rather than spelled out at each end, because the surface that draws the
 * spinner is never the one that set the flag, and a typo in either half is a
 * spinner that never appears or never stops.
 */
export const busyKey = {
  connect: (connectionId: string) => `connect:${connectionId}`,
  database: (connectionId: string, name: string) => `database:${connectionId}::${name}`,
  schema: (connectionId: string, schema: string) => `schema:${connectionId}::${schema}`,
  diagram: (connectionId: string, schema: string) => `diagram:${connectionId}::${schema}`,
  tables: (connectionId: string) => `tables:${connectionId}`,
  databases: (connectionId: string) => `databases:${connectionId}`,
  keys: (tabId: string) => `keys:${tabId}`,
  queues: (connectionId: string) => `queues:${connectionId}`,
  jobs: (tabId: string) => `jobs:${tabId}`,
  queue: (tabId: string) => `queue:${tabId}`,
};

/**
 * Drops every entry belonging to a connection that is gone.
 *
 * Works on both key shapes in the store: a plain connection id has no `::`, so
 * the split returns it whole.
 */
const forgetting = <T,>(map: Record<string, T>, gone: Set<string>): Record<string, T> =>
  Object.fromEntries(Object.entries(map).filter(([key]) => !gone.has(key.split("::")[0]!)));

export const useApp = create<AppState>((set, get) => {
  const patchTab = (id: string, p: Partial<QueryTab>) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...p } : t)) }));

  /**
   * Rewrites part of a queue tab's view, leaving the rest of the tab alone.
   *
   * A no-op on a tab that has no queue, which is what makes it safe to call
   * from a poll that was in flight while the user closed the tab or opened a
   * different one.
   */
  const patchQueue = (id: string, p: Partial<NonNullable<QueryTab["queue"]>>) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id && t.queue ? { ...t, queue: { ...t.queue, ...p } } : t,
      ),
    }));

  /**
   * Puts a tab in a pane and gives that pane the keyboard.
   *
   * Every route to a tab goes through here, so the two rules that make a split
   * legible are stated once: a tab is never in both panes at the same time, and
   * asking for a tab the other pane is already showing focuses that pane rather
   * than dragging the tab across and leaving a hole where it was.
   */
  const showTab = (id: string, pane: PaneId = "main") =>
    set((s) => {
      if (pane === "main") {
        if (s.splitTabId === id) return { focusedPane: "split" as PaneId };
        return { activeTabId: id, focusedPane: "main" as PaneId };
      }
      const rest = s.tabs.filter((t) => t.id !== id && t.connectionId === s.activeConnectionId);
      return {
        splitTabId: id,
        focusedPane: "split" as PaneId,
        activeTabId:
          s.activeTabId === id ? (rest[rest.length - 1]?.id ?? null) : s.activeTabId,
      };
    });

  /**
   * Makes one connection the one the workspace is pointed at.
   *
   * Three things have to move together, which is why they are here and not
   * spread over the callers. The sidebar's target changes; the tab strip shows
   * this connection's tabs, so the tab in the pane has to be one of them; and
   * every other database open on the same server is closed, because two live
   * databases under one server is the state where a query lands somewhere the
   * user stopped looking at.
   *
   * Tabs are kept, not closed. A connection's tabs come back with it, so
   * switching away and back is free and nothing unsaved is lost.
   */
  const focusConnection = async (id: string) => {
    set((s) => {
      const mine = s.tabs.filter((t) => t.connectionId === id);
      // The split holds a tab of the connection being left, so it goes with it.
      // It comes back the same way everything else does: by opening it again.
      const split = mine.some((t) => t.id === s.splitTabId) ? s.splitTabId : null;
      return {
        activeConnectionId: id,
        // The last one is the most recently opened, which is where the user
        // was. No tabs means the empty state, not someone else's tab.
        activeTabId: mine.some((t) => t.id === s.activeTabId)
          ? s.activeTabId
          : (mine.filter((t) => t.id !== split).at(-1)?.id ?? null),
        splitTabId: split,
        focusedPane: split && s.focusedPane === "split" ? "split" : "main",
      };
    });

    // Last, and one at a time: closing before the switch would leave the
    // sidebar briefly pointed at a session that is already gone.
    const { connections, open } = get();
    for (const gone of siblingSessions(connections, Object.keys(open), id)) {
      await get().disconnect(gone);
    }
  };

  /**
   * Runs `fn` with `key` on the record of what the app is waiting for.
   *
   * `finally`, so a call that throws still clears its own mark: a spinner left
   * turning after a failed connection is a worse lie than no spinner at all.
   */
  const track = async <T,>(key: string, label: string, fn: () => Promise<T>): Promise<T> => {
    set((s) => ({ busy: { ...s.busy, [key]: label } }));
    try {
      return await fn();
    } finally {
      set((s) => {
        const busy = { ...s.busy };
        delete busy[key];
        return { busy };
      });
    }
  };

  /**
   * Regenerates a table tab's SQL from its own paging state and runs it.
   *
   * Every pager control routes through here, so the statement on the tab and
   * the rows on screen can never describe different pages.
   */
  const runTablePage = async (
    id: string,
    next: Partial<Pick<QueryTab, "page" | "sort" | "filters">>,
  ) => {
    const tab = get().tabs.find((t) => t.id === id);
    const object = tab?.object;
    if (!tab || !object || !hasRows(object)) return;
    const page = next.page ?? tab.page;
    const sort = next.sort !== undefined ? next.sort : tab.sort;
    const filters = next.filters ?? tab.filters;
    const sql = tablePageSql({
      schema: object.schema,
      table: object.name,
      sort,
      limit: page.limit,
      offset: page.offset,
      filters,
      columns: tabColumns(tab),
    });
    patchTab(id, { page, sort, filters, sql });
    await get().runQuery(id, sql);
  };

  /**
   * Reads one page of a keyspace and puts it in the grid.
   *
   * `cursors` is a stack of where each page began, because a cursor walk has no
   * offsets to count: the server hands back an opaque place to resume and
   * nothing else. Next pushes, Prev pops, and an empty stack is page one — so
   * Prev is exact rather than a re-walk from the start.
   *
   * The staged marks are dropped on every page turn. A key marked on page three
   * is not on screen from page four, and committing a deletion the user can no
   * longer see would be the app acting on something it stopped showing them.
   */
  const runKeyPage = async (id: string, delta: -1 | 0 | 1) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab?.connectionId || !isKeyspace(tab.object)) return;
    const connectionId = tab.connectionId;

    // `cursors[i]` is where page i began. Next pushes the resume point the
    // current page came back with; Prev pops, which is why going back is exact
    // rather than a re-walk from the start.
    const cursors =
      delta === 1
        ? [...tab.cursors, tab.page.offset]
        : delta === -1
          ? tab.cursors.slice(0, -1)
          : tab.cursors.length > 0
            ? tab.cursors
            : [0];
    const from = cursors[cursors.length - 1] ?? 0;

    patchTab(id, { running: true, error: null, staged: [], selectedRows: [], selection: null });
    const started = performance.now();
    try {
      const page = await ipc.listKeys(
        connectionId,
        keyFilterFrom(tab.filters),
        from,
        tab.page.limit,
      );
      patchTab(id, {
        cursors,
        results: [keyPageToResult(page, Math.round(performance.now() - started))],
        activeResultIndex: 0,
        scan: { scanned: page.scanned, exhausted: page.exhausted },
        // Exact, from DBSIZE. No planner estimate here, so no tilde.
        rowCount: page.total === null ? null : { value: page.total, exact: true },
        running: false,
        clientMs: Math.round(performance.now() - started),
        // `offset` carries the resume point on a keyspace tab. Reusing the
        // field rather than adding one keeps every pager control routing
        // through the same place, and an offset means nothing here anyway.
        page: { ...tab.page, offset: page.cursor },
      });
    } catch (e) {
      patchTab(id, {
        running: false,
        error: asDbError(e),
        clientMs: Math.round(performance.now() - started),
      });
    }
  };

  /**
   * Moves a tab to a page, whichever kind of tab it is.
   *
   * A table tab regenerates its statement from the paging state. A query tab
   * keeps the SQL the user typed exactly as typed and lets `runQuery` decide
   * whether it can be wrapped for paging — so the editor never rewrites itself
   * under the caret.
   */
  const runPage = async (id: string, page: { limit: number; offset: number }) => {
    const before = get().tabs.find((t) => t.id === id);
    if (!before) return;

    // A keyspace has no offsets to move to: changing the page size restarts the
    // walk, which is the only honest answer when the pages themselves change
    // size.
    if (isKeyspace(before.object)) {
      patchTab(id, { page, cursors: [] });
      await runKeyPage(id, 0);
      return;
    }

    // A queue's rows are a page of one state, not of a relation. Falling
    // through would send it to `runTablePage`, which would generate a `select`
    // against a table named after the queue and fail against a Redis session
    // with an error about SQL.
    if (isQueue(before.object)) {
      patchTab(id, { page });
      await get().goJobPage(id, 0);
      return;
    }

    if (before.object) {
      await runTablePage(id, { page });
    } else {
      patchTab(id, { page });
      await get().runQuery(id);
    }

    // Landing on an empty page past the start means the row count was an exact
    // multiple of the limit and Next was one click too generous. Step back
    // rather than leave the user staring at nothing.
    const after = get().tabs.find((t) => t.id === id);
    if (after && after.page.offset > 0 && after.results[0]?.rows.length === 0) {
      await runPage(id, {
        ...after.page,
        offset: Math.max(0, after.page.offset - after.page.limit),
      });
    }
  };

  return {
  connections: [],
  open: {},
  activeConnectionId: null,
  databases: {},
  queues: {},
  queueScan: {},
  schemas: {},
  tables: {},
  functions: {},
  expandedSchemas: {},
  graphs: {},
  savedQueries: loadSavedQueries(),
  renamingQueryId: null,
  tabs: [],
  activeTabId: null,
  splitTabId: null,
  focusedPane: "main",
  sidebarVisible: true,
  translucent: loadTranslucency(),
  prefs: loadPrefs(),
  settings: false,
  security: DEFAULT_POLICY,
  biometrics: "unsupported",
  locked: true,
  palette: null,
  sheet: { open: false, editing: null, credentialLost: false, sshSecretLost: false },
  filterEditor: null,
  rowPanel: false,
  cellEdit: null,
  cellView: null,
  busy: {},
  toast: null,
  errorDialog: null,
  selection: { connectionId: null, keys: [], anchor: null },
  exportTarget: null,

  loadConnections: async () => {
    try {
      set({ connections: await ipc.listConnections() });
    } catch (e) {
      set({ toast: { kind: "error", text: asDbError(e).message } });
    }
  },

  connect: (config, password, sshSecret) =>
    track(busyKey.connect(config.id), `Connecting to ${config.name}…`, async () => {
      try {
        const info = await ipc.connect(config, password, sshSecret);
        // A key-value store has no schemas and never will. Asking anyway would
        // get an honest refusal from the driver and fail the whole connect on
        // it, so the question is simply not put.
        const keyspace = isKeyspaceDriver(config.driver);
        const schemas = keyspace ? [] : await ipc.listSchemas(config.id);
        set((s) => ({
          open: { ...s.open, [config.id]: info },
          schemas: { ...s.schemas, [config.id]: schemas },
          toast: null,
        }));
        // After the session exists, so a connect that failed closes nothing.
        await focusConnection(config.id);

        // Pinned tabs belong to a connection, so they come back when it does —
        // not at launch, when there is no session to run them against.
        //
        // Skipped when the connection still has tabs, which is every reconnect:
        // switching database closes the sibling session and leaves its tabs
        // standing, and restoring on top of them would stack a second copy of
        // every pinned query tab — `openTab` always pushes, and only
        // `openObjectTab` knows how to find the one that is already there.
        if (!get().tabs.some((t) => t.connectionId === config.id)) {
          for (const p of loadPinnedTabs()) {
            if (p.connectionId !== config.id) continue;
            if (p.object) {
              get().openObjectTab(config.id, p.object);
            } else {
              get().openTab(config.id);
              // Restored, not re-run: opening the app should not fire off whatever
              // statement was in the tab when it was last closed.
              const id = get().activeTabId;
              if (id) get().setTabSql(id, p.sql);
            }
            const id = get().activeTabId;
            if (id) patchTab(id, { pinned: true });
          }
        }

        // A freshly opened connection with no tab is a dead end. Give it one,
        // and adopt any tab that has no connection yet.
        const { tabs } = get();
        const orphan = tabs.find((t) => t.connectionId === null);
        if (orphan) {
          set((s) => ({
            tabs: s.tabs.map((t) => (t.id === orphan.id ? { ...t, connectionId: config.id } : t)),
            activeTabId: orphan.id,
          }));
        } else if (!tabs.some((t) => t.connectionId === config.id)) {
          get().openTab(config.id);
        }

        // A keyspace connection always lists its databases: they are numbered
        // rather than named, so there is no "the one I asked for" to land in,
        // and the sidebar's whole job is to say which of them hold anything.
        if (keyspace || isServerOnly(config)) {
          void get().loadDatabases(config.id);
          // The namespace is the only thing to look at, so open it rather than
          // leaving the user on an empty tab next to a list of one thing.
          if (keyspace) {
            get().openObjectTab(config.id, {
              schema: info.currentDatabase,
              name: info.currentDatabase,
              kind: "keyspace",
            });
          }
          return;
        }

        // 'public' is where the user's tables almost always are.
        if (schemas.some((s) => s.name === "public")) {
          await get().toggleSchema(config.id, "public");
        }
      } catch (e) {
        const error = asDbError(e);
        // A missing secret is recoverable, but only by retyping it. Reopen the
        // sheet on the connection that failed rather than leaving a toast the
        // user can do nothing about, and on the field that is actually wrong:
        // being asked for the database password when the key passphrase is what
        // failed sends the user looking for the wrong secret.
        if (!get().sheet.open) {
          if (error.code === CREDENTIAL_UNREADABLE) {
            set({
              sheet: { open: true, editing: config, credentialLost: true, sshSecretLost: false },
            });
          } else if (error.code === SSH_SECRET_REQUIRED) {
            set({
              sheet: { open: true, editing: config, credentialLost: false, sshSecretLost: true },
            });
          }
        }
        set({ toast: { kind: "error", text: error.message } });
        throw e;
      }
    }),

  disconnect: async (id) => {
    try {
      await ipc.disconnect(id);
    } catch (e) {
      // The session is closing either way; saying why is all that is left.
      set({ toast: { kind: "error", text: asDbError(e).message } });
    }
    set((s) => {
      const open = { ...s.open };
      delete open[id];
      return {
        open,
        activeConnectionId: s.activeConnectionId === id ? null : s.activeConnectionId,
      };
    });
  },

  saveConnection: async (config, password, sshSecret) => {
    set({ connections: await ipc.saveConnection(config, password, sshSecret) });
  },

  /**
   * Deletes a connection and clears up after it.
   *
   * The backend takes the derived connections with it, so what is gone is
   * whatever the returned list no longer contains, not just the id asked for.
   * Everything keyed by one of those ids goes: leaving a session in `open`
   * would keep the sidebar showing a live dot for a connection that is not
   * there, and leaving its tabs would leave tabs whose next query cannot run.
   */
  deleteConnection: async (id) => {
    const before = get().connections;
    const connections = await ipc.deleteConnection(id);
    const gone = new Set([id, ...before.filter((c) => !connections.some((n) => n.id === c.id)).map((c) => c.id)]);

    set((s) => {
      const tabs = s.tabs.filter((t) => !t.connectionId || !gone.has(t.connectionId));
      return {
        connections,
        open: forgetting(s.open, gone),
        databases: forgetting(s.databases, gone),
        schemas: forgetting(s.schemas, gone),
        tables: forgetting(s.tables, gone),
        functions: forgetting(s.functions, gone),
        expandedSchemas: forgetting(s.expandedSchemas, gone),
        graphs: forgetting(s.graphs, gone),
        tabs,
        activeTabId: tabs.some((t) => t.id === s.activeTabId)
          ? s.activeTabId
          : (tabs[tabs.length - 1]?.id ?? null),
        activeConnectionId:
          s.activeConnectionId && gone.has(s.activeConnectionId) ? null : s.activeConnectionId,
      };
    });
  },

  setActiveConnection: (id) => {
    void focusConnection(id);
    // Same reasoning as `connect`: a connection with no tab is a dead end, and
    // the empty state reads "open a connection from the sidebar" to someone who
    // just did. `focusConnection` has already written the active id — it only
    // awaits to close what it replaced.
    if (!get().tabs.some((t) => t.connectionId === id)) get().openTab(id);
  },

  /**
   * Databases on this connection's server. Fetched once per connection: the
   * list is a property of the server, and creating a database while the app is
   * open is rare enough to cost a reconnect.
   */
  loadDatabases: async (connectionId) => {
    if (get().databases[connectionId]) return;
    await track(busyKey.databases(connectionId), "Reading databases…", async () => {
      try {
        const names = await ipc.listDatabases(connectionId);
        set((s) => ({ databases: { ...s.databases, [connectionId]: names } }));
      } catch (e) {
        set({ toast: { kind: "error", text: asDbError(e).message } });
      }
    });
  },

  /**
   * Walks for BullMQ queues on a connection.
   *
   * Only when the user opens the section, never on connect. Finding queues
   * means matching `<prefix>:*:meta` across the keyspace, and on an instance
   * holding millions of session keys that is a walk worth asking for rather
   * than one to spend on every connection the moment it opens.
   */
  loadQueues: async (connectionId, reload = false) => {
    if (!reload && get().queues[connectionId]) return;
    await track(busyKey.queues(connectionId), "Finding queues…", async () => {
      try {
        const page = await ipc.listQueues(connectionId, DEFAULT_PREFIX, 0, QUEUE_LIMIT);
        set((s) => ({
          queues: { ...s.queues, [connectionId]: page.queues },
          queueScan: {
            ...s.queueScan,
            [connectionId]: { scanned: page.scanned, exhausted: page.exhausted },
          },
        }));
      } catch (e) {
        set({ toast: { kind: "error", text: asDbError(e).message } });
      }
    });
  },

  /**
   * Opens a database on the server behind `fromConnectionId`.
   *
   * Switching database means a different session, so it means a different
   * connection. Deriving one rather than mutating the existing config is what
   * keeps both reachable: the tabs already open on the old database keep
   * working, and the new database is somewhere the sidebar can point at.
   *
   * The derived connection carries `parentId`, so it authenticates with the
   * server's credential instead of a copy of the secret per database, and it
   * inherits `environment`, so a database picked off a production server is
   * still tinted as production.
   */
  openDatabase: async (fromConnectionId, name) => {
    const { connections } = get();
    const parent = connections.find((c) => c.id === fromConnectionId);
    if (!parent) return;

    // The same database on the same server is the same connection. Without
    // this, picking it twice leaves two entries that are indistinguishable.
    const existing = connections.find(
      (c) =>
        c.driver === parent.driver &&
        c.host === parent.host &&
        c.port === parent.port &&
        c.user === parent.user &&
        c.sslMode === parent.sslMode &&
        c.database === name,
    );

    const config: ConnectionConfig = existing ?? {
      ...parent,
      id: crypto.randomUUID(),
      name,
      database: name,
      // Chained to the root, so a database picked from a derived connection
      // still resolves its password in one hop.
      parentId: parent.parentId ?? parent.id,
    };

    // Marked against the row that was clicked, not the connection this is
    // about to derive: the row is what the user is looking at, and it has no
    // id yet on the first click.
    await track(
      busyKey.database(fromConnectionId, name),
      `Opening ${name}…`,
      async () => {
        try {
          // No password argument: the secret stays where it is, under the parent.
          if (!existing) await get().saveConnection(config);
          if (get().open[config.id]) {
            get().setActiveConnection(config.id);
            return;
          }
          await get().connect(config);
        } catch (e) {
          set({ toast: { kind: "error", text: asDbError(e).message } });
        }
      },
    );
  },

  toggleSchema: async (connectionId, schema) => {
    const key = tableKey(connectionId, schema);
    const expanded = get().expandedSchemas[key];
    if (expanded) {
      set((s) => ({ expandedSchemas: { ...s.expandedSchemas, [key]: false } }));
      return;
    }
    await track(busyKey.schema(connectionId, schema), `Reading ${schema}…`, async () => {
      try {
        // Both lists in one round trip. A schema that has been expanded once
        // never needs either call again.
        const [tables, functions] = await Promise.all([
          get().tables[key] ?? ipc.listTables(connectionId, schema),
          get().functions[key] ?? ipc.listFunctions(connectionId, schema),
        ]);
        set((s) => ({
          tables: { ...s.tables, [key]: tables },
          functions: { ...s.functions, [key]: functions },
          // One schema unfolded at a time, per connection. The lists stay in
          // `tables` and `functions`, so folding one and opening it again later
          // costs nothing — what is dropped is the disclosure, not the cache.
          expandedSchemas: {
            ...Object.fromEntries(
              Object.entries(s.expandedSchemas).filter(
                ([k]) => !k.startsWith(`${connectionId}::`),
              ),
            ),
            [key]: true,
          },
        }));
      } catch (e) {
        set({ toast: { kind: "error", text: asDbError(e).message } });
      }
    });
  },

  /**
   * Tables the sidebar has not expanded yet are invisible to the ⌘P picker,
   * which would make it quietly incomplete. Schemas are already filtered to
   * the user's own, so fetching the rest is a handful of catalogue queries.
   */
  loadAllTables: async (connectionId) => {
    const { schemas, tables } = get();
    const missing = (schemas[connectionId] ?? []).filter(
      (s) => !tables[tableKey(connectionId, s.name)],
    );
    if (missing.length === 0) return;
    await track(busyKey.tables(connectionId), "Reading tables…", async () => {
      try {
        const loaded = await Promise.all(
          missing.map(async (s) => [tableKey(connectionId, s.name), await ipc.listTables(connectionId, s.name)] as const),
        );
        set((state) => ({ tables: { ...state.tables, ...Object.fromEntries(loaded) } }));
      } catch (e) {
        set({ toast: { kind: "error", text: asDbError(e).message } });
      }
    });
  },

  reloadSchema: async (connectionId, schema) => {
    const key = tableKey(connectionId, schema);
    try {
      const [tables, functions] = await Promise.all([
        ipc.listTables(connectionId, schema),
        ipc.listFunctions(connectionId, schema),
      ]);
      set((s) => ({
        tables: { ...s.tables, [key]: tables },
        functions: { ...s.functions, [key]: functions },
      }));
    } catch (e) {
      set({ toast: { kind: "error", text: asDbError(e).message } });
    }
  },

  /**
   * Runs the drop and clears up after it: the object list no longer contains
   * the object, and any tab pointed at it is now pointed at nothing.
   *
   * The statement itself is built and shown to the user before this is called;
   * nothing here decides what to destroy.
   */
  dropObject: async (connectionId, schema, name, kind) => {
    await ipc.executeQuery(connectionId, dropStatement(schema, name, kind));
    set((s) => {
      const doomed = s.tabs.filter(
        (t) => t.connectionId === connectionId && t.object?.schema === schema && t.object.name === name,
      );
      if (doomed.length === 0) return {};
      const tabs = s.tabs.filter((t) => !doomed.includes(t));
      const activeTabId = doomed.some((t) => t.id === s.activeTabId)
        ? (tabs[tabs.length - 1]?.id ?? null)
        : s.activeTabId;
      return { tabs, activeTabId };
    });
    await get().reloadSchema(connectionId, schema);
    set({ toast: { kind: "info", text: `Dropped ${schema}.${name}.` } });
  },

  truncateTable: async (connectionId, schema, name) => {
    await ipc.executeQuery(connectionId, truncateStatement(schema, name));
    // The table survives, so its tabs do too — they just need re-reading.
    for (const tab of get().tabs) {
      if (tab.connectionId === connectionId && tab.object?.schema === schema && tab.object.name === name) {
        patchTab(tab.id, { rowCount: { value: 0, exact: true } });
        void get().runQuery(tab.id);
      }
    }
    set({ toast: { kind: "info", text: `Truncated ${schema}.${name}.` } });
  },

  openTab: (connectionId) => {
    const tab = newTab(connectionId ?? get().activeConnectionId);
    set((s) => ({ tabs: [...s.tabs, tab] }));
    showTab(tab.id);
  },

  openObjectTab: (connectionId, object, pane = "main") => {
    const existing = get().tabs.find(
      (t) =>
        t.connectionId === connectionId &&
        t.object?.schema === object.schema &&
        t.object?.name === object.name &&
        t.object?.kind === object.kind,
    );
    // Reopening an object should return to the tab you already have rather
    // than stacking a second copy of the same thing.
    if (existing) {
      showTab(existing.id, pane);
      // Both are idempotent, and each is a no-op on the kind of tab it does
      // not describe. A reopened tab whose first fetch failed is the case
      // that matters: it gets another attempt rather than staying blank.
      void get().ensureColumns(existing.id);
      void get().loadSchemaGraph(existing.id);
      // Unlike the other two this is not idempotent, so it is asked only when
      // the walk brought back nothing: a keyspace tab reopened after a failure
      // gets another attempt, and one already showing keys is left alone rather
      // than silently jumping back to page one.
      if (isKeyspace(object) && existing.results.length === 0) {
        void get().goKeyPage(existing.id, 0);
      }
      // Idempotent, and the counts on a tab that has been in the background are
      // whatever they were when it was last looked at.
      if (isQueue(object)) void get().pollQueue(existing.id);
      return;
    }
    /**
     * With `tabBehaviour: "idle"` the strip is reused rather than grown: the
     * tab in the pane the object is heading for gives up its id and becomes
     * this object, if it has nothing unfinished on it. `tabIdle` is the whole
     * definition of that; see the comment on it.
     *
     * The active tab specifically, not the first idle tab anywhere in the
     * strip. Replacing a tab the user is not looking at is a worse surprise
     * than the extra tab this preference exists to avoid.
     *
     * Keeping the id is what stops the pane, the focus and the split from
     * moving underneath the swap. What does *not* survive it: `cellEdit` and
     * `filterEditor` are keyed by tab id, and an editor left open over a tab
     * that is now a different table is a write aimed at the wrong row.
     */
    const recycled =
      get().prefs.tabBehaviour === "idle" && pane === "main"
        ? get().tabs.find(
            (t) => t.id === get().activeTabId && t.connectionId === connectionId && tabIdle(t, get().splitTabId),
          )
        : undefined;

    const tab = recycled
      ? { ...newTab(connectionId, object), id: recycled.id }
      : newTab(connectionId, object);

    set((s) => ({
      tabs: recycled ? s.tabs.map((t) => (t.id === recycled.id ? tab : t)) : [...s.tabs, tab],
      cellEdit: s.cellEdit?.tabId === tab.id ? null : s.cellEdit,
      cellView: s.cellView?.tabId === tab.id ? null : s.cellView,
      filterEditor: s.filterEditor?.tabId === tab.id ? null : s.filterEditor,
    }));
    showTab(tab.id, pane);

    // A diagram is the schema, not a relation in it: there is no page of rows
    // to fetch and no definition to read, only the graph it draws.
    if (object.kind === "diagram") {
      void get().loadSchemaGraph(tab.id);
      return;
    }

    // A keyspace is walked, not queried: there is no statement to generate, no
    // column list to fetch, and no estimate to ask for — the walk itself brings
    // back the exact total.
    if (object.kind === "keyspace") {
      void get().goKeyPage(tab.id, 0);
      return;
    }

    // A queue is polled rather than queried: there is no statement to generate
    // and no state chosen yet, only the lifecycle and what is moving through
    // it. The jobs arrive when a node on the diagram is clicked.
    if (object.kind === "queue") {
      void get().pollQueue(tab.id);
      return;
    }
    if (!hasRows(object)) {
      void get().setTabView(tab.id, "definition");
      return;
    }
    void get().runQuery(tab.id);

    // Runs alongside the page rather than before it: the rows are what the
    // user asked for, the count is only ever context for them.
    void ipc
      .estimateRows(connectionId, object.schema, object.name)
      .then((rowCount) => patchTab(tab.id, { rowCount }))
      .catch(() => {
        /* A missing count is not worth a toast; the pager still works. */
      });

    // Likewise the columns. Editing needs the primary key and the types, and
    // wanting them only once the user double-clicks would put a round trip
    // between the gesture and the caret.
    void get().ensureColumns(tab.id);
  },

  /**
   * Loads the table definition if this tab does not have it yet.
   *
   * Idempotent and safe to call from anywhere, which is the point: a tab can
   * reach the grid through more than one door (opened fresh, reopened, restored
   * after a failed fetch), and a tab that quietly lacks its columns is a tab
   * where every double click does nothing and says nothing.
   */
  ensureColumns: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    const object = tab?.object;
    if (!tab || !object || !tab.connectionId || tab.columns || !hasRows(object)) return;
    try {
      const columns = await ipc.listColumns(tab.connectionId, object.schema, object.name);
      patchTab(tabId, { columns });
    } catch {
      /* The tab still reads. The next attempt to edit asks again. */
    }
  },

  /**
   * Loads a diagram tab's graph if it does not have one yet.
   *
   * Idempotent like `ensureColumns`, and for the same reason: a tab reaches the
   * canvas through more than one door. The guard is `graph === null` rather
   * than a flag, so a fetch that failed is retried the next time the tab is
   * opened instead of leaving an empty canvas that never explains itself.
   */
  loadSchemaGraph: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    const object = tab?.object;
    if (!tab || !object || !tab.connectionId || tab.graph) return;
    if (object.kind !== "diagram") return;
    const connectionId = tab.connectionId;
    try {
      const graph = await track(
        busyKey.diagram(connectionId, object.schema),
        `Reading ${object.schema}…`,
        () => ipc.schemaGraph(connectionId, object.schema),
      );
      patchTab(tabId, { graph });
    } catch (e) {
      set({ toast: { kind: "error", text: asDbError(e).message } });
    }
  },

  ensureGraph: async (connectionId, schema) => {
    const key = tableKey(connectionId, schema);
    const cached = get().graphs[key];
    if (cached) return cached;
    try {
      const graph = await ipc.schemaGraph(connectionId, schema);
      set((s) => ({ graphs: { ...s.graphs, [key]: graph } }));
      return graph;
    } catch {
      // Silent on purpose. This runs behind a completion popup the user did
      // not ask for; a toast over the editor for a schema that could not be
      // read would interrupt the typing it was meant to help.
      return null;
    }
  },

  saveQuery: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab || !tab.connectionId || !tab.sql.trim()) return;

    // Updating in place, so no chip appears and no name field opens: the only
    // thing that changed is that the chip stopped being marked as edited, and
    // that is the whole report.
    const linked = get().savedQueries.find((q) => q.id === tab.savedQueryId);
    if (linked) {
      set((s) => {
        const savedQueries = s.savedQueries.map((q) =>
          q.id === linked.id ? { ...q, sql: tab.sql, savedAt: Date.now() } : q,
        );
        saveSavedQueries(savedQueries);
        return { savedQueries };
      });
      return;
    }

    get().saveQueryAsNew(tabId);
  },

  saveQueryAsNew: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab || !tab.connectionId || !tab.sql.trim()) return;
    const query: SavedQuery = {
      id: crypto.randomUUID(),
      connectionId: tab.connectionId,
      name: defaultName(tab.sql),
      sql: tab.sql,
      savedAt: Date.now(),
    };
    set((s) => {
      const savedQueries = [...s.savedQueries, query];
      saveSavedQueries(savedQueries);
      return {
        savedQueries,
        renamingQueryId: query.id,
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, savedQueryId: query.id } : t)),
      };
    });
  },

  renameSavedQuery: (id, name) =>
    set((s) => {
      const trimmed = name.trim();
      const savedQueries = s.savedQueries.map((q) =>
        // An emptied field means "I did not want to name it", not "name it
        // nothing", so the default stands.
        q.id === id ? { ...q, name: trimmed || defaultName(q.sql) } : q,
      );
      saveSavedQueries(savedQueries);
      return { savedQueries, renamingQueryId: null };
    }),

  deleteSavedQuery: (id) =>
    set((s) => {
      const savedQueries = s.savedQueries.filter((q) => q.id !== id);
      saveSavedQueries(savedQueries);
      return {
        savedQueries,
        renamingQueryId: s.renamingQueryId === id ? null : s.renamingQueryId,
        // The statement stays in the tab; only the claim that it is a saved
        // one goes. Otherwise ⌘S there would update a query that is gone.
        tabs: s.tabs.map((t) => (t.savedQueryId === id ? { ...t, savedQueryId: null } : t)),
      };
    }),

  setRenamingQuery: (id) => set({ renamingQueryId: id }),

  openSavedQuery: (id) => {
    const query = get().savedQueries.find((q) => q.id === id);
    if (!query) return;
    const tab = activeTab(get());
    // Reusable when the tab holds nothing the user would miss: empty, or
    // already showing something that is itself saved.
    const reusable =
      tab &&
      !tab.object &&
      tab.connectionId === query.connectionId &&
      // Empty, or holding a saved statement unchanged. An edited saved query
      // has unsaved work in it exactly like an unsaved one does.
      (!tab.sql.trim() ||
        get().savedQueries.some((q) => q.id === tab.savedQueryId && q.sql === tab.sql));
    if (reusable) {
      get().setTabSql(tab.id, query.sql);
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, savedQueryId: query.id } : t)),
      }));
      return;
    }
    const fresh = { ...newTab(query.connectionId), sql: query.sql, savedQueryId: query.id };
    set((s) => ({ tabs: [...s.tabs, fresh] }));
    showTab(fresh.id);
  },

  closeTab: (id) => {
    set((s) => {
      const closing = s.tabs.find((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      // Closing the tab in the second pane is how the split is closed. There is
      // no separate control for it, because the tab is the thing the split was
      // opened to hold.
      if (s.splitTabId === id) {
        return { tabs, splitTabId: null, focusedPane: "main" as PaneId };
      }
      if (s.activeTabId !== id) return { tabs };
      // Among the tabs of the same connection, which is what the strip shows.
      // The neighbour on a hidden tab is not a neighbour on screen.
      const mine = tabs.filter((t) => t.connectionId === (closing?.connectionId ?? null));
      const index = s.tabs
        .filter((t) => t.connectionId === (closing?.connectionId ?? null))
        .findIndex((t) => t.id === id);
      // Focus the neighbour, preferring the one on the left, which is where
      // the eye already is after closing.
      const next = mine.filter((t) => t.id !== s.splitTabId)[Math.max(0, index - 1)];
      return { tabs, activeTabId: next?.id ?? null, focusedPane: "main" as PaneId };
    });
    // Closing a pinned tab is how a pin is dropped: the next session should
    // not reopen something the user just shut.
    savePinnedTabs(get().tabs);
  },

  openInSplit: (id) => showTab(id, "split"),

  closeSplit: () => set({ splitTabId: null, focusedPane: "main" }),

  focusPane: (pane) =>
    set((s) => ({ focusedPane: pane === "split" && !s.splitTabId ? "main" : pane })),

  closeOtherTabs: (id) => {
    set((s) => ({
      // Pinned is a statement about which tabs survive a clear-out, so this is
      // the one place it has to be honoured. The tab in the other pane survives
      // too: it is on screen, and closing what the user is looking at is not
      // what "close other tabs" means.
      tabs: s.tabs.filter((t) => t.id === id || t.pinned || t.id === s.splitTabId),
      activeTabId: id,
    }));
  },

  togglePinTab: (id) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)) }));
    savePinnedTabs(get().tabs);
  },

  setActiveTab: (id) => {
    // The sidebar, the palette and the editor's autocomplete all read
    // `activeConnectionId`. A tab is the other way into a connection, so
    // focusing one has to move that too or those three describe a connection
    // the pane is not on.
    const tab = get().tabs.find((t) => t.id === id);
    if (tab?.connectionId) set({ activeConnectionId: tab.connectionId });
    showTab(id);
  },

  cycleTab: (delta) => {
    const { tabs, activeTabId, activeConnectionId } = get();
    // The strip only draws this connection's tabs, so this is what "next tab"
    // means. Cycling into a hidden one would look like the tab vanishing.
    const mine = tabs.filter((t) => t.connectionId === activeConnectionId);
    if (mine.length === 0) return;
    const i = mine.findIndex((t) => t.id === activeTabId);
    const next = mine[(((i + delta) % mine.length) + mine.length) % mine.length];
    if (next) showTab(next.id);
  },

  // Editing the statement invalidates where you were in its results: page 3 of
  // a query you have since changed is not a page of anything.
  setTabSql: (id, sql) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id !== id
          ? t
          : { ...t, sql, page: t.page.offset === 0 ? t.page : { ...t.page, offset: 0 } },
      ),
    })),

  setActiveResult: (tabId, index) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, activeResultIndex: index } : t)),
    })),

  runQuery: async (tabId, sqlOverride) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (!tab.connectionId) {
      set({ toast: { kind: "error", text: "No connection selected for this tab." } });
      return;
    }
    // A keyspace tab has no statement to run. ⌘R on one means "read this page
    // again", which is the same thing it means everywhere else.
    if (isKeyspace(tab.object)) {
      await get().goKeyPage(tabId, 0);
      return;
    }
    // Same on a queue: there is no statement, so ⌘R means "read this again" —
    // the counts, the events, and the open state's jobs if one is open.
    if (isQueue(tab.object)) {
      await get().refreshQueue(tabId);
      return;
    }
    const sql = (sqlOverride ?? tab.sql).trim();
    if (!sql) return;

    const patch = (p: Partial<QueryTab>) => patchTab(tabId, p);
    const { limit, offset } = tab.page;

    // A table tab's SQL is generated and already carries its own limit and
    // offset. Only what the user typed is a candidate for wrapping, and only
    // when `unpageableReason` says every one of its checks passed.
    const note = tab.object ? "the rows come from a table tab" : unpageableReason(sql);
    const paged = note === null;
    // What actually runs. Unwrapped, this is the user's statement verbatim;
    // the cap below is what keeps an unwrappable one from arriving whole.
    const sent = paged ? pagedSql(sql, limit, offset) : sql;

    patch({ running: true, error: null, clientMs: null, paged, pageNote: note });
    const started = performance.now();
    try {
      const results = await ipc.executeQuery(tab.connectionId, sent, limit);
      patch({
        results,
        activeResultIndex: Math.max(0, results.length - 1),
        running: false,
        clientMs: Math.round(performance.now() - started),
      });
    } catch (e) {
      patch({ running: false, error: asDbError(e), clientMs: Math.round(performance.now() - started) });
    }
  },

  cancelQuery: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.connectionId || !tab.running) return;
    try {
      await ipc.cancelQuery(tab.connectionId);
    } catch (e) {
      set({ toast: { kind: "error", text: asDbError(e).message } });
    }
  },

  // Back to page one: keeping the offset would land the user somewhere they
  // did not choose, at a row number that no longer means the same thing.
  setPageLimit: (tabId, limit) => {
    void runPage(tabId, { limit: Math.max(1, Math.trunc(limit)), offset: 0 });
  },

  goPage: (tabId, delta) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const offset = Math.max(0, tab.page.offset + delta * tab.page.limit);
    if (offset === tab.page.offset) return;
    void runPage(tabId, { ...tab.page, offset });
  },

  toggleSort: (tabId, column) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!hasRows(tab?.object ?? null) || !tab) return;
    // Third click clears rather than cycling back to ascending: "no sort" is a
    // state the user can otherwise only reach by reopening the table.
    const sort: Sort | null =
      tab.sort?.column !== column
        ? { column, dir: "asc" }
        : tab.sort.dir === "asc"
          ? { column, dir: "desc" }
          : null;
    void runTablePage(tabId, { sort, page: { ...tab.page, offset: 0 } });
  },

  /**
   * Back to page one, for the same reason changing the page size is: row 400 of
   * a filtered set is not row 400 of the table.
   */
  /**
   * Follows a foreign key: opens the referenced table showing only the row it
   * points at.
   *
   * A filter rather than a generated `select`, because a filter is a thing on
   * screen that the user can widen or drop — landing on one row with no way
   * back to the rest of the table would be a dead end. Everything else about
   * the tab is the ordinary table tab it would have been.
   */
  openRelation: (connectionId, target, value) => {
    get().openObjectTab(connectionId, {
      schema: target.schema,
      name: target.table,
      kind: "table",
    });
    const tab = activeTab(get());
    if (!tab) return;
    get().setFilters(tab.id, [
      { id: crypto.randomUUID(), column: target.column, op: "eq", values: [value] },
    ]);
  },

  setFilters: (tabId, filters) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    const object = tab?.object;
    if (!tab || !object) return;

    // A keyspace filter is a glob the server matches and, sometimes, a search
    // through values. Either way it restarts the walk: there is no page three
    // of a set the filter has just changed.
    if (isKeyspace(object)) {
      patchTab(tabId, { filters, cursors: [] });
      void get().goKeyPage(tabId, 0);
      return;
    }

    // The estimate came from the planner's statistics for the whole table, so
    // it stops describing anything the moment a filter is on. Dropping it is
    // honest; the footer offers an exact count in its place.
    patchTab(tabId, { rowCount: null });
    void runTablePage(tabId, { filters, page: { ...tab.page, offset: 0 } });

    // Last filter removed: the cheap estimate means something again.
    if (filters.length === 0 && tab.connectionId) {
      void ipc
        .estimateRows(tab.connectionId, object.schema, object.name)
        .then((rowCount) => patchTab(tabId, { rowCount }))
        .catch(() => {
          /* A missing count is not worth a toast; the pager still works. */
        });
    }
  },

  setFilterEditor: (filterEditor) => set({ filterEditor }),

  countExactRows: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    const object = tab?.object;
    if (!tab || !object || !tab.connectionId || tab.rowCount?.exact) return;
    try {
      // `count_rows` counts the table. Under a filter the only honest answer
      // comes from counting the same rows the page selected.
      const rowCount =
        tab.filters.length === 0
          ? await ipc.countRows(tab.connectionId, object.schema, object.name)
          : await ipc
              .executeQuery(
                tab.connectionId,
                tableCountSql({
                  schema: object.schema,
                  table: object.name,
                  filters: tab.filters,
                  columns: tabColumns(tab),
                }),
              )
              .then((results) => ({
                value: Number(results[0]?.rows[0]?.[0] ?? 0),
                exact: true,
              }));
      patchTab(tabId, { rowCount });
    } catch (e) {
      set({ toast: { kind: "error", text: asDbError(e).message } });
    }
  },

  goKeyPage: async (tabId, delta) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab || !isKeyspace(tab.object)) return;
    // Nothing to go back to on page one, and nothing to go forward to once the
    // walk has come round. Guarded here rather than in the footer so a keyboard
    // route cannot reach a page the buttons refuse.
    if (delta === -1 && tab.cursors.length <= 1) return;
    if (delta === 1 && tab.scan?.exhausted) return;
    await track(busyKey.keys(tabId), "Scanning keys…", () => runKeyPage(tabId, delta));
  },

  /**
   * Marks a key for deletion, or takes the mark off.
   *
   * Nothing is sent. The mark is what the user reads back before committing:
   * the row goes red and the status bar prints the command, which is this
   * app's existing answer to "show a generated write before it runs".
   */
  pickRows: (tabId, keys) => patchTab(tabId, { selectedRows: keys }),

  toggleRowPick: (tabId, key) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, selectedRows: toggleKey(t.selectedRows, key) } : t,
      ),
    })),

  clearRowPicks: (tabId) => patchTab(tabId, { selectedRows: [] }),

  /**
   * Turns the picked rows into staged ones, which is the whole of "bulk
   * delete": one row or forty is the same gesture, and what differs is only how
   * many were picked before Delete was pressed.
   *
   * With nothing picked it falls back to the row under the cursor, so the
   * single-row flow is unchanged. Marking is not a toggle here — a Delete on a
   * selection means "these go", and unmarking half of them by pressing it twice
   * is not something anyone means.
   */
  stageRows: (tabId, fallback) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t;
        const picked = t.selectedRows.length > 0 ? t.selectedRows : fallback ? [fallback] : [];
        if (picked.length === 0) return t;
        // A single row keeps toggling, because that is how one is unmarked.
        if (t.selectedRows.length === 0 && fallback) {
          return { ...t, staged: toggleKey(t.staged, fallback) };
        }
        const staged = [...t.staged];
        for (const key of picked) if (!staged.includes(key)) staged.push(key);
        return { ...t, staged, selectedRows: [] };
      }),
    })),

  toggleStaged: (tabId, key) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id !== tabId
          ? t
          : {
              ...t,
              staged: t.staged.includes(key)
                ? t.staged.filter((k) => k !== key)
                : [...t.staged, key],
            },
      ),
    })),

  clearStaged: (tabId) => patchTab(tabId, { staged: [] }),

  /**
   * Deletes every staged key, or on a table tab, every staged row.
   *
   * One action for both because it is one gesture: mark, read back what is
   * about to go, press ⌘S. What differs is only what a mark names — a key in a
   * flat namespace, or a row by its primary key — and that is decided here
   * rather than by a second command bound to the same key.
   *
   * The rows are dropped from the result in place rather than by re-reading the
   * page. A re-read would move the scan cursor, so the keys around the ones just
   * deleted would shift under the user at the exact moment they are checking
   * what happened.
   */
  commitStaged: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.connectionId || tab.staged.length === 0) return;
    const result = tab.results[tab.activeResultIndex];
    if (!result) return;

    const object = tab.object;
    if (object && rowsDeletable(tab)) {
      // Same rule as below: only what is on screen. `stagedRowsIn` reads the
      // identity off the rows themselves, so a row that has since scrolled out
      // of the result cannot be reached.
      const rows = stagedRowsIn(tab.columns, result, new Set(tab.staged));
      if (rows.length === 0) {
        patchTab(tabId, { staged: [] });
        return;
      }

      try {
        const removed = await ipc.deleteRows(
          tab.connectionId,
          object.schema,
          object.name,
          rows,
        );
        const gone = new Set(tab.staged);
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id !== tabId
              ? t
              : {
                  ...t,
                  staged: [],
                  selectedRows: [],
                  selection: null,
                  results: t.results.map((r, i) =>
                    i !== t.activeResultIndex
                      ? r
                      : {
                          ...r,
                          rows: r.rows.filter((_, ri) => {
                            const identity = rowKeysFor(t.columns, r, ri);
                            return !identity.ok || !gone.has(rowStageKey(identity.keys));
                          }),
                        },
                  ),
                  rowCount: t.rowCount
                    ? { ...t.rowCount, value: Math.max(0, t.rowCount.value - removed) }
                    : null,
                },
          ),
          toast: {
            kind: "info",
            text: `Deleted ${removed} ${removed === 1 ? "row" : "rows"}.`,
          },
        }));
      } catch (e) {
        // The marks stay. A delete that Postgres refused is one the user may
        // want to retry after clearing the reference, and dropping the red rows
        // would make them mark every one of them again to do it.
        set({ errorDialog: { title: "Rows not deleted", error: asDbError(e) } });
      }
      return;
    }

    // Only what is actually on screen. A key staged before a page turn is one
    // the user can no longer see, and acting on it would be the app destroying
    // something it stopped showing them.
    const keys = stagedKeysIn(result, new Set(tab.staged));
    if (keys.length === 0) {
      patchTab(tabId, { staged: [] });
      return;
    }

    try {
      const removed = await ipc.deleteKeys(tab.connectionId, keys);
      const gone = new Set(keys);
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id !== tabId
            ? t
            : {
                ...t,
                staged: [],
                selectedRows: [],
                selection: null,
                results: t.results.map((r, i) =>
                  i !== t.activeResultIndex
                    ? r
                    : { ...r, rows: r.rows.filter((row) => !gone.has(row[0] ?? "")) },
                ),
                rowCount: t.rowCount
                  ? { ...t.rowCount, value: Math.max(0, t.rowCount.value - removed) }
                  : null,
              },
        ),
        toast: {
          kind: "info",
          text: `Deleted ${removed} ${removed === 1 ? "key" : "keys"}.`,
        },
      }));
    } catch (e) {
      set({ toast: { kind: "error", text: asDbError(e).message } });
    }
  },

  selectQueueState: async (tabId, state) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.queue) return;

    // Closing drops the rows as well as the selection. Leaving them behind
    // would put a page of `failed` jobs under a diagram with nothing selected,
    // which reads as the state still being open.
    if (state === null) {
      patchQueue(tabId, { state: null, jobs: [], total: 0 });
      patchTab(tabId, { results: [], staged: [], selectedRows: [], selection: null });
      return;
    }

    patchQueue(tabId, { state });
    // Marks do not survive the move. A job staged in `failed` means nothing in
    // `completed`, and committing one the user can no longer see would be the
    // app acting on something it stopped showing them.
    patchTab(tabId, { page: { ...tab.page, offset: 0 }, staged: [], selectedRows: [], selection: null });
    await get().goJobPage(tabId, 0);
  },

  goJobPage: async (tabId, delta) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    const queue = tab?.queue;
    if (!tab?.connectionId || !queue?.state || !tab.object) return;

    const { limit } = tab.page;
    const offset = Math.max(0, tab.page.offset + delta * limit);

    patchTab(tabId, { running: true, error: null, staged: [], selectedRows: [], selection: null });
    const started = performance.now();
    try {
      const page = await ipc.listJobs(
        tab.connectionId,
        queue.prefix,
        tab.object.name,
        queue.state,
        offset,
        limit,
      );
      const clientMs = Math.round(performance.now() - started);
      patchTab(tabId, {
        results: [jobsToResult(page, clientMs)],
        activeResultIndex: 0,
        running: false,
        clientMs,
        page: { limit, offset },
      });
      // Read after the fetch, not before: a poll that landed while the page was
      // in flight has already accounted for itself, and taking the earlier id
      // would report those events as changes this page does not include.
      patchQueue(tabId, {
        jobs: page.jobs,
        order: page.order,
        total: page.total,
        readAtEventId: get().tabs.find((t) => t.id === tabId)?.queue?.lastEventId ?? "",
      });
    } catch (e) {
      patchTab(tabId, {
        running: false,
        error: asDbError(e),
        clientMs: Math.round(performance.now() - started),
      });
    }
  },

  setQueueLive: (tabId, live) => patchQueue(tabId, { live }),

  /**
   * One poll: the counts, and whatever the stream recorded since the last one.
   *
   * Failures are swallowed rather than raised. This runs every second, and a
   * disconnected server would otherwise produce a toast a second — the tab
   * simply keeps showing the last thing it knew, which is what a monitor whose
   * feed dropped should do.
   */
  pollQueue: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    const queue = tab?.queue;
    if (!tab?.connectionId || !queue || !tab.object) return;

    const { prefix, lastEventId } = queue;
    try {
      const [entry, page] = await Promise.all([
        ipc.queueCounts(tab.connectionId, prefix, tab.object.name),
        ipc.queueEvents(
          tab.connectionId,
          prefix,
          tab.object.name,
          lastEventId || null,
          EVENT_PAGE,
        ),
      ]);

      // Re-read: a poll is a round trip, and the tab may have been closed or
      // moved to another state while it was in flight.
      const current = get().tabs.find((t) => t.id === tabId)?.queue;
      if (!current) return;

      // A trimmed window means transitions happened that this page cannot
      // account for, so what is held is a gapped history rather than a short
      // one. Dropped rather than appended to: the next poll starts clean and
      // rates become measurable again, and until then they are `null` rather
      // than a number derived from holes.
      const events = page.trimmed
        ? page.events
        : [...current.events, ...page.events].slice(-EVENT_MEMORY);

      // The sidebar holds the same counts, from a walk that may be minutes old.
      // The queue being watched is the one whose row is worth keeping true;
      // the rest stay as of the last walk, with a refresh beside the section.
      set((s) => {
        const list = s.queues[tab.connectionId!];
        if (!list?.some((q) => q.name === tab.object!.name)) return {};
        return {
          queues: {
            ...s.queues,
            [tab.connectionId!]: list.map((q) => (q.name === entry.name ? entry : q)),
          },
        };
      });

      patchQueue(tabId, {
        counts: entry.counts,
        paused: entry.paused,
        legacyPaused: entry.legacyPaused,
        events,
        lastEventId: page.lastId || current.lastEventId,
        rates: page.trimmed ? null : edgeRates(events, page.serverNow),
      });
    } catch {
      /* The tab keeps showing the last thing it knew. */
    }
  },

  refreshQueue: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.queue) return;
    await track(busyKey.queue(tabId), "Refreshing queue…", async () => {
      await get().pollQueue(tabId);
      // The counts come back either way; the rows only exist when a state is
      // open, and refreshing a page that is not on screen is work for nothing.
      if (get().tabs.find((t) => t.id === tabId)?.queue?.state) {
        await get().goJobPage(tabId, 0);
      }
    });
  },

  commitRetry: async (tabId, reset) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    const queue = tab?.queue;
    if (!tab?.connectionId || !queue?.state || !tab.object || tab.staged.length === 0) return;
    if (!RETRYABLE_STATES.includes(queue.state)) return;

    const result = tab.results[tab.activeResultIndex];
    if (!result) return;

    // Only what is on screen, for the reason `commitStaged` gives: a job staged
    // before a page turn is one the user can no longer see.
    const jobIds = stagedJobsIn(result, new Set(tab.staged));
    if (jobIds.length === 0) {
      patchTab(tabId, { staged: [] });
      return;
    }

    try {
      const outcomes = await ipc.retryJobs(tab.connectionId, {
        prefix: queue.prefix,
        queue: tab.object.name,
        state: queue.state,
        jobIds,
        resetAttemptsMade: reset,
      });
      patchTab(tabId, { staged: [], selectedRows: [], selection: null });
      set({ toast: { kind: "info", text: retryOutcome(outcomes) } });

      // Re-read rather than dropping the rows in place, unlike a deletion:
      // the jobs did not disappear, they moved to `wait`, and this page is now
      // one page of a state that has fewer of them. Offset paging is stable
      // under that, so nothing shifts under the user.
      await get().goJobPage(tabId, 0);
      void get().pollQueue(tabId);
    } catch (e) {
      set({ toast: { kind: "error", text: asDbError(e).message } });
    }
  },

  setTabView: async (tabId, view) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    patchTab(tabId, { view });

    const { connectionId, object } = tab;
    if (!object || !connectionId) return;

    const fail = (e: unknown) => set({ toast: { kind: "error", text: asDbError(e).message } });

    // Each view fetches what it needs the first time it is looked at, and
    // never again for the life of the tab. Columns are usually already here:
    // opening a table tab fetches them for the editor.
    if (view === "structure" && !tab.indexes) {
      try {
        const [columns, indexes] = await Promise.all([
          tab.columns ?? ipc.listColumns(connectionId, object.schema, object.name),
          ipc.listIndexes(connectionId, object.schema, object.name),
        ]);
        patchTab(tabId, { columns, indexes });
      } catch (e) {
        fail(e);
      }
    }

    if (view === "definition" && tab.definition === null) {
      try {
        const definition =
          object.kind === "function"
            ? await ipc.functionDefinition(connectionId, object.oid ?? 0)
            : await ipc.viewDefinition(connectionId, object.schema, object.name);
        patchTab(tabId, { definition });
      } catch (e) {
        fail(e);
      }
    }
  },

  /** Moves the caret without opening anything: arrow keys, and clearing on a new page. */
  setSelection: (tabId, selection) => patchTab(tabId, { selection }),

  // A click on a cell both selects it and shows the row, which is what makes
  // the panel a reading surface rather than one more thing to open. Arrow keys
  // deliberately do not: navigating a grid is not a request for a panel.
  selectCell: (tabId, row, col) => {
    patchTab(tabId, { selection: { row, col } });
    if (!get().rowPanel) set({ rowPanel: true });
  },

  toggleRowPanel: () => set((s) => ({ rowPanel: !s.rowPanel })),
  closeRowPanel: () => set({ rowPanel: false }),

  beginEdit: (tabId, row, col, where = "grid") => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const value = tab.results[tab.activeResultIndex]?.rows[row]?.[col];
    if (value === undefined) return;

    // Per cell, because on a keyspace the answer differs down the row: the
    // value and the TTL are writable, the key and its size are not. Asked here
    // rather than at commit so a refusal lands on the double click, where the
    // user is looking, instead of after they have typed something.
    const reason = cellEditableReason({ ...tab, selection: { row, col } }, col);
    if (reason !== null) {
      // Refusing in silence is the worst version of this: the user double
      // clicks, nothing happens, and there is nothing on screen that says why.
      set({ toast: { kind: "error", text: reason } });
      // The commonest reason is simply that the definition has not arrived, and
      // asking for it now means the next attempt works.
      if (!tab.columns) void get().ensureColumns(tabId);
      return;
    }
    set({ cellEdit: { tabId, row, col, draft: value ?? "", isNull: value === null, where } });
    // Editing a cell that is not selected would leave the panel describing a
    // different row than the one under the caret.
    patchTab(tabId, { selection: { row, col } });
  },

  setEditDraft: (draft) =>
    set((s) => (s.cellEdit ? { cellEdit: { ...s.cellEdit, draft, isNull: false } } : {})),

  setEditNull: (isNull) => set((s) => (s.cellEdit ? { cellEdit: { ...s.cellEdit, isNull } } : {})),

  cancelEdit: () => set({ cellEdit: null }),

  /**
   * Writes the open edit.
   *
   * The row is identified by the table's own primary key, read out of the row
   * already on screen. The backend checks that identity against the catalogue
   * and refuses anything else, so this is a request to write, not an
   * instruction about how to find the row.
   */
  commitEdit: async () => {
    const edit = get().cellEdit;
    if (!edit) return;
    const tab = get().tabs.find((t) => t.id === edit.tabId);
    const object = tab?.object;
    if (!tab || !object || !tab.connectionId) return;

    const result = tab.results[tab.activeResultIndex];
    const column = result?.columns[edit.col]?.name;
    if (!result || !column) return;

    // A keyspace row is named by its key, which is its identity rather than a
    // primary key discovered in a catalogue. Nothing else about the write
    // changes: the same `update_cell` runs, and the backend still decides what
    // the named field means.
    if (isKeyspace(tab.object)) {
      const keys = keyRowIdentity(result, edit.row);
      if (!keys) {
        set({ toast: { kind: "error", text: "That row has no key to write to." }, cellEdit: null });
        return;
      }
      const reason = cellEditableReason(tab, edit.col);
      if (reason !== null) {
        set({ toast: { kind: "error", text: reason }, cellEdit: null });
        return;
      }

      // The TTL column is typed in the units it prints — "15m", "2d 4h",
      // "never" — and the wire takes seconds. Converting here means the field
      // accepts back exactly what it showed, instead of making the user
      // translate their own expiry into a number.
      let value = edit.isNull ? null : edit.draft;
      if (column === "ttl" && value !== null) {
        const seconds = parseTtl(value);
        if (seconds === undefined) {
          set({
            toast: {
              kind: "error",
              text: `"${value}" is not a duration. Try 900, 15m, 2d 4h, or never.`,
            },
            cellEdit: null,
          });
          return;
        }
        value = seconds === null ? "" : String(seconds);
      }

      set({ cellEdit: null });
      try {
        const stored = await ipc.updateCell(
          tab.connectionId,
          object.schema,
          object.name,
          column,
          value,
          keys,
        );
        // The TTL column shows a duration, not the seconds the server returned.
        const shown = column === "ttl" ? formatTtl(Number(stored)) : stored;
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id !== edit.tabId
              ? t
              : {
                  ...t,
                  results: t.results.map((r, i) =>
                    i !== t.activeResultIndex
                      ? r
                      : {
                          ...r,
                          rows: r.rows.map((existing, ri) =>
                            ri !== edit.row
                              ? existing
                              : existing.map((v, ci) => (ci === edit.col ? shown : v)),
                          ),
                        },
                  ),
                },
          ),
        }));
      } catch (e) {
        set({ toast: { kind: "error", text: asDbError(e).message } });
      }
      return;
    }

    // The same rule the status bar previewed with, so what runs is what was
    // shown. A key that is not in the result, or is NULL, cannot identify
    // anything: better to say so than to send a `where` that matches the
    // wrong row.
    const identity = rowKeysFor(tab.columns, result, edit.row);
    if (!identity.ok) {
      set({
        toast: {
          kind: "error",
          text: identity.missing
            ? `Cannot identify this row: ${identity.missing} is not in the result.`
            : "Cannot identify this row: the table has no primary key.",
        },
        cellEdit: null,
      });
      return;
    }
    const keys = identity.keys;

    const value = edit.isNull ? null : edit.draft;
    set({ cellEdit: null });

    try {
      const stored = await ipc.updateCell(
        tab.connectionId,
        object.schema,
        object.name,
        column,
        value,
        keys,
      );
      // What Postgres kept, not what was typed: a numeric is rounded to its
      // scale and a timestamptz is normalised, and showing the typed text would
      // leave the grid quietly disagreeing with the table.
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id !== edit.tabId
            ? t
            : {
                ...t,
                results: t.results.map((r, i) =>
                  i !== t.activeResultIndex
                    ? r
                    : {
                        ...r,
                        rows: r.rows.map((existing, ri) =>
                          ri !== edit.row
                            ? existing
                            : existing.map((v, ci) => (ci === edit.col ? stored : v)),
                        ),
                      },
                ),
              },
        ),
      }));
    } catch (e) {
      set({ toast: { kind: "error", text: asDbError(e).message } });
    }
  },

  openCellView: (tabId, row, col) => {
    // Selecting too, so the grid, the row panel and the expanded editor never
    // describe three different cells.
    set({ cellView: { tabId, row, col } });
    patchTab(tabId, { selection: { row, col } });
  },

  closeCellView: () => set({ cellView: null }),

  /**
   * Writes what the expanded editor is holding.
   *
   * Composed out of the normal edit rather than given a write of its own: the
   * primary key check, the status bar preview and the error handling all live
   * in `commitEdit`, and a second path to `update_cell` would be a second place
   * for them to be wrong. `beginEdit` refuses and says why when the tab cannot
   * be written to, which is exactly the answer this needs.
   */
  commitCellView: async (text) => {
    const view = get().cellView;
    if (!view) return;
    get().beginEdit(view.tabId, view.row, view.col, "panel");
    if (!get().cellEdit) return;
    if (text === null) get().setEditNull(true);
    else get().setEditDraft(text);
    set({ cellView: null });
    await get().commitEdit();
  },

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  // No transition. This is a configuration change, and one that happens
  // instantly is the honest reading of it.
  toggleTranslucency: () => {
    const on = !get().translucent;
    set({ translucent: on });
    saveTranslucency(on);
    void applyTranslucency(on);
  },
  /**
   * No transition either, and for the same reason: a palette that fades reads
   * as the app still deciding which one it is.
   */
  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    savePrefs(prefs);
    applyPrefs(prefs);
  },
  setSettings: (settings) => set({ settings }),

  /**
   * Reads the policy and decides whether the lock screen stands.
   *
   * Runs before `loadConnections`, and that order is the point: nothing about
   * which servers exist should be readable behind the lock.
   */
  loadSecurity: async () => {
    try {
      const [security, available] = await Promise.all([
        ipc.getSecurityPolicy(),
        ipc.biometricAvailable(),
      ]);
      const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
      const biometrics = biometricSupport(available, ua);
      // A policy that says "lock" on a machine that cannot prompt would be a
      // door with no handle: the stored preference is honoured only where
      // there is something to answer it with.
      set({
        security,
        biometrics,
        locked: security.lockOnLaunch && biometrics === "available",
      });
    } catch {
      /* The backend is what enforces this. A failure to read the policy leaves
         the window unlocked and every gated `connect` still gated. */
      set({ locked: false });
    }
  },

  unlock: async () => {
    await ipc.unlockApp();
    set({ locked: false });
  },

  /**
   * Writes the app-wide half of the policy.
   *
   * The backend answers with what it stored, and that answer is what lands in
   * the store — a refusal throws before the write, so the switch springs back
   * rather than showing a setting that was never saved.
   */
  setSecurity: async (patch) => {
    const security = await ipc.setSecurityPolicy({ ...get().security, ...patch });
    set({ security });
  },

  /**
   * Writes the per-connection half.
   *
   * Through `saveConnection` because that is the one path that persists a
   * connection, with both secrets left alone — this is not the surface where a
   * password is typed, and passing anything for them here would be a way to
   * silently clear one.
   */
  setConnectionBiometric: async (id, on) => {
    const config = get().connections.find((c) => c.id === id);
    if (!config) return;
    try {
      await get().saveConnection({ ...config, requireBiometric: on });
    } catch (e) {
      set({ toast: { kind: "error", text: asDbError(e).message } });
    }
  },
  setPalette: (mode) => set({ palette: mode }),
  // Both "lost" flags are cleared here rather than accepted as arguments: the
  // only thing that can know a secret is unreadable is the connect attempt
  // that hit it, and it sets the sheet itself.
  setSheet: (open, editing = null, credentialLost = false) =>
    set({ sheet: { open, editing, credentialLost, sshSecretLost: false } }),
  anchorSelection: (connectionId, key) =>
    set({ selection: { connectionId, keys: [], anchor: key } }),

  toggleSelected: (connectionId, key) =>
    set((s) => {
      // A modifier click in a different connection starts a new selection
      // rather than adding to one the user can no longer see.
      const same = s.selection.connectionId === connectionId;
      const keys = same ? toggleKey(s.selection.keys, key) : [key];
      return { selection: { connectionId, keys, anchor: key } };
    }),

  selectRange: (connectionId, order, key) =>
    set((s) => {
      const same = s.selection.connectionId === connectionId;
      const anchor = same ? s.selection.anchor : null;
      return {
        selection: { connectionId, keys: rangeBetween(order, anchor, key), anchor: anchor ?? key },
      };
    }),

  clearSelection: () => set({ selection: { connectionId: null, keys: [], anchor: null } }),

  setExportTarget: (exportTarget) => set({ exportTarget }),

  setToast: (toast) => set({ toast }),

  setErrorDialog: (errorDialog) => set({ errorDialog }),
  };
});

/**
 * The tab every command acts on: the one in the focused pane.
 *
 * With one pane this is `activeTabId` and nothing has changed. With two, ⌘R has
 * to run the half the user is looking at, which is the only reason `focusedPane`
 * exists.
 */
export const activeTab = (s: AppState) => {
  const focused = s.focusedPane === "split" ? s.splitTabId : s.activeTabId;
  // Falls back rather than answering null: dropping an object or deleting a
  // connection closes tabs, and a focus left pointing at one of them would
  // disable every command while a pane on screen still has a tab in it.
  return (
    s.tabs.find((t) => t.id === focused) ?? s.tabs.find((t) => t.id === s.activeTabId) ?? null
  );
};

/**
 * Shared empty list, so a tab that has nothing staged still answers with the
 * same reference every time.
 *
 * `?? []` would not do: a fresh array literal is a fresh reference, and a
 * selector whose reference changes on every call is exactly what the comment
 * below is about.
 */
const NO_KEYS: readonly string[] = [];

/**
 * The keys staged for deletion on one tab.
 *
 * Returns the stored array itself, never a copy or a derived `Set`. Zustand
 * runs on `useSyncExternalStore`, which calls the selector on every render and
 * compares the result with `Object.is` — so a selector that builds a new object
 * each time reports a change on every render, and React spins until it gives up
 * and unmounts the tree. The caller derives its own `Set` behind a `useMemo`.
 */
export const stagedKeys =
  (tabId: string) =>
  (s: AppState): readonly string[] =>
    s.tabs.find((t) => t.id === tabId)?.staged ?? NO_KEYS;
