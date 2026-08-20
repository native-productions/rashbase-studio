//! Opening and closing sessions.

use tauri::{AppHandle, State};

use crate::commands::security::{guard_connection, AuthState};
use crate::drivers::{ConnectionConfig, ConnectionInfo, DbState};
use crate::error::Result;
use crate::keychain;

/// Opens a session. Both secrets are resolved backend-side from the keystore;
/// the arguments are only passed when testing credentials that are not saved
/// yet.
///
/// A connection derived by picking a database off a server has no credential of
/// its own, so the lookup runs against `parent_id`: one secret per server, not
/// one per database. The SSH secret follows the same owner, because a database
/// picked off a tunnelled server is reached through the same jump host.
#[tauri::command]
pub async fn connect(
    app: AppHandle,
    db: State<'_, DbState>,
    auth: State<'_, AuthState>,
    config: ConnectionConfig,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> Result<ConnectionInfo> {
    // Ahead of the keystore lookup, and that placement is the feature. A gate
    // the frontend drew would be a gate a compromised webview skips; here, a
    // refusal means the secret was never read at all.
    //
    // Only when the secret is coming out of the keystore. Testing a password
    // typed into the sheet passes it inline and never reaches the store, and
    // asking for a fingerprint to check something the user just typed is a
    // prompt with nothing behind it.
    if password.is_none() {
        guard_connection(&app, &auth, &config.name, config.require_biometric).await?;
    }

    let owner = config.parent_id.as_deref().unwrap_or(&config.id);

    let stored_password;
    let pw = match password.as_deref() {
        Some(p) => Some(p),
        None => {
            stored_password = keychain::get_password(&app, owner)?;
            stored_password.as_deref()
        }
    };

    let stored_ssh;
    let ssh = match ssh_secret.as_deref() {
        Some(s) => Some(s),
        // Only looked up for a tunnelled connection, so a plain one never
        // touches the keystore twice, and never reports a keychain failure for
        // a secret it was not going to use.
        None if config.ssh.is_some() => {
            stored_ssh = keychain::get_password(&app, &keychain::ssh_slot(owner))?;
            stored_ssh.as_deref()
        }
        None => None,
    };

    db.connect(&config, pw, ssh).await
}

#[tauri::command]
pub async fn disconnect(db: State<'_, DbState>, id: String) -> Result<()> {
    db.disconnect(&id).await
}

#[tauri::command]
pub async fn open_connection_ids(db: State<'_, DbState>) -> Result<Vec<String>> {
    Ok(db.open_ids().await)
}
