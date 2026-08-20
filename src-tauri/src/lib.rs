mod commands;
pub mod drivers;
mod error;
mod keychain;
#[cfg(target_os = "macos")]
mod menu;
mod ssh;

use drivers::DbState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The native file picker, used to choose an SSH private key. A webview
        // `<input type="file">` hands back a sandboxed handle and never a real
        // path, and a path is the whole point here.
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            // The menu bar is the third way into the same command registry the
            // palette and the keyboard layer use, so it adds entries and never
            // behaviour.
            #[cfg(target_os = "macos")]
            menu::install(_app)?;
            Ok(())
        })
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
            commands::export_objects,
            commands::cancel_export,
            commands::export_target_exists,
            commands::update_cell,
            commands::delete_rows,
            commands::list_databases,
            commands::list_schemas,
            commands::list_tables,
            commands::estimate_rows,
            commands::count_rows,
            commands::list_columns,
            commands::list_indexes,
            commands::schema_graph,
            commands::list_functions,
            commands::function_definition,
            commands::view_definition,
            commands::list_keys,
            commands::delete_keys,
            commands::list_queues,
            commands::queue_counts,
            commands::list_jobs,
            commands::queue_events,
            commands::retry_jobs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rashbase Studio");
}
