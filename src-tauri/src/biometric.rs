//! Asking the operating system to confirm the person at the keyboard.
//!
//! What this is, said before anything else: a **presence check on this app's
//! own windows**. It is not encryption. The keychain entries stay readable by
//! this process without a fingerprint; what Touch ID gates is whether the app
//! goes and reads them.
//!
//! ponytail: the cryptographic version stores each secret with
//! `kSecAccessControlBiometryCurrentSet`, so the OS itself refuses to hand it
//! over without a fingerprint and a stolen `connections.json` plus a copied
//! keychain buys an attacker nothing. The `keyring` crate cannot express that,
//! so it would mean our own `SecItemAdd`/`SecItemCopyMatching` for macOS in
//! `keychain.rs`. Upgrade path if this ever needs to be more than a lock on
//! the window.
//!
//! macOS only. Touch ID is `LocalAuthentication`, and there is no portable
//! equivalent. Windows Hello would be a second implementation behind these two
//! functions rather than a widening of them; until it exists, `available()`
//! answers false everywhere else and the UI says so in words instead of
//! showing a switch that does nothing.

use crate::error::{Error, Result};

/// Whether this machine has a biometric sensor the user has enrolled on.
///
/// Probed with the biometrics-only policy on purpose. Every Mac can do
/// `DeviceOwnerAuthentication` — that is just the login password — so probing
/// with the policy we actually evaluate would answer "yes, Touch ID is
/// available" on a machine that has no sensor.
#[cfg(target_os = "macos")]
pub fn available() -> bool {
    use objc2_local_authentication::{LAContext, LAPolicy};

    let context = unsafe { LAContext::new() };
    unsafe { context.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics) }
        .is_ok()
}

#[cfg(not(target_os = "macos"))]
pub fn available() -> bool {
    false
}

/// Puts the system's own prompt in front of the user and waits for it.
///
/// `reason` is shown inside that prompt after "Rashbase Studio is trying to",
/// so it reads as a verb phrase: "open the production replica".
#[cfg(target_os = "macos")]
pub async fn authenticate(reason: &str) -> Result<()> {
    let reason = reason.to_string();
    // On a blocking thread, not a tokio worker. The call below waits on a
    // reply the OS delivers from its own queue, and the wait is as long as the
    // user takes to put a finger down.
    tauri::async_runtime::spawn_blocking(move || evaluate(&reason))
        .await
        .map_err(|e| Error::other(format!("Touch ID prompt failed to run: {e}")))?
}

#[cfg(target_os = "macos")]
fn evaluate(reason: &str) -> Result<()> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};

    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    let context = unsafe { LAContext::new() };

    let reply = RcBlock::new(move |ok: Bool, error: *mut NSError| {
        let refusal = if ok.as_bool() {
            None
        } else {
            // The platform's own words, like the Postgres and SSH errors keep
            // theirs. "User canceled authentication" and "Biometry is locked
            // out" are different situations and the user has to be told which.
            Some(unsafe { error.as_ref() }.map_or_else(
                || "Touch ID was refused.".to_string(),
                |e| e.localizedDescription().to_string(),
            ))
        };
        let _ = tx.send(refusal);
    });

    unsafe {
        context.evaluatePolicy_localizedReason_reply(
            // Not the biometrics-only policy. A wet finger, a sensor that has
            // locked itself out after five bad reads, or a Mac that has just
            // rebooted must fall back to the login password — otherwise this
            // preference is a way for the user to lock themselves out of their
            // own connections, which is a worse outcome than the one it guards
            // against.
            LAPolicy::DeviceOwnerAuthentication,
            &NSString::from_str(reason),
            &reply,
        );
    }

    // Both `context` and `reply` stay in scope across this wait, and that is
    // load bearing: LAContext cancels any evaluation in flight when it is
    // released, so a version of this that dropped it before waiting would
    // reliably fail with LAErrorInvalidContext.
    match rx.recv() {
        Ok(None) => Ok(()),
        Ok(Some(message)) => Err(Error::AuthRefused(message)),
        Err(_) => Err(Error::AuthRefused(
            "The Touch ID prompt closed without answering.".to_string(),
        )),
    }
}

#[cfg(not(target_os = "macos"))]
pub async fn authenticate(_reason: &str) -> Result<()> {
    Err(Error::AuthRefused(
        "Touch ID is only available on macOS.".to_string(),
    ))
}
