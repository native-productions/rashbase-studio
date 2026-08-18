//! Credential storage.
//!
//! Release builds use the OS keystore: `keyring` maps to macOS Keychain,
//! Windows Credential Manager, and Linux Secret Service behind one API.
//! Passwords never touch our own config files and never travel back to the
//! webview: the frontend holds a connection id, the backend resolves the
//! secret.
//!
//! # Why development builds do not
//!
//! macOS binds a keychain item's access control to the code signature of the
//! process that created it. `tauri dev` ad-hoc signs a fresh binary on every
//! `cargo build`, so each rebuild is a different application as far as the
//! Keychain is concerned: reads fail with `errSecAuthFailed`, and so do the
//! writes and deletes that would let the app repair itself. The practical
//! effect is that every backend change costs a re-entered password, and
//! sometimes cannot be repaired from inside the app at all.
//!
//! So development builds keep credentials in a file instead. It is chmod 600
//! and it is plain text, which is acceptable for the local database passwords
//! a developer types while working on this app, and unacceptable for anything
//! else. The switch is `debug_assertions`, so a release build cannot reach
//! this path even by accident.

use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

/// The keystore entry holding a connection's SSH secret, which is its key
/// passphrase or its jump-host password depending on how the tunnel
/// authenticates.
///
/// A separate entry from the database password rather than a second field in
/// one: they are replaced at different times, and a single blob would mean
/// rewriting the passphrase every time the database password changes.
pub fn ssh_slot(connection_id: &str) -> String {
    format!("{connection_id}::ssh")
}

pub fn set_password(app: &AppHandle, connection_id: &str, password: &str) -> Result<()> {
    imp::set_password(app, connection_id, password)
}

/// Returns `None` when no secret is stored, which is a normal state for
/// connections that authenticate by trust, peer, or `.pgpass`.
///
/// Anything else means a secret probably exists but cannot be read, which is a
/// different situation: the user has to type the password again, and the UI
/// needs to know to ask.
pub fn get_password(app: &AppHandle, connection_id: &str) -> Result<Option<String>> {
    imp::get_password(app, connection_id)
}

pub fn delete_password(app: &AppHandle, connection_id: &str) -> Result<()> {
    imp::delete_password(app, connection_id)
}

#[cfg(not(debug_assertions))]
mod imp {
    use super::*;

    const SERVICE: &str = "id.rashgaroth.rashbase-studio";

    fn entry(connection_id: &str) -> Result<keyring::Entry> {
        Ok(keyring::Entry::new(SERVICE, connection_id)?)
    }

    pub fn set_password(_app: &AppHandle, connection_id: &str, password: &str) -> Result<()> {
        entry(connection_id)?.set_password(password)?;
        Ok(())
    }

    pub fn get_password(_app: &AppHandle, connection_id: &str) -> Result<Option<String>> {
        match entry(connection_id)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::CredentialUnreadable(e.to_string())),
        }
    }

    pub fn delete_password(_app: &AppHandle, connection_id: &str) -> Result<()> {
        match entry(connection_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(debug_assertions)]
mod imp {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use super::*;

    /// Named so it is obvious in a file listing what this is and is not.
    const FILE: &str = "dev-credentials.json";

    fn path(app: &AppHandle) -> Result<PathBuf> {
        let dir = app
            .path()
            .app_config_dir()
            .map_err(|e| Error::other(format!("no config dir: {e}")))?;
        std::fs::create_dir_all(&dir)?;
        Ok(dir.join(FILE))
    }

    fn read(app: &AppHandle) -> Result<HashMap<String, String>> {
        let path = path(app)?;
        if !path.exists() {
            return Ok(HashMap::new());
        }
        Ok(serde_json::from_slice(&std::fs::read(path)?)?)
    }

    fn write(app: &AppHandle, map: &HashMap<String, String>) -> Result<()> {
        let path = path(app)?;
        std::fs::write(&path, serde_json::to_vec_pretty(map)?)?;
        // Owner-only. The default would be world-readable on a shared machine.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    pub fn set_password(app: &AppHandle, connection_id: &str, password: &str) -> Result<()> {
        let mut map = read(app)?;
        map.insert(connection_id.to_string(), password.to_string());
        write(app, &map)
    }

    pub fn get_password(app: &AppHandle, connection_id: &str) -> Result<Option<String>> {
        Ok(read(app)?.get(connection_id).cloned())
    }

    pub fn delete_password(app: &AppHandle, connection_id: &str) -> Result<()> {
        let mut map = read(app)?;
        if map.remove(connection_id).is_none() {
            return Ok(());
        }
        write(app, &map)
    }
}
