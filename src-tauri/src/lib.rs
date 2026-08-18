mod commands;
pub mod drivers;
mod error;
mod keychain;
mod ssh;

use drivers::DbState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The native file picker, used to choose an SSH private key. A webview
        // `<input type="file">` hands back a sandboxed handle and never a real
        // path, and a path is the whole point here.
        .plugin(tauri_plugin_dialog::init())
        .manage(DbState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::connect,
            commands::disconnect,
            commands::open_connection_ids,
            commands::execute_query,
            commands::cancel_query,
            commands::update_cell,
            commands::list_databases,
            commands::list_schemas,
            commands::list_tables,
            commands::estimate_rows,
            commands::count_rows,
            commands::list_columns,
            commands::list_indexes,
            commands::list_functions,
            commands::function_definition,
            commands::view_definition,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rashbase Studio");
}
