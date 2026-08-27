//! Reading a `.sql` file, and running it.
//!
//! The same split the export side makes, one direction over: the driver knows
//! what a statement *means* to this kind of server, this file knows where the
//! bytes *come from* and how the window hears about it.
//!
//! `inspect` is the half that makes the dialog worth having. It reads the file
//! without touching the database at all, so what the user is told about a dump
//! before they run it costs nothing and cannot be wrong about the file. An
//! import is the largest write this application performs; showing what is in
//! the file first is the same bargain the pending `UPDATE` preview and the
//! staged Redis deletions already make.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::drivers::postgres;
use crate::drivers::{DbState, ImportPreflight, ImportProgress, ImportRequest, ImportSummary};
use crate::error::Result;

/// Emitted as the file is applied, so the dialog can say where it has got to.
pub const IMPORT_PROGRESS_EVENT: &str = "import://progress";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    job_id: &'a str,
    statements: usize,
    total: usize,
    bytes: u64,
    table: &'a str,
}

/// Forwards the driver's ticks to the window.
struct Emit<'a> {
    app: &'a AppHandle,
    job_id: &'a str,
    total: usize,
}

impl ImportProgress for Emit<'_> {
    fn tick(&mut self, statements: usize, bytes: u64, table: &str) {
        // Advisory: a window that has gone away is not a reason to fail an
        // import that is otherwise applying fine.
        let _ = self.app.emit(
            IMPORT_PROGRESS_EVENT,
            Progress {
                job_id: self.job_id,
                statements,
                total: self.total,
                bytes,
                table,
            },
        );
    }
}

/// Reads a file and reports what is in it, without opening a connection.
///
/// On a large dump this is seconds of pure parsing, which is why it runs on the
/// blocking pool: the async runtime's threads are what every other tab's
/// queries are waiting on.
#[tauri::command]
pub async fn import_inspect(path: String) -> Result<ImportPreflight> {
    tokio::task::spawn_blocking(move || postgres::preflight(&path))
        .await
        .map_err(|e| crate::error::Error::other(e.to_string()))?
}

/// Runs the file against the connection, in one transaction.
///
/// `job_id` is made by the caller so Stop has something to name before this
/// call returns, the same way an export does. Nothing survives a failure: the
/// driver rolls back, and what comes back here is the server's own refusal with
/// the line of the file attached.
#[tauri::command]
pub async fn import_sql(
    app: AppHandle,
    db: State<'_, DbState>,
    id: String,
    job_id: String,
    req: ImportRequest,
) -> Result<ImportSummary> {
    let started = std::time::Instant::now();

    let mut progress = Emit {
        app: &app,
        job_id: &job_id,
        total: req.total_statements,
    };

    let stats = db.import(&id, &job_id, &req, &mut progress).await?;

    Ok(ImportSummary {
        statements: stats.statements,
        skipped: stats.skipped,
        rows: stats.rows,
        sequences_reset: stats.sequences_reset,
        key_hold: stats.key_hold,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// Asks a running import to stop. Silent when it has already finished.
#[tauri::command]
pub async fn cancel_import(db: State<'_, DbState>, job_id: String) -> Result<()> {
    db.cancel_job(&job_id).await;
    Ok(())
}
