/**
 * Every shape the app passes around, in one place.
 *
 * Types have no runtime cost and no dependencies, so keeping them together
 * costs nothing and stops the same interface being redeclared on both sides of
 * a module boundary. The three groups below are the three layers that own
 * them: the wire, the SQL builders, and the workspace.
 */

// ---------------------------------------------------------------------------
// Wire: what crosses the IPC boundary
// ---------------------------------------------------------------------------

export type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

/**
 * How the tunnel proves who we are to the jump host. The secret itself is
 * never in the config: like the database password it goes to the OS keystore
 * and is resolved backend-side.
 */
export type SshAuth = "key" | "password";

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  /** `~` allowed. Blank means the usual identity files in `~/.ssh`. */
  keyPath: string;
}

export interface ConnectionConfig {
  id: string;
  /**
   * Which backend driver opens this connection. The backend defaults it to
   * "postgres" when reading a connection saved before drivers existed, so it
   * is always present on anything that comes back over IPC.
   */
  driver: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database: string;
  sslMode: SslMode;
  /** Free-form label ("prod", "staging") that tints the UI. */
  environment: string | null;
  /**
   * The connection this one was derived from by picking a database off its
   * server, and which owns the credential both authenticate with. `null` on a
   * connection the user typed themselves.
   */
  parentId: string | null;
  /**
   * Set when the database is only reachable from inside another machine's
   * network. `host` and `port` keep naming the database as the jump host sees
   * it; the local end of the tunnel never reaches the frontend.
   */
  ssh: SshConfig | null;
}

export interface ConnectionInfo {
  id: string;
  serverVersion: string;
  backendPid: number;
  currentDatabase: string;
}

export type TypeClass =
  | "number"
  | "bool"
  | "text"
  | "temporal"
  | "json"
  | "binary"
  | "uuid"
  | "array"
  | "other";

export interface ColumnMeta {
  name: string;
  typeName: string;
  typeClass: TypeClass;
}

export interface QueryResult {
  columns: ColumnMeta[];
  /** Row-major. `null` is SQL NULL, distinct from the string "NULL". */
  rows: (string | null)[][];
  /**
   * What the server said the statement produced. For a `select` that is the
   * true row count even when `rows` holds fewer, which is what lets the footer
   * say "1,000 of 38,412" rather than guessing.
   */
  rowsAffected: number;
  /** Set when the row cap stopped this result short of what the server sent. */
  truncated: boolean;
  durationMs: number;
}

export interface SchemaEntry {
  name: string;
}

export interface TableEntry {
  name: string;
  kind: "table" | "view" | "matview" | "foreign" | "other";
  comment: string | null;
}

export interface FunctionEntry {
  /** Keyed by oid because overloads share a name. */
  oid: number;
  name: string;
  args: string;
  returns: string;
  kind: "function" | "procedure";
}

/** One part of a row's identity: a primary key column and its current value. */
export interface RowKey {
  column: string;
  value: string;
}

/** A row count and whether it is trustworthy to the digit. */
export interface RowCount {
  value: number;
  exact: boolean;
}

export interface ColumnInfo {
  name: string;
  /** `format_type` output: what `\d` prints, not the internal type name. */
  dataType: string;
  notNull: boolean;
  default: string | null;
  primaryKey: boolean;
  comment: string | null;
  /**
   * Labels of the column's enum type, in declaration order. Empty for every
   * other type, which is the whole test: a non-empty list is what turns the
   * cell editor into a closed list rather than a text field.
   */
  enumValues: string[];
}

export interface IndexInfo {
  name: string;
  /** `pg_get_indexdef` verbatim. */
  definition: string;
  unique: boolean;
  primary: boolean;
}

/**
 * One relation as the diagram draws it.
 *
 * Thinner than `ColumnInfo` on purpose: a schema graph carries every column of
 * every relation at once, and the fields it drops — default, comment, enum
 * labels — are only ever wanted for the one relation the user clicked. Those
 * arrive from `listColumns` when the metadata panel opens.
 */
export interface GraphColumn {
  name: string;
  dataType: string;
  notNull: boolean;
  primaryKey: boolean;
}

export interface GraphTable {
  name: string;
  kind: TableEntry["kind"];
  comment: string | null;
  columns: GraphColumn[];
}

/**
 * One foreign key, as an edge rather than as DDL.
 *
 * `columns` and `refColumns` are positional: the nth referencing column points
 * at the nth referenced one, which is what makes a composite key readable.
 * `refSchema` may not be the schema being drawn — the backend reports the key
 * wherever it points, and the diagram decides what to do about one that leaves.
 */
export interface Relation {
  name: string;
  table: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}

export interface SchemaGraph {
  tables: GraphTable[];
  relations: Relation[];
}

/** The single error shape every command rejects with. */
export interface DbError {
  message: string;
  code: string | null;
  detail: string | null;
  hint: string | null;
  /** 1-based character offset into the submitted SQL, when Postgres reports one. */
  position: number | null;
}

// ---------------------------------------------------------------------------
// Keyspace: what a key-value store has instead of tables
// ---------------------------------------------------------------------------

export interface KeyEntry {
  key: string;
  /** "string" | "hash" | "list" | "set" | "zset" | "stream", as the server says
   *  it. Free-form because the backend passes the store's own word through. */
  kind: string;
  /** Seconds left, `-1` for a key that never expires, `null` when not read.
   *  `-1` and `null` are different answers and stay tellable apart. */
  ttl: number | null;
  /** Bytes for a string, members for everything else. */
  size: number | null;
  /** As much of the value as the scan was willing to read. Collections arrive
   *  as JSON, which is what lets the row panel's tree draw them unchanged. */
  preview: string | null;
}

export interface KeyPage {
  keys: KeyEntry[];
  /** Where to resume. Opaque; `0` starts a walk and is also what comes back
   *  once the walk has come all the way round. */
  cursor: number;
  /** How many keys were walked to fill this page. A value filter is answered by
   *  reading, so a page of 12 can cost a walk of 50,000 — and the footer has to
   *  be able to say so rather than implying it read everything. */
  scanned: number;
  /** Set when the walk came round. A cursor walk can return an empty page and
   *  still have more to give, so this is reported rather than inferred. */
  exhausted: boolean;
  /** Exact, from DBSIZE. No estimate and therefore no `~`. */
  total: number | null;
}

export interface KeyFilter {
  /** Glob the server itself matches. `null` means every key. Nearly free. */
  pattern: string | null;
  /** Text that has to appear in the value. Costs a read of everything walked. */
  contains: string | null;
  caseSensitive: boolean;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type ExportFormat = "sql" | "csv";

/** How much of a relation goes into the dump. A property of the export, not of
 *  each table: per-table it becomes a checkbox matrix nobody can read. */
export type ExportMode = "structure" | "data" | "full";

export type ExportLayout = "single" | "per-table";

/** One relation to export, as the sidebar knows it. */
export interface ObjectRef {
  schema: string;
  name: string;
  /** Matches `TableEntry["kind"]`. Only a table's rows are its own. */
  kind: TableEntry["kind"];
}

export interface ExportRequest {
  objects: ObjectRef[];
  format: ExportFormat;
  mode: ExportMode;
  dropIfExists: boolean;
  /** Whether the dump is written so it can be restored more than once. */
  safe: boolean;
  layout: ExportLayout;
  compress: boolean;
  /** From the native folder picker, so it is a real path. */
  directory: string;
  /** Without an extension. The backend appends the right one. */
  fileName: string;
}

export interface ExportSummary {
  path: string;
  bytes: number;
  tables: number;
  rows: number;
  durationMs: number;
}

/** One `export://progress` event: which relation, and how far along the set is. */
export interface ExportProgress {
  jobId: string;
  table: string;
  done: number;
  total: number;
}

// ---------------------------------------------------------------------------
// SQL: what the statement builders read
// ---------------------------------------------------------------------------

export interface Sort {
  column: string;
  dir: "asc" | "desc";
}

/** The shape the statement builders need out of `ColumnInfo`. */
export interface StatementColumn {
  name: string;
  primaryKey: boolean;
}

export type FilterOp =
  | "eq"
  | "neq"
  | "lt"
  | "gt"
  | "lte"
  | "gte"
  | "in"
  | "notIn"
  | "like"
  | "ilike"
  | "between"
  | "notBetween"
  | "contains"
  | "notContains"
  | "isNull"
  | "isNotNull"
  /** Key-value stores only: a glob the server matches against key names. */
  | "matches"
  /** Key-value stores only: `matches` with the trailing `*` supplied. */
  | "prefix";

export interface Filter {
  id: string;
  /** `null` means "any column": the condition is ORed across every column. */
  column: string | null;
  op: FilterOp;
  /** Arity is decided by the op: none for the null checks, two for between. */
  values: string[];
}

// ---------------------------------------------------------------------------
// Workspace: what the store holds
// ---------------------------------------------------------------------------

/** Which list the palette is showing. All of them use the same surface. */
export type PaletteMode = "commands" | "tables" | "databases";

/** Something in a schema that a tab can be opened on. */
export interface DbObject {
  schema: string;
  name: string;
  /**
   * `"diagram"` is the schema itself rather than something inside it: an ERD
   * tab is an object tab whose object is the whole schema, which is what lets
   * it reuse tab dedupe, the tab strip, and pinning without a second tab kind.
   *
   * `"keyspace"` is the same trick one driver over: a key-value store has one
   * flat namespace, so its tab is an object tab whose object is the whole
   * database. Everything downstream — dedupe, pinning, the tab strip, the grid
   * — works without knowing a second tab kind exists.
   */
  kind: TableEntry["kind"] | "function" | "diagram" | "keyspace";
  /** Functions only. They are keyed by oid because overloads share a name. */
  oid?: number;
}

export interface QueryTab {
  id: string;
  connectionId: string | null;
  title: string;
  /**
   * Set when the tab was opened from the sidebar, which means "show me this
   * object" and not "here is some SQL to edit". Those tabs hide the editor;
   * the SQL is still there so ⌘R can re-run it.
   */
  object: DbObject | null;
  /**
   * Kept across restarts and never taken by "close other tabs". What is stored
   * is what the tab *is* — its connection, its object, its SQL — not what it
   * fetched, so a pinned tab comes back empty and re-runs on demand.
   */
  pinned: boolean;
  /** Paging is server-side, so it survives 30k rows. On a query tab the limit
   *  doubles as the row cap for statements that cannot be paged. */
  page: { limit: number; offset: number };
  /**
   * Keyspace tabs: where each page of the walk started, so Prev can go back.
   *
   * A stack rather than an offset, because a cursor walk has no offsets to
   * count: the server hands back an opaque place to resume and nothing else.
   * The last entry is where the page on screen began; pushing is Next, popping
   * is Prev, and an empty stack is page one.
   */
  cursors: number[];
  /** Keyspace tabs: what the last page cost and whether the walk finished. */
  scan: { scanned: number; exhausted: boolean } | null;
  /**
   * Keys marked for deletion but not yet written.
   *
   * The staging is the confirmation: the rows go red and the status bar prints
   * the command, so ⌘S runs something the user has already read. Held per tab
   * because a mark made while looking at one database means nothing in another.
   */
  staged: string[];
  /**
   * Query tabs: whether the last run wrapped the SQL so it could be paged.
   * False means the rows on screen are however many the cap allowed.
   */
  paged: boolean;
  /** Why the last run could not be paged, in words, or null when it was. */
  pageNote: string | null;
  sort: Sort | null;
  /** ANDed. Server-side like the paging, so a filter reaches the whole table. */
  filters: Filter[];
  rowCount: RowCount | null;
  view: "data" | "structure" | "definition" | "diagram";
  /**
   * Fetched when a row-bearing tab opens, not when the Structure view is
   * looked at: editing needs the primary key and the column types before the
   * user reaches for a cell, and the Structure view wants them anyway.
   */
  columns: ColumnInfo[] | null;
  /** Structure view only, so it stays where it was: fetched on first look. */
  indexes: IndexInfo[] | null;
  /**
   * Diagram tabs only: every relation in the schema and the keys between them,
   * fetched once when the tab opens. Held on the tab rather than in a shared
   * cache so closing the tab is what forgets it.
   */
  graph: SchemaGraph | null;
  /** Which cell the grid, the row panel, and the cell editor all point at. */
  selection: { row: number; col: number } | null;
  /** Source of a view or function, fetched the first time it is looked at. */
  definition: string | null;
  sql: string;
  results: QueryResult[];
  activeResultIndex: number;
  running: boolean;
  error: DbError | null;
  /**
   * Wall-clock round trip measured in the webview: server time plus IPC
   * transfer plus deserialization. The gap between this and the server's own
   * `durationMs` is what a large result set actually costs to move.
   */
  clientMs: number | null;
}
