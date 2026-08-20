/**
 * Switching database derives a connection, and deriving the same one twice is
 * the failure that leaves a sidebar full of entries nobody can tell apart.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import type { ConnectionConfig } from "@/lib/types";
import { rowStageKey } from "@/lib/utils/rowKeys";

const calls: { name: string; args: Record<string, unknown> }[] = [];

/** What `delete_connection` reports as still existing. Set per test. */
let remaining: unknown[] = [];

/** Set to make `delete_rows` refuse, the way a foreign key violation does. */
let deleteRejects: unknown = null;

mock.module("@tauri-apps/api/core", () => ({
  invoke: (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    switch (name) {
      case "connect":
        return Promise.resolve({
          id: "",
          serverVersion: "PostgreSQL 16.2",
          backendPid: 1,
          currentDatabase: "",
        });
      case "delete_connection":
        return Promise.resolve(remaining);
      case "delete_rows":
        return deleteRejects
          ? Promise.reject(deleteRejects)
          : Promise.resolve((args.rows as unknown[]).length);
      default:
        return Promise.resolve([]);
    }
  },
}));

/** Bun has no `localStorage`; pinned tabs and translucency both read it. */
const stored = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => void stored.set(k, v),
  removeItem: (k: string) => void stored.delete(k),
};

const { useApp, activeTab, stagedKeys } = await import("@/store/app");

const server: ConnectionConfig = {
  id: "server",
  driver: "postgres",
  name: "localhost",
  host: "localhost",
  port: 5432,
  user: "postgres",
  database: "",
  sslMode: "prefer",
  environment: "production",
  parentId: null,
};

/** A keyspace tab, with only the fields the staged-keys selector reads. */
const keyspaceTab = () => ({
  id: "tab-k",
  connectionId: "server",
  title: "db0",
  object: { schema: "db0", name: "db0", kind: "keyspace" as const },
  pinned: false,
  page: { limit: 200, offset: 0 },
  cursors: [0],
  scan: null,
  staged: [] as string[],
  paged: false,
  pageNote: null,
  sort: null,
  filters: [],
  rowCount: null,
  view: "data" as const,
  columns: null,
  indexes: null,
  graph: null,
  selection: null,
  definition: null,
  sql: "",
  results: [],
  activeResultIndex: 0,
  running: false,
  error: null,
  clientMs: null,
});

const saved = () => calls.filter((c) => c.name === "save_connection");
const connected = () => calls.filter((c) => c.name === "connect");

beforeEach(() => {
  calls.length = 0;
  remaining = [];
  deleteRejects = null;
  useApp.setState({
    connections: [server],
    open: {},
    databases: {},
    schemas: {},
    tabs: [],
    activeTabId: null,
  });
});

test("picking a database derives a connection named after it", async () => {
  await useApp.getState().openDatabase("server", "myapp");

  const config = saved()[0]?.args.config as ConnectionConfig;
  expect(config.name).toBe("myapp");
  expect(config.database).toBe("myapp");
  // The credential stays on the server, and the tint comes with it.
  expect(config.parentId).toBe("server");
  expect(config.environment).toBe("production");
  // A database picked off a server is opened by the same driver as the server.
  expect(config.driver).toBe("postgres");
  expect(saved()[0]?.args.password).toBeNull();
  expect(connected()).toHaveLength(1);
});

test("a database that already has a connection is reused, not duplicated", async () => {
  const existing: ConnectionConfig = { ...server, id: "child", name: "myapp", database: "myapp", parentId: "server" };
  useApp.setState({ connections: [server, existing] });

  await useApp.getState().openDatabase("server", "myapp");

  expect(saved()).toHaveLength(0);
  expect((connected()[0]?.args.config as ConnectionConfig).id).toBe("child");
});

test("deleting a server forgets the sessions and tabs of its databases too", async () => {
  const child: ConnectionConfig = { ...server, id: "child", name: "myapp", database: "myapp", parentId: "server" };
  const other: ConnectionConfig = { ...server, id: "other", name: "elsewhere", parentId: null };
  useApp.setState({
    connections: [server, child, other],
    open: {
      server: { id: "server", serverVersion: "", backendPid: 1, currentDatabase: "postgres" },
      child: { id: "child", serverVersion: "", backendPid: 2, currentDatabase: "myapp" },
      other: { id: "other", serverVersion: "", backendPid: 3, currentDatabase: "postgres" },
    },
    databases: { server: ["myapp"] },
    schemas: { child: [{ name: "public" }] },
    tables: { "child::public": [] },
    activeConnectionId: "child",
  });
  useApp.getState().openTab("child");
  useApp.getState().openTab("other");

  // The backend takes the children with the parent, so the returned list is
  // what decides who is gone.
  remaining = [other];
  await useApp.getState().deleteConnection("server");

  const s = useApp.getState();
  expect(Object.keys(s.open)).toEqual(["other"]);
  expect(s.databases).toEqual({});
  expect(s.schemas).toEqual({});
  expect(s.tables).toEqual({});
  expect(s.tabs.map((t) => t.connectionId)).toEqual(["other"]);
  expect(s.activeTabId).toBe(s.tabs[0]!.id);
  expect(s.activeConnectionId).toBeNull();
});

test("a database derived from a derived connection points back at the server", async () => {
  const child: ConnectionConfig = { ...server, id: "child", name: "myapp", database: "myapp", parentId: "server" };
  useApp.setState({ connections: [server, child] });

  await useApp.getState().openDatabase("child", "other");

  expect((saved()[0]?.args.config as ConnectionConfig).parentId).toBe("server");
});

/**
 * A selector that builds a new object each call is an infinite render loop.
 *
 * Zustand runs on `useSyncExternalStore`, which calls the selector on every
 * render and compares the result with `Object.is`. A selector returning
 * `new Set(...)` therefore reports a change every single render, React spins
 * until it gives up, and the tree unmounts — which on screen is the whole
 * window going black.
 *
 * It shipped once, in the grid's staged-deletion selector, and it only fired
 * once a key was actually staged: while the list was empty the selector
 * returned a stable `null` and everything looked fine. That is what makes the
 * class worth a test rather than a code review note.
 */
test("the staged-keys selector returns the same reference until it really changes", () => {
  useApp.setState({
    tabs: [
      {
        ...keyspaceTab(),
        id: "tab-k",
        staged: ["nvp:na:1"],
      },
    ],
    activeTabId: "tab-k",
  });

  const select = stagedKeys("tab-k");
  const first = select(useApp.getState());
  const second = select(useApp.getState());

  // Referential, not structural: `toEqual` would pass on a fresh copy and miss
  // the whole bug.
  expect(first).toBe(second);
  expect(first).toEqual(["nvp:na:1"]);

  // Staging something else is a real change, and has to be visible as one.
  useApp.getState().toggleStaged("tab-k", "nvp:na:2");
  const third = select(useApp.getState());
  expect(third).not.toBe(first);
  expect(third).toEqual(["nvp:na:1", "nvp:na:2"]);

  // Unstaging back to empty still answers with a stable reference, which is
  // the state the old selector happened to get right.
  useApp.getState().clearStaged("tab-k");
  expect(select(useApp.getState())).toBe(select(useApp.getState()));

  // And a tab that does not exist answers with the same empty list every time,
  // rather than a fresh `[]` — which is the same bug wearing a different shape.
  const missing = stagedKeys("tab-nowhere");
  expect(missing(useApp.getState())).toBe(missing(useApp.getState()));
});


/**
 * One database at a time per server.
 *
 * The whole point is what is *not* closed: the server session that lists the
 * databases, and every connection on another server. A sweep that takes either
 * shows up as the app dropping a connection nobody asked it to drop.
 */
const info = (id: string, database: string) => ({
  id,
  serverVersion: "PostgreSQL 16.2",
  backendPid: 1,
  currentDatabase: database,
});

const alpha: ConnectionConfig = { ...server, id: "alpha", name: "alpha", database: "alpha", parentId: "server" };
const beta: ConnectionConfig = { ...server, id: "beta", name: "beta", database: "beta", parentId: "server" };
const elsewhere: ConnectionConfig = { ...server, id: "elsewhere", host: "replica", parentId: null };
const gamma: ConnectionConfig = { ...server, id: "gamma", host: "replica", name: "gamma", database: "gamma", parentId: "elsewhere" };

test("opening a database closes the one it replaces, and nothing else", async () => {
  useApp.setState({
    connections: [server, alpha, beta, elsewhere, gamma],
    open: {
      server: info("server", "postgres"),
      alpha: info("alpha", "alpha"),
      elsewhere: info("elsewhere", "postgres"),
      gamma: info("gamma", "gamma"),
    },
    activeConnectionId: "alpha",
  });

  await useApp.getState().openDatabase("server", "beta");

  const s = useApp.getState();
  expect(s.activeConnectionId).toBe("beta");
  // `alpha` is gone. The server session it was picked off stays, and so does
  // the whole of the other server.
  expect(Object.keys(s.open).sort()).toEqual(["beta", "elsewhere", "gamma", "server"]);
  expect(calls.filter((c) => c.name === "disconnect").map((c) => c.args.id)).toEqual(["alpha"]);
});

test("a closed database keeps its tabs, and gets them back when it returns", async () => {
  useApp.setState({
    connections: [server, alpha, beta],
    open: { server: info("server", "postgres"), alpha: info("alpha", "alpha") },
    activeConnectionId: "alpha",
    tabs: [],
    activeTabId: null,
  });
  useApp.getState().openTab("alpha");
  useApp.getState().openTab("alpha");
  const mine = useApp.getState().tabs.map((t) => t.id);
  useApp.getState().setTabSql(mine[0]!, "select 1");

  await useApp.getState().openDatabase("server", "beta");

  // Closing a session is not closing its tabs: they are still there, they are
  // just not the ones the strip is drawing.
  expect(useApp.getState().tabs.filter((t) => t.connectionId === "alpha").map((t) => t.id)).toEqual(mine);

  await useApp.getState().openDatabase("server", "alpha");

  const s = useApp.getState();
  expect(s.activeConnectionId).toBe("alpha");
  // The same tabs, not fresh ones, and the focus lands back on the last of them.
  expect(s.tabs.filter((t) => t.connectionId === "alpha").map((t) => t.id)).toEqual(mine);
  expect(s.activeTabId).toBe(mine[mine.length - 1]);
  expect(s.tabs.find((t) => t.id === mine[0])?.sql).toBe("select 1");
});

test("expanding a schema folds the one beside it and keeps what it read", async () => {
  useApp.setState({
    connections: [server, alpha],
    open: { alpha: info("alpha", "alpha") },
    activeConnectionId: "alpha",
    schemas: { alpha: [{ name: "public" }, { name: "auth" }] },
    tables: { "alpha::public": [] },
    functions: { "alpha::public": [] },
    expandedSchemas: { "alpha::public": true, "other::public": true },
  });

  await useApp.getState().toggleSchema("alpha", "auth");

  const s = useApp.getState();
  expect(s.expandedSchemas).toEqual({ "other::public": true, "alpha::auth": true });
  // The lists survive the fold, so opening `public` again costs no round trip.
  expect(s.tables["alpha::public"]).toBeDefined();
});

test("reconnecting a connection that still has tabs does not duplicate its pinned ones", async () => {
  stored.set(
    "rashbase.pinnedTabs.v1",
    JSON.stringify([{ connectionId: "alpha", object: null, sql: "select 1" }]),
  );
  useApp.setState({
    connections: [server, alpha],
    open: {},
    activeConnectionId: null,
    tabs: [],
    activeTabId: null,
  });

  await useApp.getState().connect(alpha);
  expect(useApp.getState().tabs).toHaveLength(1);

  await useApp.getState().disconnect("alpha");
  await useApp.getState().connect(alpha);

  // Switching database now closes sessions routinely, so the restore loop runs
  // far more often than it used to. `openTab` always pushes, so without the
  // guard this is where a second copy of every pinned query tab appears.
  expect(useApp.getState().tabs).toHaveLength(1);
});


/**
 * Two panes, one keyboard.
 *
 * The failures worth naming: the same tab in both panes, which draws one thing
 * twice and leaves the strip with no way to tell them apart; and a split left
 * pointing at a tab that has been closed or belongs to a connection that is no
 * longer open, which is a half-window showing nothing.
 */
test("opening a tab in the split moves it out of the main pane", () => {
  useApp.setState({
    connections: [server, alpha],
    open: { alpha: info("alpha", "alpha") },
    activeConnectionId: "alpha",
    tabs: [],
    activeTabId: null,
    splitTabId: null,
    focusedPane: "main",
  });
  useApp.getState().openTab("alpha");
  useApp.getState().openTab("alpha");
  const [first, second] = useApp.getState().tabs.map((t) => t.id);

  useApp.getState().openInSplit(second!);

  const s = useApp.getState();
  expect(s.splitTabId).toBe(second!);
  // Not both. The main pane falls back to the tab beside it.
  expect(s.activeTabId).toBe(first!);
  expect(s.focusedPane).toBe("split");
  // Commands act on the pane with the keyboard.
  expect(activeTab(s)?.id).toBe(second!);
});

/** Two tabs on one connection, the second of them in the split. */
function splitFixture() {
  useApp.setState({
    connections: [server, alpha],
    open: { alpha: info("alpha", "alpha") },
    activeConnectionId: "alpha",
    tabs: [],
    activeTabId: null,
    splitTabId: null,
    focusedPane: "main",
  });
  useApp.getState().openTab("alpha");
  useApp.getState().openTab("alpha");
  const ids = useApp.getState().tabs.map((t) => t.id);
  useApp.getState().openInSplit(ids[1]!);
  return ids as [string, string];
}

test("clicking the split's tab in the strip focuses that pane instead of moving it", () => {
  const [first, second] = splitFixture();
  useApp.getState().setActiveTab(first);
  expect(useApp.getState().focusedPane).toBe("main");

  useApp.getState().setActiveTab(second);

  const s = useApp.getState();
  expect(s.focusedPane).toBe("split");
  expect(s.splitTabId).toBe(second);
  // Still the split's, not pulled across into the pane it was already beside.
  expect(s.activeTabId).toBe(first);
});

test("closing the split's tab closes the split", () => {
  const [, second] = splitFixture();

  useApp.getState().closeTab(second);

  const s = useApp.getState();
  expect(s.splitTabId).toBeNull();
  expect(s.focusedPane).toBe("main");
  expect(s.tabs.some((t) => t.id === second)).toBe(false);
});

test("switching connection takes the split with it", async () => {
  useApp.setState({
    connections: [server, alpha, beta],
    open: { server: info("server", "postgres"), alpha: info("alpha", "alpha") },
    activeConnectionId: "alpha",
    tabs: [],
    activeTabId: null,
    splitTabId: null,
    focusedPane: "main",
  });
  useApp.getState().openTab("alpha");
  useApp.getState().openTab("alpha");
  const mine = useApp.getState().tabs.map((t) => t.id);
  useApp.getState().openInSplit(mine[1]!);

  await useApp.getState().openDatabase("server", "beta");

  // A pane showing another connection's tab is a pane showing something that
  // cannot run. It comes back the way everything else does: by opening it.
  expect(useApp.getState().splitTabId).toBeNull();
  expect(useApp.getState().focusedPane).toBe("main");

  await useApp.getState().openDatabase("server", "alpha");
  expect(useApp.getState().tabs.filter((t) => t.connectionId === "alpha").map((t) => t.id)).toEqual(mine);
});


/**
 * Staged row deletions.
 *
 * Two failures worth naming. Sending a row the user can no longer see: the
 * marks are identities, and one whose row has scrolled out of the result must
 * not reach the backend. And dropping the wrong rows afterwards: the result is
 * edited in place rather than re-read, so if the identity used to filter it
 * disagrees with the identity that was sent, the grid loses a row that is still
 * in the table.
 */
test("committing staged rows deletes exactly what is on screen and drops those rows", async () => {
  const columns = [
    { name: "id", dataType: "text", notNull: true, default: null, primaryKey: true, comment: null },
  ];
  const result = {
    columns: [{ name: "id", typeName: "text", typeClass: "text" as const }],
    rows: [["1"], ["2"], ["3"]],
    rowsAffected: 0,
    durationMs: 0,
  };
  const tab = {
    ...keyspaceTab(),
    id: "tab-t",
    object: { schema: "public", name: "users", kind: "table" as const },
    columns,
    results: [result],
    rowCount: { value: 3, exact: true },
    // "2" is on screen; "99" was staged on a page since turned away from.
    staged: [
      rowStageKey([{ column: "id", value: "2" }]),
      rowStageKey([{ column: "id", value: "99" }]),
    ],
  };
  useApp.setState({ tabs: [tab], activeTabId: "tab-t", open: { server: info("server", "postgres") } });

  await useApp.getState().commitStaged("tab-t");

  const sent = calls.find((c) => c.name === "delete_rows");
  expect(sent?.args.schema).toBe("public");
  expect(sent?.args.table).toBe("users");
  // Only the row still visible. The off-screen mark is dropped, not sent.
  expect(sent?.args.rows).toEqual([[{ column: "id", value: "2" }]]);

  const s = useApp.getState();
  const after = s.tabs[0]!;
  expect(after.results[0]!.rows).toEqual([["1"], ["3"]]);
  expect(after.staged).toEqual([]);
  expect(after.rowCount).toEqual({ value: 2, exact: true });
});

test("a staged row that has scrolled off screen is forgotten, not sent", async () => {
  const columns = [
    { name: "id", dataType: "text", notNull: true, default: null, primaryKey: true, comment: null },
  ];
  useApp.setState({
    tabs: [
      {
        ...keyspaceTab(),
        id: "tab-t",
        object: { schema: "public", name: "users", kind: "table" as const },
        columns,
        results: [
          {
            columns: [{ name: "id", typeName: "text", typeClass: "text" as const }],
            rows: [["1"]],
            rowsAffected: 0,
            durationMs: 0,
          },
        ],
        staged: [rowStageKey([{ column: "id", value: "99" }])],
      },
    ],
    activeTabId: "tab-t",
  });

  await useApp.getState().commitStaged("tab-t");

  expect(calls.some((c) => c.name === "delete_rows")).toBe(false);
  expect(useApp.getState().tabs[0]!.staged).toEqual([]);
});


/** A table tab holding three rows keyed by `id`, ready to pick from. */
function rowsFixture() {
  const columns = [
    { name: "id", dataType: "text", notNull: true, default: null, primaryKey: true, comment: null },
  ];
  useApp.setState({
    tabs: [
      {
        ...keyspaceTab(),
        id: "tab-t",
        object: { schema: "public", name: "users", kind: "table" as const },
        columns,
        results: [
          {
            columns: [{ name: "id", typeName: "text", typeClass: "text" as const }],
            rows: [["1"], ["2"], ["3"]],
            rowsAffected: 0,
            durationMs: 0,
          },
        ],
        staged: [],
        selectedRows: [],
        rowCount: { value: 3, exact: true },
      },
    ],
    activeTabId: "tab-t",
    errorDialog: null,
    toast: null,
  });
  return ["1", "2", "3"].map((v) => rowStageKey([{ column: "id", value: v }]));
}

/**
 * A bulk delete is the single-row gesture with more rows picked, not a second
 * path. The failure worth naming is Delete behaving like a toggle over a
 * selection: pressing it on four picked rows has to mark all four, where
 * toggling would unmark any that were already red and send a different set than
 * the one on screen.
 */
test("Delete over a picked set marks every row in it", () => {
  const [one, two, three] = rowsFixture();

  useApp.getState().pickRows("tab-t", [one!, three!]);
  useApp.getState().stageRows("tab-t", two!);

  const t = useApp.getState().tabs[0]!;
  // The picked rows, not the row under the caret.
  expect(t.staged).toEqual([one!, three!]);
  // And the pick is spent: the rows are red now, which is the new statement.
  expect(t.selectedRows).toEqual([]);
});

test("with nothing picked, Delete still toggles the one row under the caret", () => {
  const [one] = rowsFixture();

  useApp.getState().stageRows("tab-t", one!);
  expect(useApp.getState().tabs[0]!.staged).toEqual([one!]);

  // Pressing it again on the same row is how a single mark is taken back.
  useApp.getState().stageRows("tab-t", one!);
  expect(useApp.getState().tabs[0]!.staged).toEqual([]);
});

test("staging a picked set twice does not double up", () => {
  const [one, two] = rowsFixture();

  useApp.getState().pickRows("tab-t", [one!]);
  useApp.getState().stageRows("tab-t", null);
  useApp.getState().pickRows("tab-t", [one!, two!]);
  useApp.getState().stageRows("tab-t", null);

  expect(useApp.getState().tabs[0]!.staged).toEqual([one!, two!]);
});

test("picking one row at a time adds and removes it", () => {
  const [one, two] = rowsFixture();

  useApp.getState().toggleRowPick("tab-t", one!);
  useApp.getState().toggleRowPick("tab-t", two!);
  expect(useApp.getState().tabs[0]!.selectedRows).toEqual([one!, two!]);

  useApp.getState().toggleRowPick("tab-t", one!);
  expect(useApp.getState().tabs[0]!.selectedRows).toEqual([two!]);
});

/**
 * A refused delete is the case a toast is wrong for: the detail line names the
 * table still referencing the row, and it must survive to the screen. The marks
 * have to survive too — clearing them would make the user re-select every row
 * to retry after clearing the reference.
 */
test("a refused delete opens the error dialog and keeps the marks", async () => {
  const [one] = rowsFixture();
  useApp.getState().pickRows("tab-t", [one!]);
  useApp.getState().stageRows("tab-t", null);

  deleteRejects = {
    message: 'update or delete on table "users" violates foreign key constraint "orders_user_id_fkey" on table "orders"',
    code: "23503",
    detail: 'Key (id)=(1) is still referenced from table "orders".',
    hint: null,
    position: null,
  };

  await useApp.getState().commitStaged("tab-t");

  const s = useApp.getState();
  expect(s.errorDialog?.title).toBe("Rows not deleted");
  expect(s.errorDialog?.error.code).toBe("23503");
  // The database's own detail, unedited.
  expect(s.errorDialog?.error.detail).toContain('still referenced from table "orders"');
  // Nothing was toasted instead, and nothing was dropped from the grid.
  expect(s.toast).toBeNull();
  expect(s.tabs[0]!.staged).toEqual([one!]);
  expect(s.tabs[0]!.results[0]!.rows).toEqual([["1"], ["2"], ["3"]]);
});


/**
 * Following a foreign key.
 *
 * The failure worth naming is a filter that lands on the wrong tab: the
 * referenced table may already be open, in which case `openObjectTab` focuses
 * the tab that exists rather than making a new one, and the filter has to go on
 * that one. Filtering the tab the user came *from* would silently hide the rows
 * they were reading.
 */
test("following a foreign key opens the referenced table filtered to the row", () => {
  useApp.setState({
    connections: [server, alpha],
    open: { alpha: info("alpha", "alpha") },
    activeConnectionId: "alpha",
    tabs: [],
    activeTabId: null,
    splitTabId: null,
    focusedPane: "main",
  });

  useApp
    .getState()
    .openRelation("alpha", { schema: "public", table: "users", column: "id" }, "u-1");

  const s = useApp.getState();
  const opened = s.tabs.find((t) => t.id === s.activeTabId)!;
  expect(opened.object).toEqual({ schema: "public", name: "users", kind: "table" });
  expect(opened.filters).toEqual([
    { id: expect.any(String), column: "id", op: "eq", values: ["u-1"] },
  ]);
});

test("following the same key twice reuses the tab and re-points the filter", () => {
  useApp.setState({
    connections: [server, alpha],
    open: { alpha: info("alpha", "alpha") },
    activeConnectionId: "alpha",
    tabs: [],
    activeTabId: null,
    splitTabId: null,
    focusedPane: "main",
  });
  const target = { schema: "public", table: "users", column: "id" };

  useApp.getState().openRelation("alpha", target, "u-1");
  useApp.getState().openRelation("alpha", target, "u-2");

  const s = useApp.getState();
  // One tab for the table, not one per row followed into it, and the filter is
  // the row asked for last rather than both stacked into an unsatisfiable AND.
  expect(s.tabs.filter((t) => t.object?.name === "users")).toHaveLength(1);
  expect(s.tabs.find((t) => t.id === s.activeTabId)!.filters).toEqual([
    { id: expect.any(String), column: "id", op: "eq", values: ["u-2"] },
  ]);
});
