//! What every driver speaks, and what the frontend receives.
//!
//! Nothing here is Postgres-specific. A type that only one driver can produce
//! belongs in that driver's own module; anything in this file is part of the
//! contract a second driver has to satisfy.

use serde::{Deserialize, Serialize};

/// What a connection saved before drivers existed must be.
fn default_driver() -> String {
    "postgres".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    /// Which driver opens this connection. Matches `Driver::id`.
    ///
    /// Defaulted rather than required: every `connections.json` written before
    /// there was more than one driver has no such field, and a saved connection
    /// that stops loading because the app grew a second database is not a
    /// migration the user should have to notice.
    #[serde(default = "default_driver")]
    pub driver: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    #[serde(default)]
    pub ssl_mode: SslMode,
    /// Free-form label used to tint the UI, e.g. "prod" turns the tab red.
    /// The one guardrail that stops a DELETE landing on the wrong server.
    #[serde(default)]
    pub environment: Option<String>,
    /// The connection this one was derived from by picking a database off its
    /// server, and which owns the credential both of them authenticate with.
    ///
    /// Switching database would otherwise mean copying the password into a
    /// second keystore entry per database, which is one more copy of a secret
    /// for every click. `None` on a connection the user typed themselves.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Set when the database is only reachable from inside another machine's
    /// network. The connection is opened against a local port that forwards
    /// over SSH instead of against `host` directly; `host` and `port` keep
    /// naming the database as the *jump host* sees it, which is what the user
    /// typed and what the tunnel asks for.
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    /// Ask for Touch ID before opening this one.
    ///
    /// On the connection rather than in `security.json` because that is what it
    /// is about, and because a connection is already persisted and already
    /// synced to the frontend. Defaulted, like every other field added after
    /// the first release: a `connections.json` written before this existed
    /// should open, not fail to parse.
    ///
    /// A *derived* connection — one made by picking a database off a server —
    /// carries whatever the sheet last wrote for it, but the gate is asked
    /// against the connection being opened, so switching database on a gated
    /// server prompts once and then rides the grace window.
    #[serde(default)]
    pub require_biometric: bool,
}

/// What the jump host is, and how to prove who we are to it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth: SshAuth,
    /// Private key to authenticate with, when `auth` is `Key`. `~` is expanded
    /// at connect time. Blank means "try the usual identity files", which is
    /// what the user means by leaving it empty.
    #[serde(default)]
    pub key_path: String,
}

fn default_ssh_port() -> u16 {
    22
}

/// Which secret the SSH side of a connection needs.
///
/// The secret itself is never in here: like the database password it lives in
/// the OS keystore and is resolved backend-side.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SshAuth {
    /// A private key, whose passphrase is the stored secret when it has one.
    #[default]
    Key,
    /// A password on the jump host account.
    Password,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: String,
    pub server_version: String,
    pub backend_pid: i32,
    pub current_database: String,
}

/// Display class for a column, derived from its type name.
///
/// Drives alignment and color in the grid. Kept coarse on purpose: the grid
/// needs to know "is this right-aligned and numeric-colored", not the exact OID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TypeClass {
    Number,
    Bool,
    Text,
    Temporal,
    Json,
    Binary,
    Uuid,
    Array,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
    pub type_class: TypeClass,
}

/// One result set. A script with several row-returning statements produces
/// several of these, in execution order.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    /// Row-major. `None` is SQL NULL, which the grid renders differently from
    /// the literal string "NULL" — a distinction most clients get wrong.
    pub rows: Vec<Vec<Option<String>>>,
    /// What the server said it produced, which for a `select` is the true row
    /// count even when `rows` holds fewer. That gap is the whole point of
    /// `truncated`: the footer can say "1,000 of 38,412" honestly.
    pub rows_affected: u64,
    /// Set when the row cap stopped this result short. Never a guess: it means
    /// rows arrived that were deliberately not kept.
    pub truncated: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaEntry {
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableEntry {
    pub name: String,
    pub kind: String,
    pub comment: Option<String>,
}

/// A row count and whether it can be trusted to the digit.
///
/// A planner estimate is free and stale; `count(*)` is exact and walks the
/// table. The UI shows the cheap one with a `~` and lets the user pay for the
/// precise one when they care.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowCount {
    pub value: i64,
    pub exact: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    /// What the server's own describe command would print, not the internal
    /// type name.
    pub data_type: String,
    pub not_null: bool,
    pub default: Option<String>,
    pub primary_key: bool,
    pub comment: Option<String>,
    /// Labels of the column's enum type, in declaration order.
    ///
    /// Empty for every other type, which is the whole test the frontend makes:
    /// a non-empty list is what turns the cell editor into a closed list rather
    /// than a text field. Scalar enums only — an array of enums would need the
    /// editor to compose an array literal, which is a different feature.
    #[serde(default)]
    pub enum_values: Vec<String>,
    /// The column this one points at, when it is a single-column foreign key.
    ///
    /// Single-column only. A composite key would need the caller to carry every
    /// part of it to mean anything, and "go to the row this references" is a
    /// gesture on one value.
    #[serde(default)]
    pub references: Option<ColumnRef>,
}

/// One column of one relation, named well enough to open it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnRef {
    pub schema: String,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    /// The server's own definition, verbatim. Reprinting it in our own words
    /// would only add a way to be wrong.
    pub definition: String,
    pub unique: bool,
    pub primary: bool,
}

/// A routine in a schema.
///
/// Keyed by `oid` rather than name: overloads share a name, and the oid is
/// stable for the life of the session, which is all the frontend needs it for.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionEntry {
    pub oid: i64,
    pub name: String,
    /// Identity arguments, as the server's own describe command would print them.
    pub args: String,
    pub returns: String,
    /// "function" or "procedure".
    pub kind: String,
}

/// One relation as the diagram draws it.
///
/// Deliberately thinner than `ColumnInfo`: a schema graph carries every column
/// of every relation at once, and `default`, `comment`, and `enum_values` are
/// only ever wanted for the one relation the user clicked. Those come back from
/// `list_columns` on demand, which keeps a hundred-table schema from paying for
/// three fields it will not draw.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphColumn {
    pub name: String,
    pub data_type: String,
    pub not_null: bool,
    pub primary_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphTable {
    pub name: String,
    /// Matches `TableEntry::kind`.
    pub kind: String,
    pub comment: Option<String>,
    pub columns: Vec<GraphColumn>,
}

/// One foreign key, as an edge rather than as DDL.
///
/// `columns` and `ref_columns` are positional: the nth referencing column
/// points at the nth referenced one, which is the only thing that makes a
/// composite key readable. `ref_schema` is reported even when it is the schema
/// being drawn, because the caller decides what to do about a reference that
/// leaves it and cannot decide that without being told.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    pub name: String,
    pub table: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

/// Everything one diagram needs, in one reply.
///
/// The shape exists because the alternative is `list_columns` once per
/// relation: eighty tables would be eighty round trips through the session's
/// mutex, serialized behind each other, to draw a single view.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaGraph {
    pub tables: Vec<GraphTable>,
    pub relations: Vec<Relation>,
}

// ---------------------------------------------------------------------------
// Keyspace
//
// What a key-value store has instead of tables. Nothing here is Redis-specific:
// a keyspace is a flat namespace walked by a cursor, which is the shape every
// store of this kind offers because it is the only one that stays cheap on a
// namespace nobody can hold in memory.
// ---------------------------------------------------------------------------

/// One key, as the grid draws it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyEntry {
    pub key: String,
    /// What the store calls this key's type: "string", "hash", "list", "set",
    /// "zset", "stream". Free-form on purpose — the frontend prints it and
    /// decides editability from it, and inventing an enum here would mean
    /// teaching this file every type every future store has.
    pub kind: String,
    /// Seconds left, `-1` for a key that never expires, `None` when the TTL was
    /// not read. `-1` and `None` are different answers and stay tellable apart:
    /// one means "no expiry", the other means "not asked".
    pub ttl: Option<i64>,
    /// Length in the unit its type counts in: bytes for a string, members for
    /// everything else. `None` when the store would not say.
    pub size: Option<i64>,
    /// As much of the value as the scan was willing to read. Truncated by
    /// design: a page of 200 keys must not drag 200 whole values across the
    /// wire to fill a column that is 300px wide.
    pub preview: Option<String>,
}

/// One page of a keyspace walk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyPage {
    pub keys: Vec<KeyEntry>,
    /// Where to resume. Opaque to the caller; `0` is the start and is also what
    /// the store returns once the walk has come all the way round.
    pub cursor: u64,
    /// How many keys were walked to produce this page.
    ///
    /// Not decoration. A filter the store cannot evaluate is applied here after
    /// reading, so a page of 12 can cost a walk of 50,000, and a footer that
    /// says "12 keys" without saying that is claiming a completeness it does
    /// not have.
    pub scanned: u64,
    /// Set when the walk came round to the start, so the caller knows the page
    /// is the last one rather than guessing from a short page. A cursor walk
    /// may return an empty page and still have more to give.
    pub exhausted: bool,
    /// Total keys in the namespace, when the store can say so cheaply.
    pub total: Option<i64>,
}

/// How a keyspace walk is narrowed.
///
/// Two fields because they cost differently and the caller has to be able to
/// tell which one it is paying for. `pattern` is pushed down to the store and
/// is nearly free; `contains` can only be answered by reading every value the
/// walk touches.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFilter {
    /// Glob the store itself matches against key names. `None` means every key.
    #[serde(default)]
    pub pattern: Option<String>,
    /// Text that has to appear in the value. Evaluated after reading, because
    /// no store of this kind can answer it.
    #[serde(default)]
    pub contains: Option<String>,
    /// Whether `contains` ignores case.
    #[serde(default)]
    pub case_sensitive: bool,
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// What the dumped file is written as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportFormat {
    Sql,
    Csv,
}

/// How much of a relation goes into the dump.
///
/// A property of the export, not of each table: offering it per relation is
/// what makes the usual export dialog a checkbox matrix nobody can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportMode {
    /// Definitions only. No `insert` reaches the file.
    Structure,
    /// Rows only. Restores into a schema that already exists.
    Data,
    /// Both, in restore order.
    Full,
}

impl ExportMode {
    pub fn structure(self) -> bool {
        matches!(self, ExportMode::Structure | ExportMode::Full)
    }

    pub fn data(self) -> bool {
        matches!(self, ExportMode::Data | ExportMode::Full)
    }
}

/// Whether the export lands as one file or one file per relation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportLayout {
    Single,
    PerTable,
}

/// One relation the user asked for, as the sidebar knows it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    pub schema: String,
    pub name: String,
    /// Matches `TableEntry::kind`. Only `table` carries rows worth dumping: a
    /// view's rows belong to its query, and a matview's come back with
    /// `refresh`.
    pub kind: String,
}

impl ObjectRef {
    /// Whether rows of this relation are data in their own right.
    pub fn has_own_rows(&self) -> bool {
        self.kind == "table" || self.kind == "foreign" || self.kind == "other"
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub objects: Vec<ObjectRef>,
    pub format: ExportFormat,
    pub mode: ExportMode,
    /// Whether each relation is preceded by a `drop ... if exists`, which is
    /// what makes a dump re-runnable against a database that already has it.
    pub drop_if_exists: bool,
    pub layout: ExportLayout,
    pub compress: bool,
    /// Whether the dump is written so it can be restored more than once.
    ///
    /// Every statement becomes guarded — `if not exists`, `drop constraint if
    /// exists` before each `add`, rows upserted rather than inserted — and the
    /// whole file runs in one transaction. The point is the restore, not the
    /// export: a dump that only loads into an empty database is a dump that
    /// fails on the day it is actually needed.
    #[serde(default)]
    pub safe: bool,
    /// Chosen through the native folder picker, so it is a real path.
    pub directory: String,
    /// Without an extension. The backend appends one, because a name typed
    /// with `.sql` already on it is how a file ends up called `x.sql.sql.gz`.
    pub file_name: String,
}

/// What an export produced, for the sentence shown when it finishes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub path: String,
    pub bytes: u64,
    pub tables: usize,
    pub rows: u64,
    pub duration_ms: u64,
}

/// What one pass over the relations wrote.
#[derive(Debug, Clone, Copy, Default)]
pub struct DumpStats {
    pub rows: u64,
    pub tables: usize,
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// What running a `.sql` file against this connection should do beyond running
/// it.
///
/// Every field is a switch in the dialog, and every one of them exists because
/// a dump written by another tool against another server fails without it. The
/// defaults are all `true`: the file is being moved between servers, which is
/// the only reason anyone opens this dialog.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    /// Chosen through the native picker or dropped on the window, so it is a
    /// real path. The backend reads it; the webview never holds the file.
    pub path: String,
    /// Whether foreign keys are checked once at the end rather than row by row.
    ///
    /// The whole reason a dump written table by table fails on another server:
    /// a child row reaches the server before its parent, and the key refuses it
    /// even though the file, read to the end, is consistent.
    #[serde(default)]
    pub hold_foreign_keys: bool,
    /// Whether `OWNER TO`, `GRANT`, `REVOKE` and role statements are skipped.
    /// They name roles that exist on the server the dump came from.
    #[serde(default)]
    pub skip_ownership: bool,
    /// Whether rows of the ORM's own migration table are skipped. The table is
    /// still created; only its rows are left to this database.
    #[serde(default)]
    pub skip_migration_history: bool,
    /// Whether every identity and `serial` sequence is moved past the highest
    /// value imported once the file has run.
    #[serde(default)]
    pub reset_sequences: bool,
    /// What the preflight read off the file: "Prisma", "Drizzle", "TypeORM",
    /// or nothing. It decides which table `skip_migration_history` means, and
    /// it is sent back rather than worked out twice so the dialog and the
    /// import can never disagree about which table that is.
    #[serde(default)]
    pub orm: Option<String>,
    /// What the preflight counted, used as the denominator for progress. Zero
    /// means the dialog did not run one, and progress reports statements
    /// without a total rather than inventing one.
    #[serde(default)]
    pub total_statements: usize,
}

/// What an import did, for the sentence shown when it finishes.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub statements: usize,
    pub skipped: usize,
    pub rows: u64,
    pub sequences_reset: usize,
    /// How the foreign keys were actually held, or `None` if they were not.
    ///
    /// Two mechanisms can deliver what the switch asked for and the server
    /// decides which one is available. Reporting the outcome as if only one
    /// existed would be a claim rather than a measurement.
    pub key_hold: Option<String>,
    pub duration_ms: u64,
}

/// What is in a file, read without touching the database.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreflight {
    /// Size on disk. The compressed size when the file is gzipped, because
    /// that is the number the file manager shows.
    pub bytes: u64,
    pub compressed: bool,
    pub statements: usize,
    /// `[("insert", 1204), ("create", 38)]`, in descending order.
    pub by_kind: Vec<(String, usize)>,
    /// Schema-qualified, in the order the file names them, with how many
    /// statements each carries. File order is the information: it is the order
    /// that was going to fail.
    ///
    /// Capped, so a file naming eight hundred relations does not become a list
    /// nobody reads. `table_count` is the real number, and the dialog says so
    /// rather than letting a truncated list look complete.
    pub tables: Vec<(String, usize)>,
    /// How many distinct relations the file names, whether or not they all fit
    /// in `tables`.
    pub table_count: usize,
    pub schemas: Vec<String>,
    pub uses_copy: bool,
    /// "Prisma", "Drizzle" or "TypeORM", read off the bookkeeping table the
    /// tool writes into its own schema.
    pub orm: Option<String>,
    pub ownership_statements: usize,
    pub migration_rows: usize,
    /// Set when the file could not be read to the end, with the line it
    /// stopped on. The dialog shows it and refuses to run.
    pub parse_error: Option<String>,
}

/// What one import applied, before the command turns it into a summary.
#[derive(Debug, Clone, Default)]
pub struct ImportStats {
    pub statements: usize,
    pub skipped: usize,
    pub rows: u64,
    pub sequences_reset: usize,
    pub key_hold: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every connection saved before there was more than one driver has no
    /// `driver` field. If this stops defaulting, the app opens with an empty
    /// sidebar and the user's saved connections look deleted.
    #[test]
    fn reads_a_connection_saved_before_drivers_existed() {
        let json = r#"{
            "id": "abc",
            "name": "local",
            "host": "localhost",
            "port": 5432,
            "user": "postgres",
            "database": "shop",
            "sslMode": "prefer",
            "environment": "local",
            "parentId": null
        }"#;
        let config: ConnectionConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.driver, "postgres");
        assert_eq!(config.database, "shop");
        // And nothing about it claims to be tunnelled.
        assert!(config.ssh.is_none());
        // Nor gated. A connection saved before Touch ID existed must open the
        // way it always did — a default that came out true would lock every
        // stored connection behind a prompt nobody asked for.
        assert!(!config.require_biometric);
    }

    /// The tunnel travels as camelCase like everything else on the wire, and a
    /// jump host saved without a port still has one. A `port: 0` here would
    /// send the tunnel at the wrong service with no error to explain it.
    #[test]
    fn reads_an_ssh_tunnel_off_the_wire() {
        let json = r#"{
            "id": "abc",
            "name": "prod",
            "host": "10.0.0.5",
            "port": 5432,
            "user": "app",
            "database": "shop",
            "ssh": { "host": "bastion.example.com", "user": "deploy", "auth": "key",
                     "keyPath": "~/.ssh/id_ed25519" }
        }"#;
        let config: ConnectionConfig = serde_json::from_str(json).unwrap();
        let ssh = config.ssh.expect("tunnel");
        assert_eq!(ssh.port, 22);
        assert_eq!(ssh.auth, SshAuth::Key);
        assert_eq!(ssh.key_path, "~/.ssh/id_ed25519");
    }

    /// And a file written after the field exists keeps what it says, rather
    /// than being quietly reset to the default on every read.
    #[test]
    fn keeps_the_driver_a_saved_connection_names() {
        let json = r#"{
            "id": "abc",
            "driver": "mysql",
            "name": "local",
            "host": "localhost",
            "port": 3306,
            "user": "root",
            "database": "shop"
        }"#;
        let config: ConnectionConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.driver, "mysql");
        // The optional fields fall back without needing to be written out.
        assert!(config.environment.is_none());
        assert!(config.parent_id.is_none());
    }

    /// The diagram reads these field names straight off the wire. A snake_case
    /// key here is not a compile error on either side: the frontend simply sees
    /// `undefined` and draws a graph with no types and no edges.
    #[test]
    fn sends_the_schema_graph_in_the_case_the_frontend_reads() {
        let graph = SchemaGraph {
            tables: vec![GraphTable {
                name: "orders".into(),
                kind: "table".into(),
                comment: None,
                columns: vec![GraphColumn {
                    name: "id".into(),
                    data_type: "uuid".into(),
                    not_null: true,
                    primary_key: true,
                }],
            }],
            relations: vec![Relation {
                name: "orders_user_id_fkey".into(),
                table: "orders".into(),
                columns: vec!["user_id".into()],
                ref_schema: "public".into(),
                ref_table: "users".into(),
                ref_columns: vec!["id".into()],
            }],
        };

        let json = serde_json::to_value(&graph).unwrap();
        let column = &json["tables"][0]["columns"][0];
        assert_eq!(column["dataType"], "uuid");
        assert_eq!(column["notNull"], true);
        assert_eq!(column["primaryKey"], true);

        let relation = &json["relations"][0];
        assert_eq!(relation["refSchema"], "public");
        assert_eq!(relation["refTable"], "users");
        assert_eq!(relation["refColumns"][0], "id");
    }

    /// Same failure mode as the schema graph, one feature over: the grid reads
    /// these names straight off the wire, and a snake_case key is not a compile
    /// error on either side. It is a column of `undefined`.
    #[test]
    fn sends_a_key_page_in_the_case_the_grid_reads() {
        let page = KeyPage {
            keys: vec![KeyEntry {
                key: "nvp:na:session:1".into(),
                kind: "hash".into(),
                ttl: Some(-1),
                size: Some(4),
                preview: Some("{\"name\":\"dwi\"}".into()),
            }],
            cursor: 4096,
            scanned: 50_000,
            exhausted: false,
            total: Some(1_204_882),
        };

        let json = serde_json::to_value(&page).unwrap();
        assert_eq!(json["cursor"], 4096);
        assert_eq!(json["scanned"], 50_000);
        assert_eq!(json["exhausted"], false);
        assert_eq!(json["total"], 1_204_882);
        assert_eq!(json["keys"][0]["key"], "nvp:na:session:1");
        assert_eq!(json["keys"][0]["ttl"], -1);
    }

    /// A filter with nothing in it is what the frontend sends when the bar is
    /// empty. If that stopped deserializing, opening a keyspace would fail
    /// before it drew a single row.
    #[test]
    fn reads_an_empty_key_filter() {
        let filter: KeyFilter = serde_json::from_str("{}").unwrap();
        assert!(filter.pattern.is_none());
        assert!(filter.contains.is_none());

        // And a populated one keeps the glob exactly as typed: `nvp:na:*` is a
        // pattern the user wrote, not one to normalise.
        let filter: KeyFilter =
            serde_json::from_str(r#"{"pattern":"nvp:na:*","contains":"dwi"}"#).unwrap();
        assert_eq!(filter.pattern.as_deref(), Some("nvp:na:*"));
        assert_eq!(filter.contains.as_deref(), Some("dwi"));
    }
}
