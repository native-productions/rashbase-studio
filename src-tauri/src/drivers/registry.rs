//! The driver registry and the sessions it has opened.
//!
//! Two maps with different lifetimes: the drivers are fixed at build time and
//! never change, the sessions come and go as the user connects. Adding a
//! database means one line in `Default` and a folder next to `postgres`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::drivers::postgres::PgDriver;
use crate::drivers::redis::bull::{
    EventPage, JobPage, QueueEntry, QueuePage, RetryOutcome, RetryRequest,
};
use crate::drivers::redis::{RedisDriver, RedisSession};
use crate::drivers::types::{
    ColumnInfo, ConnectionConfig, ConnectionInfo, DumpStats, ExportRequest, FunctionEntry,
    ImportRequest, ImportStats, IndexInfo, KeyFilter, KeyPage, QueryResult, RowCount, SchemaEntry,
    SchemaGraph, TableEntry,
};
use crate::drivers::{Driver, DumpWriter, ImportProgress, Session};
use crate::error::{Error, Result};
use crate::ssh::{self, Tunnel};

/// One open connection: the session, and the tunnel it is reached through.
///
/// They are stored together because they die together. A tunnel outliving its
/// session is a forwarder listening for a client that will never come back;
/// a session outliving its tunnel is a socket to a port nothing answers on.
struct Open {
    session: Arc<dyn Session>,
    /// Dropped with the entry, which stops the forwarder and closes SSH. Never
    /// read: holding it *is* what it is for.
    _tunnel: Option<Tunnel>,
}

pub struct DbState {
    drivers: HashMap<&'static str, Arc<dyn Driver>>,
    sessions: RwLock<HashMap<String, Open>>,
    /// The stop flag of each export or import in flight, keyed by the job id
    /// the caller made.
    ///
    /// A flag rather than an abort handle: the work reads it between rows or
    /// between statements and returns, so it unwinds through its own error
    /// path — which is what lets an export delete the file it half wrote and an
    /// import roll its transaction back. Killing the task instead would leave
    /// a half-written file looking finished, or a half-applied dump committed.
    ///
    /// One map for both, because a job id is a job id: two would be two ways to
    /// leave a Stop button wired to nothing.
    jobs: RwLock<HashMap<String, Arc<AtomicBool>>>,
}

impl Default for DbState {
    fn default() -> Self {
        // Written by hand rather than derived: the point of the default state
        // is the drivers that are in it.
        let drivers: Vec<Arc<dyn Driver>> = vec![Arc::new(PgDriver), Arc::new(RedisDriver)];
        Self {
            drivers: drivers.into_iter().map(|d| (d.id(), d)).collect(),
            sessions: RwLock::default(),
            jobs: RwLock::default(),
        }
    }
}

impl DbState {
    fn driver(&self, id: &str) -> Result<&Arc<dyn Driver>> {
        self.drivers
            .get(id)
            .ok_or_else(|| Error::other(format!("no driver named {id}")))
    }

    async fn session(&self, id: &str) -> Result<Arc<dyn Session>> {
        self.sessions
            .read()
            .await
            .get(id)
            .map(|open| open.session.clone())
            .ok_or_else(|| Error::UnknownConnection(id.to_string()))
    }

    pub async fn open_ids(&self) -> Vec<String> {
        self.sessions.read().await.keys().cloned().collect()
    }

    /// Opens a session, building an SSH tunnel first when the connection is
    /// only reachable through one.
    ///
    /// The tunnel is raised here rather than inside the driver so that every
    /// driver gets it: what a driver is handed is an address that answers, and
    /// whether that address is the real server or a forwarded loopback port is
    /// not a question a Postgres or MySQL client should have to hold an opinion
    /// about.
    ///
    /// One tunnel per session, including the connections derived by picking a
    /// database off a tunnelled server: five databases on one jump host is five
    /// SSH sessions. Sharing one would mean reference counting a tunnel across
    /// sessions that are otherwise independent, which is a lifetime problem
    /// worth taking on when someone is actually holding a dozen open, and not
    /// before.
    pub async fn connect(
        &self,
        config: &ConnectionConfig,
        password: Option<&str>,
        ssh_secret: Option<&str>,
    ) -> Result<ConnectionInfo> {
        let (config, tunnel) = match &config.ssh {
            Some(ssh) => {
                let tunnel = ssh::open(ssh, &config.host, config.port, ssh_secret).await?;
                let mut through = config.clone();
                through.host = "127.0.0.1".to_string();
                through.port = tunnel.local_port;
                (through, Some(tunnel))
            }
            None => (config.clone(), None),
        };

        let session = self
            .driver(&config.driver)?
            .connect(&config, password)
            .await?;
        let info = session.info().clone();
        self.sessions.write().await.insert(
            config.id.clone(),
            Open {
                session,
                _tunnel: tunnel,
            },
        );
        Ok(info)
    }

    pub async fn disconnect(&self, id: &str) -> Result<()> {
        // Dropped from the map first, so nothing new can reach it while it is
        // being closed. In-flight queries hold their own `Arc` and finish.
        if let Some(open) = self.sessions.write().await.remove(id) {
            open.session.close().await?;
        }
        Ok(())
    }

    pub async fn execute(
        &self,
        id: &str,
        sql: &str,
        max_rows: Option<usize>,
    ) -> Result<Vec<QueryResult>> {
        self.session(id).await?.execute(sql, max_rows).await
    }

    pub async fn cancel(&self, id: &str) -> Result<()> {
        self.session(id).await?.cancel().await
    }

    /// Runs an export, registering its stop flag for the length of the run.
    ///
    /// The flag is removed on every path, including the failing one: a job id
    /// left in the map is a stop button wired to nothing.
    pub async fn export(
        &self,
        id: &str,
        job_id: &str,
        req: &ExportRequest,
        out: &mut dyn DumpWriter,
    ) -> Result<DumpStats> {
        let session = self.session(id).await?;
        let cancel = self.claim(job_id).await;
        let result = session.dump(req, out, &cancel).await;
        self.jobs.write().await.remove(job_id);
        result
    }

    /// Runs an import, registering its stop flag the same way an export does.
    pub async fn import(
        &self,
        id: &str,
        job_id: &str,
        req: &ImportRequest,
        progress: &mut dyn ImportProgress,
    ) -> Result<ImportStats> {
        let session = self.session(id).await?;
        let cancel = self.claim(job_id).await;
        let result = session.import(req, &cancel, progress).await;
        self.jobs.write().await.remove(job_id);
        result
    }

    /// Registers a stop flag under a job id and hands it back.
    async fn claim(&self, job_id: &str) -> Arc<AtomicBool> {
        let cancel = Arc::new(AtomicBool::new(false));
        self.jobs
            .write()
            .await
            .insert(job_id.to_string(), cancel.clone());
        cancel
    }

    /// Asks a running job to stop. Silent when it has already finished, which
    /// is what a Stop pressed a moment too late looks like.
    pub async fn cancel_job(&self, job_id: &str) {
        if let Some(flag) = self.jobs.read().await.get(job_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub async fn update_cell(
        &self,
        id: &str,
        schema: &str,
        table: &str,
        column: &str,
        value: Option<&str>,
        keys: &[(String, String)],
    ) -> Result<Option<String>> {
        self.session(id)
            .await?
            .update_cell(schema, table, column, value, keys)
            .await
    }

    pub async fn delete_rows(
        &self,
        id: &str,
        schema: &str,
        table: &str,
        rows: &[Vec<(String, String)>],
    ) -> Result<u64> {
        self.session(id).await?.delete_rows(schema, table, rows).await
    }

    pub async fn list_databases(&self, id: &str) -> Result<Vec<String>> {
        self.session(id).await?.list_databases().await
    }

    pub async fn list_schemas(&self, id: &str) -> Result<Vec<SchemaEntry>> {
        self.session(id).await?.list_schemas().await
    }

    pub async fn list_tables(&self, id: &str, schema: &str) -> Result<Vec<TableEntry>> {
        self.session(id).await?.list_tables(schema).await
    }

    pub async fn list_columns(
        &self,
        id: &str,
        schema: &str,
        table: &str,
    ) -> Result<Vec<ColumnInfo>> {
        self.session(id).await?.list_columns(schema, table).await
    }

    pub async fn schema_graph(&self, id: &str, schema: &str) -> Result<SchemaGraph> {
        self.session(id).await?.schema_graph(schema).await
    }

    pub async fn list_indexes(
        &self,
        id: &str,
        schema: &str,
        table: &str,
    ) -> Result<Vec<IndexInfo>> {
        self.session(id).await?.list_indexes(schema, table).await
    }

    pub async fn list_functions(&self, id: &str, schema: &str) -> Result<Vec<FunctionEntry>> {
        self.session(id).await?.list_functions(schema).await
    }

    pub async fn estimate_rows(&self, id: &str, schema: &str, table: &str) -> Result<RowCount> {
        self.session(id).await?.estimate_rows(schema, table).await
    }

    pub async fn count_rows(&self, id: &str, schema: &str, table: &str) -> Result<RowCount> {
        self.session(id).await?.count_rows(schema, table).await
    }

    pub async fn function_definition(&self, id: &str, oid: i64) -> Result<String> {
        self.session(id).await?.function_definition(oid).await
    }

    pub async fn view_definition(&self, id: &str, schema: &str, name: &str) -> Result<String> {
        self.session(id).await?.view_definition(schema, name).await
    }

    pub async fn list_keys(
        &self,
        id: &str,
        filter: &KeyFilter,
        cursor: u64,
        limit: usize,
    ) -> Result<KeyPage> {
        self.session(id).await?.list_keys(filter, cursor, limit).await
    }

    pub async fn delete_keys(&self, id: &str, keys: &[String]) -> Result<u64> {
        self.session(id).await?.delete_keys(keys).await
    }

    // -- BullMQ -------------------------------------------------------------

    /// The session as the Redis one, or a refusal naming what was asked for.
    ///
    /// Routed by downcast rather than through the `Session` trait, because
    /// BullMQ is one Node library's key layout rather than something databases
    /// have. `Unsupported` is the same answer the catalogue gives when a driver
    /// has no schemas: not a failure, just a question this connection cannot be
    /// asked.
    async fn redis(&self, id: &str) -> Result<Arc<dyn Session>> {
        let session = self.session(id).await?;
        if session.as_any().downcast_ref::<RedisSession>().is_none() {
            return Err(Error::Unsupported("BullMQ queues"));
        }
        Ok(session)
    }

    pub async fn list_queues(
        &self,
        id: &str,
        prefix: &str,
        cursor: u64,
        limit: usize,
    ) -> Result<QueuePage> {
        let session = self.redis(id).await?;
        let redis = session.as_any().downcast_ref::<RedisSession>().unwrap();
        redis.list_queues(prefix, cursor, limit).await
    }

    pub async fn queue_counts(&self, id: &str, prefix: &str, queue: &str) -> Result<QueueEntry> {
        let session = self.redis(id).await?;
        let redis = session.as_any().downcast_ref::<RedisSession>().unwrap();
        redis.queue_counts(prefix, queue).await
    }

    pub async fn list_jobs(
        &self,
        id: &str,
        prefix: &str,
        queue: &str,
        state: &str,
        offset: usize,
        limit: usize,
    ) -> Result<JobPage> {
        let session = self.redis(id).await?;
        let redis = session.as_any().downcast_ref::<RedisSession>().unwrap();
        redis.list_jobs(prefix, queue, state, offset, limit).await
    }

    pub async fn queue_events(
        &self,
        id: &str,
        prefix: &str,
        queue: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<EventPage> {
        let session = self.redis(id).await?;
        let redis = session.as_any().downcast_ref::<RedisSession>().unwrap();
        redis.queue_events(prefix, queue, after, limit).await
    }

    pub async fn retry_jobs(&self, id: &str, req: &RetryRequest) -> Result<Vec<RetryOutcome>> {
        let session = self.redis(id).await?;
        let redis = session.as_any().downcast_ref::<RedisSession>().unwrap();
        redis.retry_jobs(req).await
    }
}
