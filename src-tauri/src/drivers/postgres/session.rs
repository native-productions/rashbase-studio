//! One Postgres session: a dedicated connection and everything run over it.
//!
//! # Why one connection per session, not a pool
//!
//! A database client is session-oriented. `SET`, `BEGIN`, temp tables, and
//! `search_path` must survive between statements the user runs in the same tab.
//! A pool would hand out a different backend each time and silently break all
//! of that. One dedicated `PgConnection` per connection id is both simpler and
//! more correct here.

use std::sync::atomic::AtomicBool;

use async_trait::async_trait;
use futures::StreamExt;
use sqlx::postgres::{PgConnectOptions, PgConnection};
use sqlx::{Column, Connection, Either, Row, TypeInfo};
use tokio::sync::Mutex;

use crate::drivers::postgres::catalog;
use crate::drivers::postgres::dump;
use crate::drivers::postgres::sql::build_update;
use crate::drivers::postgres::types::classify;
use crate::drivers::types::{
    ColumnInfo, ColumnMeta, ConnectionInfo, DumpStats, ExportRequest, FunctionEntry, IndexInfo,
    QueryResult, RowCount, SchemaEntry, TableEntry,
};
use crate::drivers::{DumpWriter, Session};
use crate::error::{Error, Result};

pub struct PgSession {
    /// `None` once the session has been closed. Closing has to work through a
    /// shared reference — the session lives behind an `Arc` that in-flight
    /// queries also hold — so the connection is taken out of the option rather
    /// than moved out of the session.
    conn: Mutex<Option<PgConnection>>,
    /// Kept so `cancel` can open a second connection to the same server. The
    /// first one is blocked inside the query it is being asked to cancel.
    options: PgConnectOptions,
    info: ConnectionInfo,
}

impl PgSession {
    pub(super) fn new(conn: PgConnection, options: PgConnectOptions, info: ConnectionInfo) -> Self {
        Self {
            conn: Mutex::new(Some(conn)),
            options,
            info,
        }
    }

    /// The live connection, or a refusal naming the session that no longer has
    /// one. Reached only by a query that was already in flight when the user
    /// disconnected.
    fn live<'a>(&self, guard: &'a mut Option<PgConnection>) -> Result<&'a mut PgConnection> {
        guard
            .as_mut()
            .ok_or_else(|| Error::UnknownConnection(self.info.id.clone()))
    }
}

#[async_trait]
impl Session for PgSession {
    fn info(&self) -> &ConnectionInfo {
        &self.info
    }

    async fn close(&self) -> Result<()> {
        // Best effort. If the graceful terminate fails the socket still closes
        // when the connection drops, and there is nothing left to tell the user.
        if let Some(conn) = self.conn.lock().await.take() {
            let _ = conn.close().await;
        }
        Ok(())
    }

    /// Runs user-authored SQL over the **simple query protocol**.
    ///
    /// Two properties make this the right path for a client:
    /// multi-statement scripts and session commands (`SET`, `BEGIN`) work
    /// as typed, and Postgres returns every value in *text* format. That
    /// second property is what makes generic decoding tractable: arrays,
    /// enums, jsonb, ranges, and user-defined types all arrive as strings,
    /// so there is no per-OID decode table to maintain.
    ///
    /// Never used for generated writes. See `update_cell`, which binds
    /// parameters over the extended protocol instead.
    async fn execute(&self, sql: &str, max_rows: Option<usize>) -> Result<Vec<QueryResult>> {
        let mut guard = self.conn.lock().await;
        let conn = self.live(&mut guard)?;

        let started = std::time::Instant::now();
        let mut results: Vec<QueryResult> = Vec::new();
        let mut current: Option<QueryResult> = None;
        let mut pending_affected: u64 = 0;

        {
            let mut stream = sqlx::raw_sql(sql).fetch_many(&mut *conn);
            while let Some(item) = stream.next().await {
                match item? {
                    // End of one statement.
                    Either::Left(done) => {
                        let elapsed = started.elapsed().as_millis() as u64;
                        match current.take() {
                            Some(mut r) => {
                                r.rows_affected = done.rows_affected();
                                r.duration_ms = elapsed;
                                results.push(r);
                            }
                            // A statement that returned no rows at all
                            // (INSERT/UPDATE/SET). Carry the count so the
                            // status bar can report it.
                            None => pending_affected += done.rows_affected(),
                        }
                    }
                    Either::Right(row) => {
                        let r = current.get_or_insert_with(|| QueryResult {
                            columns: row
                                .columns()
                                .iter()
                                .map(|c| {
                                    let type_name = c.type_info().name().to_string();
                                    ColumnMeta {
                                        name: c.name().to_string(),
                                        type_class: classify(&type_name),
                                        type_name,
                                    }
                                })
                                .collect(),
                            rows: Vec::new(),
                            rows_affected: 0,
                            truncated: false,
                            duration_ms: 0,
                        });

                        // Past the cap the row is still read off the socket —
                        // the stream has to reach CommandComplete for the
                        // connection to be usable again, and that tag is where
                        // the true row count comes from — but nothing is
                        // allocated for it.
                        if max_rows.is_some_and(|max| r.rows.len() >= max) {
                            r.truncated = true;
                            continue;
                        }

                        let mut values = Vec::with_capacity(r.columns.len());
                        for i in 0..r.columns.len() {
                            // `_unchecked` skips sqlx's compile-time-ish type
                            // compatibility check. Under the simple protocol
                            // every value is already text, so decoding to
                            // String is just a UTF-8 read regardless of OID.
                            values.push(row.try_get_unchecked::<Option<String>, _>(i)?);
                        }
                        r.rows.push(values);
                    }
                }
            }
        }

        if let Some(mut r) = current.take() {
            r.duration_ms = started.elapsed().as_millis() as u64;
            results.push(r);
        }

        if results.is_empty() {
            // A select over an empty table streams no rows, so the loop above
            // never saw a row description and the grid would have nothing to
            // draw. Ask the server what the statement *would* return: an empty
            // table still shows its columns, like a full one does.
            let columns = if pending_affected == 0 {
                describe_columns(conn, sql).await
            } else {
                Vec::new()
            };
            results.push(QueryResult {
                columns,
                rows: Vec::new(),
                rows_affected: pending_affected,
                truncated: false,
                duration_ms: started.elapsed().as_millis() as u64,
            });
        }

        Ok(results)
    }

    /// Cancels whatever the session is currently running.
    ///
    /// Requires a *second* connection: the original one is blocked inside the
    /// query. This is why the backend pid is captured at connect time.
    async fn cancel(&self) -> Result<()> {
        let mut side = PgConnection::connect_with(&self.options).await?;
        sqlx::query("select pg_cancel_backend($1)")
            .bind(self.info.backend_pid)
            .execute(&mut side)
            .await?;
        let _ = side.close().await;
        Ok(())
    }

    /// Dumps the requested relations over a connection of its own.
    ///
    /// Not the session's. A dump of a large table runs for minutes, and the
    /// session's connection lives behind a mutex that every tab on this
    /// connection takes — holding it for the length of an export would freeze
    /// the window while the export is the one thing the user can watch. Opening
    /// a second connection from the stored options is the same move `cancel`
    /// already makes, and for the same reason.
    async fn dump(
        &self,
        req: &ExportRequest,
        out: &mut dyn DumpWriter,
        cancel: &AtomicBool,
    ) -> Result<DumpStats> {
        let mut conn = PgConnection::connect_with(&self.options).await?;
        let result = dump::run(&mut conn, req, out, cancel).await;
        // Best effort: the export's own outcome is what the user is waiting on,
        // and a socket that fails to close politely still closes.
        let _ = conn.close().await;
        result
    }

    /// Writes one cell, identified by the table's own primary key.
    ///
    /// The value and every key travel as bound parameters; only identifiers and
    /// catalogue-derived type names reach the statement as text. The `where`
    /// clause is dictated by the catalogue, not by the caller: the frontend can
    /// say which row it means, never how the row is found.
    async fn update_cell(
        &self,
        schema: &str,
        table: &str,
        column: &str,
        value: Option<&str>,
        keys: &[(String, String)],
    ) -> Result<Option<String>> {
        let mut guard = self.conn.lock().await;
        let conn = self.live(&mut guard)?;

        // A view has no rows of its own to update, and a matview's rows belong
        // to its query. Refusing by name beats a Postgres error the user has to
        // translate back into "this was never editable".
        match catalog::relkind(conn, schema, table).await?.as_deref() {
            Some("r") | Some("p") => {}
            Some(_) => {
                return Err(Error::other(format!(
                    "{schema}.{table} is not a table, so its rows cannot be edited"
                )))
            }
            None => return Err(Error::other(format!("{schema}.{table} no longer exists"))),
        }

        let columns = catalog::list_columns(conn, schema, table).await?;

        let target = columns
            .iter()
            .find(|c| c.name == column)
            .ok_or_else(|| Error::other(format!("{schema}.{table} has no column {column}")))?;

        let pk: Vec<&ColumnInfo> = columns.iter().filter(|c| c.primary_key).collect();
        if pk.is_empty() {
            return Err(Error::other(format!(
                "{schema}.{table} has no primary key, so a single row cannot be identified"
            )));
        }

        // The caller must name exactly the primary key. Anything else would be
        // a `where` clause we did not derive, which is how an edit turns into a
        // rewrite of every matching row.
        let named: Vec<&str> = keys.iter().map(|(name, _)| name.as_str()).collect();
        if named.len() != pk.len() || !pk.iter().all(|c| named.contains(&c.name.as_str())) {
            return Err(Error::other(format!(
                "row identity must be the primary key of {schema}.{table}"
            )));
        }

        let typed_keys: Vec<(String, String)> = keys
            .iter()
            .map(|(name, _)| {
                let info = pk.iter().find(|c| &c.name == name).expect("checked above");
                (name.clone(), info.data_type.clone())
            })
            .collect();

        let sql = build_update(schema, table, column, &target.data_type, &typed_keys);

        // A transaction so a statement that matched the wrong number of rows
        // leaves nothing behind. Zero means the row moved or was deleted since
        // it was read, which the user needs to hear rather than infer from an
        // unchanged cell.
        let mut tx = conn.begin().await?;
        let mut q = sqlx::query_scalar::<_, Option<String>>(&sql).bind(value);
        for (_, v) in keys {
            q = q.bind(v);
        }
        let updated = q.fetch_all(&mut *tx).await?;

        if updated.len() != 1 {
            tx.rollback().await?;
            return Err(Error::other(if updated.is_empty() {
                "no row matched; it may have been changed or deleted since it was read".to_string()
            } else {
                format!("{} rows matched; refusing to write", updated.len())
            }));
        }
        tx.commit().await?;

        Ok(updated.into_iter().next().flatten())
    }

    // -----------------------------------------------------------------------
    // Catalogue
    //
    // Each of these takes the session lock and hands the connection to the
    // matching function in `catalog`.
    // -----------------------------------------------------------------------

    async fn list_databases(&self) -> Result<Vec<String>> {
        let mut guard = self.conn.lock().await;
        catalog::list_databases(self.live(&mut guard)?).await
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaEntry>> {
        let mut guard = self.conn.lock().await;
        catalog::list_schemas(self.live(&mut guard)?).await
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableEntry>> {
        let mut guard = self.conn.lock().await;
        catalog::list_tables(self.live(&mut guard)?, schema).await
    }

    async fn list_columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>> {
        let mut guard = self.conn.lock().await;
        catalog::list_columns(self.live(&mut guard)?, schema, table).await
    }

    async fn list_indexes(&self, schema: &str, table: &str) -> Result<Vec<IndexInfo>> {
        let mut guard = self.conn.lock().await;
        catalog::list_indexes(self.live(&mut guard)?, schema, table).await
    }

    async fn list_functions(&self, schema: &str) -> Result<Vec<FunctionEntry>> {
        let mut guard = self.conn.lock().await;
        catalog::list_functions(self.live(&mut guard)?, schema).await
    }

    /// The cheap estimate, falling through to the exact count when the planner
    /// has nothing useful to say.
    async fn estimate_rows(&self, schema: &str, table: &str) -> Result<RowCount> {
        let estimate = {
            let mut guard = self.conn.lock().await;
            catalog::estimate_rows(self.live(&mut guard)?, schema, table)
                .await?
                .ok_or_else(|| Error::other(format!("no such table: {schema}.{table}")))?
        };

        if estimate > 0 {
            return Ok(RowCount {
                value: estimate,
                exact: false,
            });
        }
        self.count_rows(schema, table).await
    }

    async fn count_rows(&self, schema: &str, table: &str) -> Result<RowCount> {
        let mut guard = self.conn.lock().await;
        catalog::count_rows(self.live(&mut guard)?, schema, table).await
    }

    async fn function_definition(&self, oid: i64) -> Result<String> {
        let mut guard = self.conn.lock().await;
        catalog::function_definition(self.live(&mut guard)?, oid).await
    }

    async fn view_definition(&self, schema: &str, name: &str) -> Result<String> {
        let mut guard = self.conn.lock().await;
        catalog::view_definition(self.live(&mut guard)?, schema, name).await
    }
}

/// Column metadata for a statement that returned no rows.
///
/// Preparing the statement is enough for the server to answer what it would
/// return, and nothing runs. Only sensible for a single statement, so a
/// failure — a multi-statement script, or something not preparable — is
/// answered with no columns rather than an error: the query itself already
/// succeeded.
async fn describe_columns(conn: &mut PgConnection, sql: &str) -> Vec<ColumnMeta> {
    use sqlx::Executor;
    match conn.describe(sql).await {
        Ok(described) => described
            .columns()
            .iter()
            .map(|c| {
                let type_name = c.type_info().name().to_string();
                ColumnMeta {
                    name: c.name().to_string(),
                    type_class: classify(&type_name),
                    type_name,
                }
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}
