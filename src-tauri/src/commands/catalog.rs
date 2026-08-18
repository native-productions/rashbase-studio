//! Reading the shape of the database.

use tauri::State;

use crate::drivers::{
    ColumnInfo, DbState, FunctionEntry, IndexInfo, KeyFilter, KeyPage, RowCount, SchemaEntry,
    SchemaGraph, TableEntry,
};
use crate::error::Result;

/// Databases on this session's server that the connected role can open.
#[tauri::command]
pub async fn list_databases(db: State<'_, DbState>, id: String) -> Result<Vec<String>> {
    db.list_databases(&id).await
}

#[tauri::command]
pub async fn list_schemas(db: State<'_, DbState>, id: String) -> Result<Vec<SchemaEntry>> {
    db.list_schemas(&id).await
}

#[tauri::command]
pub async fn list_tables(
    db: State<'_, DbState>,
    id: String,
    schema: String,
) -> Result<Vec<TableEntry>> {
    db.list_tables(&id, &schema).await
}

/// Cheap row count for the pager. Approximate unless the planner had nothing,
/// in which case it falls through to the exact count.
#[tauri::command]
pub async fn estimate_rows(
    db: State<'_, DbState>,
    id: String,
    schema: String,
    table: String,
) -> Result<RowCount> {
    db.estimate_rows(&id, &schema, &table).await
}

/// Exact row count. Walks the table, so it only runs when the user asks.
#[tauri::command]
pub async fn count_rows(
    db: State<'_, DbState>,
    id: String,
    schema: String,
    table: String,
) -> Result<RowCount> {
    db.count_rows(&id, &schema, &table).await
}

#[tauri::command]
pub async fn list_columns(
    db: State<'_, DbState>,
    id: String,
    schema: String,
    table: String,
) -> Result<Vec<ColumnInfo>> {
    db.list_columns(&id, &schema, &table).await
}

#[tauri::command]
pub async fn list_indexes(
    db: State<'_, DbState>,
    id: String,
    schema: String,
    table: String,
) -> Result<Vec<IndexInfo>> {
    db.list_indexes(&id, &schema, &table).await
}

/// Every relation in the schema with its columns, and the foreign keys between
/// them. One call, because the diagram needs all of it before it can draw
/// anything.
#[tauri::command]
pub async fn schema_graph(
    db: State<'_, DbState>,
    id: String,
    schema: String,
) -> Result<SchemaGraph> {
    db.schema_graph(&id, &schema).await
}

#[tauri::command]
pub async fn list_functions(
    db: State<'_, DbState>,
    id: String,
    schema: String,
) -> Result<Vec<FunctionEntry>> {
    db.list_functions(&id, &schema).await
}

#[tauri::command]
pub async fn function_definition(db: State<'_, DbState>, id: String, oid: i64) -> Result<String> {
    db.function_definition(&id, oid).await
}

#[tauri::command]
pub async fn view_definition(
    db: State<'_, DbState>,
    id: String,
    schema: String,
    name: String,
) -> Result<String> {
    db.view_definition(&id, &schema, &name).await
}

/// One page of a keyspace walk.
///
/// `cursor` is opaque and comes back from the previous page; `0` starts. The
/// reply says where to resume, how many keys were walked to fill it, and
/// whether the walk came round — the last two because a value filter is
/// answered by reading, and a page that cost 50,000 reads has to be able to say
/// so.
#[tauri::command]
pub async fn list_keys(
    db: State<'_, DbState>,
    id: String,
    filter: KeyFilter,
    cursor: u64,
    limit: usize,
) -> Result<KeyPage> {
    db.list_keys(&id, &filter, cursor, limit).await
}

/// Removes keys by name and reports how many existed.
///
/// The only other command besides `update_cell` that destroys user data. The
/// names are passed as arguments rather than composed into a command string:
/// a key is arbitrary bytes, and one holding a space would break anything
/// built by pasting names together.
#[tauri::command]
pub async fn delete_keys(db: State<'_, DbState>, id: String, keys: Vec<String>) -> Result<u64> {
    db.delete_keys(&id, &keys).await
}
