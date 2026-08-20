//! The Touch ID policy, and the grace window that makes it usable.
//!
//! This lives on the Rust side rather than in `localStorage` beside the theme
//! and the font scale, and the reason is the whole point of the feature: the
//! gate sits in front of the keystore read, in `session::connect`. A policy the
//! webview owned would be a policy a compromised webview rewrites, and then the
//! prompt is decoration.
//!
//! `security.json` sits beside `connections.json` in the config directory, and
//! is read the same defensive way: a file written by an older build should cost
//! the user a preference, not the ability to open the app.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::biometric;
use crate::error::{Error, Result};

const SECURITY_FILE: &str = "security.json";

/// How long one successful prompt is good for.
///
/// Without it this is unusable rather than secure. Picking a database off a
/// server opens a *derived* connection against the parent's credential, so
/// every database switch is another `connect` — and a Touch ID sheet on every
/// database switch is a preference the user turns off within an hour, which
/// leaves them with no gate at all.
///
/// ponytail: process-wide, not per connection. Confirming presence to open one
/// database also opens the next five minutes for the rest of them. Per-owner
/// windows if that ever turns out to matter; the state is already keyed by
/// nothing, so narrowing it is a HashMap and no new plumbing.
const GRACE: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SecurityPolicy {
    /// Hold the app behind a prompt until it is answered.
    pub lock_on_launch: bool,
    /// Prompt before opening any connection, regardless of what the connection
    /// itself says.
    pub require_for_all_connections: bool,
}

/// When presence was last confirmed.
///
/// Managed state rather than a static, so it dies with the app and there is
/// nothing to leak between runs.
#[derive(Default)]
pub struct AuthState(std::sync::Mutex<Option<Instant>>);

impl AuthState {
    fn within_grace(&self) -> bool {
        self.0
            .lock()
            .ok()
            .and_then(|at| *at)
            .is_some_and(|at| at.elapsed() < GRACE)
    }

    fn mark(&self) {
        if let Ok(mut at) = self.0.lock() {
            *at = Some(Instant::now());
        }
    }

    /// Locking the app throws the window away. Coming back from a lock screen
    /// on a grace period granted before it would make the lock a formality.
    fn clear(&self) {
        if let Ok(mut at) = self.0.lock() {
            *at = None;
        }
    }
}

fn security_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| Error::other(format!("no config dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(SECURITY_FILE))
}

/// The stored policy, or the off position.
///
/// A file that will not parse is treated as absent rather than as a failure.
/// The alternative is an app that refuses to start because a preference file
/// got truncated, and the safe direction for *this* preference is off: it
/// gates nothing the user did not ask it to gate.
pub fn read_policy(app: &AppHandle) -> SecurityPolicy {
    let stored = security_path(app).ok().and_then(|path| std::fs::read(path).ok());
    parse_policy(stored.as_deref())
}

/// Split out from the read so the fallback can be tested without an app.
fn parse_policy(stored: Option<&[u8]>) -> SecurityPolicy {
    stored
        .and_then(|raw| serde_json::from_slice(raw).ok())
        .unwrap_or_default()
}

/// Whether this connection has to meet a prompt.
///
/// Pure, and separate from `guard_connection`, because it is the part with a
/// silent failure mode: every way of getting this wrong produces an app that
/// looks exactly like an app that is working, and only one of the two is
/// actually asking anybody anything.
fn needs_prompt(policy: SecurityPolicy, per_connection: bool, within_grace: bool) -> bool {
    (per_connection || policy.require_for_all_connections) && !within_grace
}

#[tauri::command]
pub async fn biometric_available() -> bool {
    biometric::available()
}

#[tauri::command]
pub async fn get_security_policy(app: AppHandle) -> Result<SecurityPolicy> {
    Ok(read_policy(&app))
}

/// Writes the policy, after confirming who is asking.
///
/// Gated on the *current* policy, not the incoming one. Turning the lock off is
/// the request that has to be authenticated — a lock anyone can remove by
/// flipping a switch is not a lock — and turning it on for the first time has
/// nothing to authenticate against yet.
#[tauri::command]
pub async fn set_security_policy(
    app: AppHandle,
    auth: State<'_, AuthState>,
    policy: SecurityPolicy,
) -> Result<SecurityPolicy> {
    let current = read_policy(&app);
    if current.lock_on_launch || current.require_for_all_connections {
        biometric::authenticate("change its security settings").await?;
        auth.mark();
    }
    std::fs::write(security_path(&app)?, serde_json::to_vec_pretty(&policy)?)?;
    Ok(policy)
}

/// The launch gate.
///
/// Honest about what it is: the data behind this screen is not encrypted, and
/// anything with filesystem access can read `connections.json` without ever
/// meeting it. What it stops is the person who walks up to an unlocked machine
/// and finds the app already open on a production replica.
#[tauri::command]
pub async fn unlock_app(app: AppHandle, auth: State<'_, AuthState>) -> Result<()> {
    if !read_policy(&app).lock_on_launch {
        return Ok(());
    }
    // Cleared first: arriving at the lock screen is the moment any earlier
    // confirmation stops counting.
    auth.clear();
    biometric::authenticate("unlock Rashbase Studio").await?;
    auth.mark();
    Ok(())
}

/// Prompts before a connection opens, when the policy says to.
///
/// Called from `session::connect`, ahead of the keystore lookup, so a refusal
/// means no secret was read rather than a secret that was read and then not
/// used.
pub async fn guard_connection(
    app: &AppHandle,
    auth: &AuthState,
    name: &str,
    per_connection: bool,
) -> Result<()> {
    if !needs_prompt(read_policy(app), per_connection, auth.within_grace()) {
        return Ok(());
    }
    biometric::authenticate(&format!("open {name}")).await?;
    auth.mark();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The failure this guards is silent in the worst direction: a file that
    /// will not parse must not be read as "the lock is on and unopenable", and
    /// must not be read as anything other than off. Both wrong answers look
    /// like a working app.
    #[test]
    fn an_unreadable_policy_is_the_off_position() {
        for stored in [None, Some(&b""[..]), Some(&b"{"[..]), Some(&b"[]"[..])] {
            let policy = parse_policy(stored);
            assert!(!policy.lock_on_launch);
            assert!(!policy.require_for_all_connections);
        }
    }

    /// A file written before one of these fields existed keeps the other.
    #[test]
    fn a_missing_field_does_not_take_the_rest_with_it() {
        let policy = parse_policy(Some(br#"{"lockOnLaunch":true}"#));
        assert!(policy.lock_on_launch);
        assert!(!policy.require_for_all_connections);
    }

    #[test]
    fn nothing_is_gated_until_something_asks_for_it() {
        let off = SecurityPolicy::default();
        assert!(!needs_prompt(off, false, false));
    }

    #[test]
    fn either_switch_gates_a_connection() {
        let all = SecurityPolicy { lock_on_launch: false, require_for_all_connections: true };
        assert!(needs_prompt(all, false, false));
        assert!(needs_prompt(SecurityPolicy::default(), true, false));
    }

    /// Otherwise picking a database off a gated server prompts on every switch,
    /// which is how a user ends up turning the whole thing off.
    #[test]
    fn a_recent_confirmation_covers_the_next_connection() {
        let all = SecurityPolicy { lock_on_launch: false, require_for_all_connections: true };
        assert!(!needs_prompt(all, true, true));
    }
}
