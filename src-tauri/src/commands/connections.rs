//! The connection registry: what is saved on disk, and its credentials.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::drivers::{ConnectionConfig, DbState};
use crate::error::{Error, Result};
use crate::keychain;

const CONNECTIONS_FILE: &str = "connections.json";

fn connections_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| Error::other(format!("no config dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(CONNECTIONS_FILE))
}

fn read_connections(app: &AppHandle) -> Result<Vec<ConnectionConfig>> {
    let path = connections_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

fn write_connections(app: &AppHandle, list: &[ConnectionConfig]) -> Result<()> {
    std::fs::write(connections_path(app)?, serde_json::to_vec_pretty(list)?)?;
    Ok(())
}

#[tauri::command]
pub async fn list_connections(app: AppHandle) -> Result<Vec<ConnectionConfig>> {
    read_connections(&app)
}

/// Persists connection metadata to disk and its secrets to the OS keystore.
///
/// `None` means "leave whatever is stored alone", so editing a connection's
/// host does not silently wipe its credential, and changing its database
/// password does not wipe its SSH passphrase. The empty string is the explicit
/// "forget this one", which is how a passphrase is cleared after a key is
/// re-created without one.
#[tauri::command]
pub async fn save_connection(
    app: AppHandle,
    config: ConnectionConfig,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> Result<Vec<ConnectionConfig>> {
    let mut list = read_connections(&app)?;
    match list.iter_mut().find(|c| c.id == config.id) {
        Some(existing) => *existing = config.clone(),
        None => list.push(config.clone()),
    }
    write_connections(&app, &list)?;

    store_secret(&app, &config.id, password)?;
    store_secret(&app, &keychain::ssh_slot(&config.id), ssh_secret)?;
    Ok(list)
}

fn store_secret(app: &AppHandle, slot: &str, secret: Option<String>) -> Result<()> {
    match secret.as_deref() {
        None => Ok(()),
        Some("") => keychain::delete_password(app, slot),
        Some(value) => keychain::set_password(app, slot, value),
    }
}

/// Deletes a connection and every connection derived from it.
///
/// The children authenticate with the parent's credential, so leaving them
/// behind would leave a list of entries that can never open again.
#[tauri::command]
pub async fn delete_connection(
    app: AppHandle,
    db: State<'_, DbState>,
    id: String,
) -> Result<Vec<ConnectionConfig>> {
    let mut list = read_connections(&app)?;
    let mut doomed = vec![id.clone()];
    doomed.extend(
        list.iter()
            .filter(|c| c.parent_id.as_deref() == Some(id.as_str()))
            .map(|c| c.id.clone()),
    );

    for target in &doomed {
        db.disconnect(target).await?;
        keychain::delete_password(&app, target)?;
        keychain::delete_password(&app, &keychain::ssh_slot(target))?;
    }
    list.retain(|c| !doomed.contains(&c.id));
    write_connections(&app, &list)?;
    Ok(list)
}
