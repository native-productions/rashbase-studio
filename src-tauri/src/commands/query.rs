//! Running statements, and the one command that writes.

use tauri::State;

use crate::drivers::{DbState, QueryResult};
use crate::error::Result;

/// Runs a statement and returns one result set per row-returning statement in
/// it.
///
/// `maxRows` caps what is carried back to the window, not what the server runs.
/// A result that hit the cap says so, and its `rowsAffected` still reports what
/// the statement really produced.
#[tauri::command]
pub async fn execute_query(
    db: State<'_, DbState>,
    id: String,
    sql: String,
    max_rows: Option<usize>,
) -> Result<Vec<QueryResult>> {
    db.execute(&id, &sql, max_rows).await
}

#[tauri::command]
pub async fn cancel_query(db: State<'_, DbState>, id: String) -> Result<()> {
    db.cancel(&id).await
}

/// One part of the row's identity: a primary key column and its current value.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    pub column: String,
    pub value: String,
}

/// Writes one cell and returns what Postgres stored, as text.
///
/// The only command that writes user data. `value: None` is SQL NULL, which is
/// a different thing from the empty string and has to stay tellable apart all
/// the way down. Everything about how the row is *found* is decided backend
/// side from the catalogue; see the driver's `update_cell`.
#[tauri::command]
pub async fn update_cell(
    db: State<'_, DbState>,
    id: String,
    schema: String,
    table: String,
    column: String,
    value: Option<String>,
    keys: Vec<KeyValue>,
) -> Result<Option<String>> {
    let keys: Vec<(String, String)> = keys.into_iter().map(|k| (k.column, k.value)).collect();
    db.update_cell(&id, &schema, &table, &column, value.as_deref(), &keys)
        .await
}

/// Removes whole rows and reports how many went.
///
/// The second command that destroys user data, and it makes the same bargain as
/// the first: the rows are named by their primary key, every key is bound, and
/// the `where` clause is derived backend side from the catalogue. See the
/// driver's `delete_rows`.
#[tauri::command]
pub async fn delete_rows(
    db: State<'_, DbState>,
    id: String,
    schema: String,
    table: String,
    rows: Vec<Vec<KeyValue>>,
) -> Result<u64> {
    let rows: Vec<Vec<(String, String)>> = rows
        .into_iter()
        .map(|keys| keys.into_iter().map(|k| (k.column, k.value)).collect())
        .collect();
    db.delete_rows(&id, &schema, &table, &rows).await
}
