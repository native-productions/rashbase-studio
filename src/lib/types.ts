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
  /**
   * Ask for Touch ID before opening this one.
   *
   * Enforced backend-side, in front of the keystore read, so this field is
   * what the Settings sheet edits rather than what decides anything: a
   * frontend that ignored it would still meet the prompt.
   */
  requireBiometric: boolean;
}

/**
 * The app-wide half of the Touch ID policy. Its per-connection half is
 * `ConnectionConfig.requireBiometric`.
 */
export interface SecurityPolicy {
  lockOnLaunch: boolean;
  requireForAllConnections: boolean;
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
  /**
   * The column this one points at, when it is a single-column foreign key.
   *
   * Single-column only: "go to the row this references" is a gesture on one
   * value, and half of a composite key names nothing. Absent rather than
   * partial for those.
   */
  references: ColumnRef | null;
}

/** One column of one relation, named well enough to open it. */
export interface ColumnRef {
  schema: string;
  table: string;
  column: string;
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
  /**
   * Where the failure was, in this application's words rather than the
   * server's: so far only an import, which reports the line of the file and
   * the statement that was on it.
   *
   * Its own field so `message`, `detail` and `hint` stay purely what the
   * database said. Absent on every other command.
   */
  context?: string | null;
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
// Import
// ---------------------------------------------------------------------------

/** What the ORM detector found, and the only values `orm` ever takes. */
export type Orm = "Prisma" | "Drizzle" | "TypeORM";

/**
 * What a file holds, read without touching the database.
 *
 * Every number here is counted off the file itself, so what the dialog shows
 * before anything runs cannot disagree with what runs.
 */
export interface ImportPreflight {
  /** Size on disk: the compressed size when the file is gzipped. */
  bytes: number;
  compressed: boolean;
  statements: number;
  /** `[["insert", 1204], ["create", 38]]`, commonest first. */
  byKind: [string, number][];
  /**
   * Schema-qualified, in the order the file names them, with how many
   * statements each carries. File order, never sorted: it is the order that
   * was going to fail.
   */
  tables: [string, number][];
  /**
   * How many distinct relations the file names. Larger than `tables.length`
   * when the list was capped, which is why both are here: a truncated list
   * that looked complete would be the dialog lying about the file.
   */
  tableCount: number;
  schemas: string[];
  /** Whether any of the data arrives as `COPY … FROM stdin` rather than rows. */
  usesCopy: boolean;
  orm: Orm | null;
  /** `OWNER TO`, `GRANT`, `REVOKE` and role statements. */
  ownershipStatements: number;
  /** Rows destined for the ORM's own migration table. */
  migrationRows: number;
  /** Set when the file could not be read to the end, naming the line. */
  parseError: string | null;
}

export interface ImportRequest {
  path: string;
  /** Foreign keys checked once at the end rather than row by row. */
  holdForeignKeys: boolean;
  /** Skip statements naming a role that exists on the other server. */
  skipOwnership: boolean;
  /** Skip the ORM's migration rows. The table itself is still created. */
  skipMigrationHistory: boolean;
  /** Move every identity sequence past the highest value imported. */
  resetSequences: boolean;
  /** From the preflight, so the dialog and the import agree on the ORM. */
  orm: Orm | null;
  /** From the preflight, as the denominator for progress. */
  totalStatements: number;
}

export interface ImportSummary {
  statements: number;
  skipped: number;
  rows: number;
  sequencesReset: number;
  /**
   * How the keys were actually held: `session_replication_role` where the
   * server allowed it, `deferred` where it did not, `null` when it was not
   * asked for. Reported rather than assumed — the server decides.
   */
  keyHold: string | null;
  durationMs: number;
}

/** One `import://progress` event. */
export interface ImportProgress {
  jobId: string;
  statements: number;
  /** What the preflight counted. Zero when it did not run. */
  total: number;
  /** Uncompressed bytes read so far. */
  bytes: number;
  table: string;
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
  /**
   * `"queue"` is the third use of the same trick: a BullMQ queue's tab is an
   * object tab whose object is the queue, with `schema` and `name` both the
   * queue's own name. Which state is being looked at lives on the tab rather
   * than in the object, so opening a queue twice from two different states is
   * still one tab.
   */
  kind: TableEntry["kind"] | "function" | "diagram" | "keyspace" | "queue";
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
   * Rows picked out but not yet marked for anything, by the same identity
   * `staged` uses.
   *
   * Separate from `staged` because they are different statements: picked means
   * "these are the rows I mean", staged means "these are going". Delete turns
   * one into the other, which is what makes a bulk delete the same gesture as a
   * single one rather than a second feature.
   *
   * Separate from `selection` because that is the cell cursor — one cell, which
   * is what the editor and the row panel act on. This is a set of whole rows.
   */
  selectedRows: string[];
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
  /**
   * Queue tabs only: the counts, the measured rates, and the tail of the event
   * stream the trace is drawn from. Held on the tab rather than in a shared
   * cache so closing the tab is what forgets it, exactly like `graph`.
   */
  queue: QueueView | null;
  /** Which cell the grid, the row panel, and the cell editor all point at. */
  selection: { row: number; col: number } | null;
  /** Source of a view or function, fetched the first time it is looked at. */
  definition: string | null;
  /**
   * The saved query this tab is showing, when it came from one.
   *
   * What makes ⌘S mean "update this" rather than "keep another copy of it".
   * The link survives editing on purpose — a statement being changed is still
   * the statement you opened — so the difference between saved and edited is
   * `sql` against the saved copy, not the presence of the link.
   *
   * Not persisted with the pin. A saved query can be deleted between launches,
   * and a pinned tab claiming to be one that no longer exists would offer to
   * update nothing.
   */
  savedQueryId: string | null;
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

// ---------------------------------------------------------------------------
// BullMQ
//
// Redis-only. BullMQ is a key layout one Node library writes, so nothing here
// is part of the contract a driver has to satisfy — it is what the Redis
// driver's `bull` module sends when it is asked about queues.
// ---------------------------------------------------------------------------

/** One queue, and how much is sitting in each of its states. */
export interface QueueEntry {
  name: string;
  /** Keyed by the state key: `wait`, `active`, `delayed`, `prioritized`,
   *  `waiting-children`, `completed`, `failed`. Exact, from LLEN and ZCARD. */
  counts: Record<string, number>;
  /** `paused` on the queue's meta hash. A queue-level fact, not a state. */
  paused: boolean;
  /** Non-zero only against BullMQ v4 and earlier, where pausing moved jobs
   *  into their own list. Retry refuses on such a queue. */
  legacyPaused: number;
}

export interface QueuePage {
  queues: QueueEntry[];
  cursor: number;
  /** Keys the discovery walk touched, which is what it cost. */
  scanned: number;
  exhausted: boolean;
}

/** One job, as its hash holds it. */
export interface JobEntry {
  id: string;
  /**
   * The hash verbatim. Not narrowed to named fields because the set moves
   * between BullMQ versions — `atm` became `attemptsMade`, `ats` arrived later
   * — and a fixed shape would silently drop whatever it did not know about.
   */
  fields: Record<string, string>;
  /** The sorted-set score, where the state has one. Meaning is per state:
   *  `delayed` packs the ready-at timestamp, `completed` and `failed` hold the
   *  finish time outright. */
  score: number | null;
}

export interface JobPage {
  jobs: JobEntry[];
  /** Everything in the state, not just this page. */
  total: number;
  /** Which end of the queue this page came from. `wait` is popped from its
   *  tail, so its page is not in list order and the footer has to say so. */
  order: "next-first" | "recent-first";
}

/** One entry off a queue's event stream. */
export interface QueueEvent {
  /** `<ms>-<seq>`. Doubles as the resume point and as the event's timestamp. */
  id: string;
  fields: Record<string, string>;
}

export interface EventPage {
  events: QueueEvent[];
  lastId: string;
  /**
   * The server's own clock in milliseconds, at the moment of the read.
   *
   * Stream ids are stamped by the server, and a rate is events divided by how
   * long ago they were. Dividing by the client's clock makes the rate wrong by
   * however far the two machines have drifted, which on a laptop talking to a
   * production replica is not hypothetical.
   */
  serverNow: number;
  /** Set when the stream was trimmed past the resume point, so transitions
   *  happened that this page cannot account for. Rates derived from a gapped
   *  window are wrong, and this is what stops them being shown as a number. */
  trimmed: boolean;
}

/** What one job's retry did. BullMQ's own codes, not collapsed to a boolean. */
export interface RetryOutcome {
  jobId: string;
  /** `1` moved it, `-1` the job is gone, `-3` it was not in that state. */
  code: number;
}

export interface RetryRequest {
  prefix: string;
  queue: string;
  /** `failed` or `completed`. Nothing else has a finished set to move out of. */
  state: string;
  jobIds: string[];
  resetAttemptsMade: boolean;
}

/** Everything a queue tab holds that a table tab has no use for. */
export interface QueueView {
  /** What the application prefixes its keys with. `bull` unless told otherwise. */
  prefix: string;
  counts: Record<string, number>;
  paused: boolean;
  legacyPaused: number;
  /** Which state's jobs are in `results`. Null means no state is open. */
  state: string | null;
  /**
   * The same page of jobs as `results` holds, unformatted.
   *
   * Kept alongside rather than derived back out of the grid, because the trace
   * needs the fields the grid has no column for — `stacktrace`, `parentKey`,
   * the raw timestamps — and reading them back off formatted cells would mean
   * parsing "1.50s" into milliseconds again.
   */
  jobs: JobEntry[];
  /** Which end of the queue `jobs` came from, for the footer to state. */
  order: JobPage["order"];
  /**
   * Where the event stream stood when `jobs` was read.
   *
   * A resume point rather than a timestamp, so "what has happened since" is an
   * exact answer with no clock in it: the events after this id are precisely
   * the ones the page on screen does not account for.
   */
  readAtEventId: string;
  /** Everything in the open state, which is more than this page. */
  total: number;
  /**
   * Transitions per second, keyed by edge id.
   *
   * `null` rather than an empty map when the event stream was trimmed past the
   * resume point: a rate computed from a gapped window is wrong, and drawing a
   * zero would claim the queue is idle when it may be the busiest it has been.
   */
  rates: Record<string, number> | null;
  /** Resume point for the next poll of the event stream. */
  lastEventId: string;
  /** The recent tail, newest last. What a single job's timeline is read from. */
  events: QueueEvent[];
  /** Whether the tab is polling. Paused by the user, or by losing focus. */
  live: boolean;
}
