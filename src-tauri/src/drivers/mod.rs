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
pub mod registry;
pub mod types;

use async_trait::async_trait;
use serde::Serialize;
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
}
