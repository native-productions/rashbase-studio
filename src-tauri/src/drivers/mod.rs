//! Database drivers, and the seam they sit behind.
//!
//! Two traits, because a connection is made by something that does not have one
//! yet: `Driver` is the factory and knows what its kind of server can do,
//! `Session` is one open connection and everything run over it.
//!
//! Every catalogue method on `Session` has a default that refuses. That is what
//! lets a driver land useful before it is complete, and what makes a key-value
//! store expressible at all: Redis has no schemas and never will, and a trait
//! that demanded one would be a trait shaped only for Postgres wearing a
//! different name. `Capabilities` is how a driver says which of them it means
//! to answer, so a refusal is something the caller can see coming rather than
//! an error it discovers by asking.

pub mod postgres;
pub mod redis;
pub mod registry;
pub mod types;

use async_trait::async_trait;
use serde::Serialize;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub use registry::DbState;
pub use types::*;

use crate::error::{Error, Result};

/// What a driver's sessions are able to answer.
///
/// Not yet exposed over IPC: with one driver the frontend can assume all of it,
/// and a command with no consumer is a guess about what the second driver will
/// need. It is here because the trait's refusing defaults are only honest if
/// something can be asked first.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub schemas: bool,
    pub views: bool,
    pub functions: bool,
    pub indexes: bool,
    /// Whether a single row can be identified well enough to write one cell.
    pub row_edit: bool,
    /// Whether a running statement can be stopped from outside it.
    pub cancel: bool,
    /// Whether relations can be dumped to a file.
    pub export: bool,
    /// Whether a file of statements can be run back into the database.
    pub import: bool,
    /// Whether this driver has a flat key namespace to walk instead of tables.
    /// True and `schemas` false is what a key-value store looks like from here.
    pub keyspace: bool,
}

/// Where a dump's bytes go, and how it says which relation it is on.
///
/// A trait rather than a writer, because the two output layouts differ only in
/// what `begin` does: one file ignores it, one file per relation closes the
/// previous file and opens the next. That difference belongs to the command
/// layer, which owns the filesystem — the driver only knows what a dump of
/// these relations should say.
pub trait DumpWriter: Send {
    /// Starts the part named for one relation.
    ///
    /// Called once per relation in the per-relation layout and never in the
    /// single-file one, so a driver may call it unconditionally.
    fn begin(&mut self, name: &str) -> std::io::Result<()>;

    fn write(&mut self, bytes: &[u8]) -> std::io::Result<()>;

    /// Reports which relation is being written and how far along the set is.
    /// Advisory: a writer that shows nothing may ignore it.
    fn progress(&mut self, table: &str, done: usize, total: usize);
}

/// How an import says where it has got to.
///
/// Statements rather than rows, and bytes alongside them, because those are the
/// two numbers the user can hold against something they already know: the count
/// the preflight showed them, and the size of the file on disk. Advisory, like
/// `DumpWriter::progress` — a window that has gone away is not a reason to fail
/// an import that is otherwise applying fine.
pub trait ImportProgress: Send {
    fn tick(&mut self, statements: usize, bytes: u64, table: &str);
}

/// A kind of database. One value per supported server, held in the registry.
#[async_trait]
pub trait Driver: Send + Sync {
    /// Matches `ConnectionConfig::driver`. Stable: it is written into
    /// `connections.json` and has to keep meaning the same thing.
    fn id(&self) -> &'static str;

    /// The port to offer when the user has not typed one.
    fn default_port(&self) -> u16;

    fn capabilities(&self) -> Capabilities;

    async fn connect(
        &self,
        config: &ConnectionConfig,
        password: Option<&str>,
    ) -> Result<Arc<dyn Session>>;
}

/// One open connection.
///
/// Methods take `&self` because sessions are shared: the store holds one behind
/// an `Arc` while a query is in flight over it. Interior mutability, and how
/// much of it a statement needs, is the driver's own business.
#[async_trait]
pub trait Session: Send + Sync {
    fn info(&self) -> &ConnectionInfo;

    /// The concrete session, for features that belong to one driver's
    /// ecosystem rather than to databases in general.
    ///
    /// One escape hatch instead of a method per such feature. BullMQ is the
    /// case it exists for: it is a key layout one Node library writes into
    /// Redis, and putting `retry_jobs` on the trait every driver implements
    /// would leave Postgres carrying a method about a JavaScript queue for as
    /// long as the trait lives. The catalogue methods above are different in
    /// kind — every one of them names something databases have.
    fn as_any(&self) -> &(dyn std::any::Any + Send + Sync);

    /// Runs the statement exactly as given.
    ///
    /// `max_rows` caps how many rows of each result set are *kept*, not how
    /// many the server produces: the statement is never rewritten to add a
    /// limit, because a client that quietly edits the SQL a person typed is
    /// lying about what it ran. Rows past the cap are read and dropped, which
    /// is what keeps a 38k-row `select *` from being built into strings,
    /// serialized, and pushed through IPC.
    async fn execute(&self, sql: &str, max_rows: Option<usize>) -> Result<Vec<QueryResult>>;

    /// Releases the connection. Best effort by contract: the caller has already
    /// dropped the session from its map, so there is nothing left to retry.
    async fn close(&self) -> Result<()>;

    async fn cancel(&self) -> Result<()> {
        Err(Error::Unsupported("cancelling a running statement"))
    }

    /// Writes the relations named by `req` into `out`.
    ///
    /// Runs on a connection of the driver's own, never the session's: a dump of
    /// a large table takes minutes, and holding the session for that long would
    /// wedge every tab pointed at the same connection.
    ///
    /// `cancel` is polled while rows stream. A driver that observes it set must
    /// stop and return `Error::Cancelled` rather than finish quietly, because
    /// the caller deletes what was written.
    async fn dump(
        &self,
        _req: &ExportRequest,
        _out: &mut dyn DumpWriter,
        _cancel: &AtomicBool,
    ) -> Result<DumpStats> {
        Err(Error::Unsupported("exporting"))
    }

    /// Runs a file of statements against this session's own connection.
    ///
    /// The session's connection and not a fresh one, for the reason
    /// `PgSession` gives: the transaction, the deferral and every `SET` the
    /// file carries have to survive from one statement to the next, and a pool
    /// would hand out a different backend halfway through.
    ///
    /// `cancel` is polled between statements. A driver that observes it set
    /// must roll back and return `Error::Cancelled`: a half-applied file is the
    /// outcome this whole path exists to rule out.
    async fn import(
        &self,
        _req: &ImportRequest,
        _cancel: &AtomicBool,
        _progress: &mut dyn ImportProgress,
    ) -> Result<ImportStats> {
        Err(Error::Unsupported("importing"))
    }

    async fn update_cell(
        &self,
        _schema: &str,
        _table: &str,
        _column: &str,
        _value: Option<&str>,
        _keys: &[(String, String)],
    ) -> Result<Option<String>> {
        Err(Error::Unsupported("editing a cell"))
    }

    /// Removes whole rows, each identified by the table's own primary key.
    ///
    /// Every key travels as a bound parameter, and which columns may appear in
    /// the `where` clause is decided from the catalogue, not by the caller —
    /// the same rule `update_cell` follows, for the same reason: the frontend
    /// says which rows it means, never how they are found.
    ///
    /// All of them or none. A row that no longer matches is the case this
    /// exists to catch, and reporting it after half the set is already gone
    /// would leave the user with no way to tell which half.
    async fn delete_rows(
        &self,
        _schema: &str,
        _table: &str,
        _rows: &[Vec<(String, String)>],
    ) -> Result<u64> {
        Err(Error::Unsupported("deleting rows"))
    }

    // -- Catalogue ----------------------------------------------------------

    async fn list_databases(&self) -> Result<Vec<String>> {
        Err(Error::Unsupported("listing databases"))
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaEntry>> {
        Err(Error::Unsupported("listing schemas"))
    }

    async fn list_tables(&self, _schema: &str) -> Result<Vec<TableEntry>> {
        Err(Error::Unsupported("listing tables"))
    }

    async fn list_columns(&self, _schema: &str, _table: &str) -> Result<Vec<ColumnInfo>> {
        Err(Error::Unsupported("listing columns"))
    }

    async fn list_indexes(&self, _schema: &str, _table: &str) -> Result<Vec<IndexInfo>> {
        Err(Error::Unsupported("listing indexes"))
    }

    /// Every relation in the schema with its columns, plus the foreign keys
    /// between them, in one call.
    ///
    /// Its own method rather than a loop over `list_columns` in the caller: the
    /// caller cannot batch what it asks for one relation at a time, and a
    /// driver that can answer this in a single statement should be allowed to.
    async fn schema_graph(&self, _schema: &str) -> Result<SchemaGraph> {
        Err(Error::Unsupported("reading a schema diagram"))
    }

    async fn list_functions(&self, _schema: &str) -> Result<Vec<FunctionEntry>> {
        Err(Error::Unsupported("listing functions"))
    }

    async fn estimate_rows(&self, _schema: &str, _table: &str) -> Result<RowCount> {
        Err(Error::Unsupported("estimating row count"))
    }

    async fn count_rows(&self, _schema: &str, _table: &str) -> Result<RowCount> {
        Err(Error::Unsupported("counting rows"))
    }

    async fn function_definition(&self, _oid: i64) -> Result<String> {
        Err(Error::Unsupported("reading a function definition"))
    }

    async fn view_definition(&self, _schema: &str, _name: &str) -> Result<String> {
        Err(Error::Unsupported("reading a view definition"))
    }

    // -- Keyspace -----------------------------------------------------------

    /// One page of a walk over a flat key namespace.
    ///
    /// Cursor-based rather than offset-based because that is the only paging a
    /// store of this kind can offer honestly: keys move between pages as the
    /// namespace changes under the walk, and an offset would silently skip and
    /// repeat rows. `cursor` of `0` starts a walk; the page says where to
    /// resume and whether the walk came round.
    ///
    /// `limit` caps the keys *returned*, not the keys walked. A filter the
    /// store cannot push down is applied after reading, so the page reports
    /// what the walk actually cost.
    async fn list_keys(&self, _filter: &KeyFilter, _cursor: u64, _limit: usize) -> Result<KeyPage> {
        Err(Error::Unsupported("browsing a keyspace"))
    }

    /// Removes keys by name, and reports how many existed.
    ///
    /// Typed rather than composed into a statement by the caller, for the same
    /// reason `update_cell` is: a key is arbitrary bytes, and a key holding a
    /// space or a quote would break any command built by pasting names
    /// together.
    async fn delete_keys(&self, _keys: &[String]) -> Result<u64> {
        Err(Error::Unsupported("deleting keys"))
    }
}
