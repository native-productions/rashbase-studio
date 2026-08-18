//! SSH tunnels: a local port that carries a database connection to a server
//! only the jump host can reach.
//!
//! # Why a real listener and not a stream
//!
//! The obvious shape is to hand the driver the forwarded channel directly as
//! an `AsyncRead + AsyncWrite`. It does not work here: a session needs a second
//! connection to the same server to cancel a running query (see
//! `PgSession::cancel`), and sqlx reconnects by address, not by stream. So the
//! tunnel exposes an address — `127.0.0.1:<port>` — and every connection made
//! to it opens its own `direct-tcpip` channel. One tunnel, any number of
//! connections, which is what the rest of the app already assumes.
//!
//! # What is deliberately not here
//!
//! No trust-on-first-use. A host absent from `~/.ssh/known_hosts` is refused
//! with the fingerprint printed, not silently accepted: an SSH tunnel exists to
//! carry credentials across a network we do not trust, and a client that
//! accepts any host key on the first connection has given that away for a
//! dialog nobody reads.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::drivers::types::{SshAuth, SshConfig};
use crate::error::{Error, Result};

/// Identity files OpenSSH tries when none is named, in its own order. Used for
/// the same reason: a user who left the field blank means "the key I always
/// use", and asking them to type a path they never type for `ssh` is friction
/// with nothing on the other side of it.
const DEFAULT_KEYS: [&str; 3] = ["id_ed25519", "id_ecdsa", "id_rsa"];

/// How long the tunnel waits on a silent server before sending a keepalive.
///
/// Without this an idle connection dies inside whatever NAT or load balancer
/// sits between us and the jump host, and the user finds out when their next
/// query fails rather than when the link actually dropped.
const KEEPALIVE: Duration = Duration::from_secs(30);

/// A live tunnel.
///
/// Dropping it stops the listener and closes the SSH session, which is why it
/// is held next to the session it serves rather than detached: the two have
/// exactly the same lifetime and nothing has to remember to tear it down.
pub struct Tunnel {
    /// Loopback port the driver connects to instead of the real host.
    pub local_port: u16,
    forwarder: JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.forwarder.abort();
    }
}

/// Opens a tunnel to `target_host:target_port` as seen from the jump host.
///
/// `secret` is the key passphrase or the jump host password depending on
/// `config.auth`, and is `None` when nothing is stored, which is the normal
/// state for an unencrypted key.
pub async fn open(
    config: &SshConfig,
    target_host: &str,
    target_port: u16,
    secret: Option<&str>,
) -> Result<Tunnel> {
    let client_config = Arc::new(client::Config {
        keepalive_interval: Some(KEEPALIVE),
        ..Default::default()
    });

    let mut handle = client::connect(
        client_config,
        (config.host.as_str(), config.port),
        HostKeyCheck {
            host: config.host.clone(),
            port: config.port,
            user: config.user.clone(),
        },
    )
    .await
    .map_err(|e| match e {
        // The handler's own refusals already say everything useful; wrapping
        // them again would bury the fingerprint under "connection failed".
        Error::Ssh(_) | Error::SshSecretRequired(_) => e,
        other => Error::Ssh(format!("{}:{}: {other}", config.host, config.port)),
    })?;

    authenticate(&mut handle, config, secret).await?;

    // Port 0 asks the OS for a free one, so two tunnels can never collide and
    // nothing has to track which ports this app has already taken.
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let local_port = listener.local_addr()?.port();

    let target_host = target_host.to_string();
    let forwarder = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let channel = match handle
                .channel_open_direct_tcpip(
                    target_host.clone(),
                    target_port as u32,
                    "127.0.0.1",
                    local_port as u32,
                )
                .await
            {
                Ok(channel) => channel,
                // The jump host refused to reach the database. Dropping the
                // socket makes the driver's own connect fail, which is where
                // the user is already looking for the reason.
                Err(_) => continue,
            };

            tokio::spawn(async move {
                let mut stream = channel.into_stream();
                // Ends when either side closes. Nothing to report: a closed
                // database connection is the normal way for this to finish.
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            });
        }
    });

    Ok(Tunnel {
        local_port,
        forwarder,
    })
}

async fn authenticate(
    handle: &mut Handle<HostKeyCheck>,
    config: &SshConfig,
    secret: Option<&str>,
) -> Result<()> {
    let result = match config.auth {
        SshAuth::Password => {
            let password = secret.ok_or_else(|| {
                Error::SshSecretRequired(format!(
                    "{}@{} needs a password.",
                    config.user, config.host
                ))
            })?;
            handle
                .authenticate_password(&config.user, password)
                .await
                .map_err(|e| Error::Ssh(e.to_string()))?
        }
        SshAuth::Key => {
            let path = key_path(config)?;
            let key = load_secret_key(&path, secret).map_err(|e| key_error(&path, secret, e))?;
            // The hash algorithm only matters for RSA, and only the server can
            // say which one it accepts. Asking beats guessing SHA-1 and being
            // refused by every server that has turned it off.
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|e| Error::Ssh(e.to_string()))?
                .flatten();
            handle
                .authenticate_publickey(
                    &config.user,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .map_err(|e| Error::Ssh(e.to_string()))?
        }
    };

    if result.success() {
        return Ok(());
    }

    // A rejected secret and a missing one are fixed the same way, so both are
    // reported as "type it": the sheet reopens on the SSH field rather than
    // leaving a message the user can only read.
    Err(Error::SshSecretRequired(match config.auth {
        SshAuth::Password => format!(
            "{}@{} rejected the password.",
            config.user, config.host
        ),
        SshAuth::Key => format!(
            "{}@{} rejected the key. Check that its public half is in the account's authorized_keys.",
            config.user, config.host
        ),
    }))
}

/// The key to authenticate with, resolved to a path that exists.
fn key_path(config: &SshConfig) -> Result<PathBuf> {
    let named = config.key_path.trim();
    if !named.is_empty() {
        let path = expand_home(named);
        return match path.exists() {
            true => Ok(path),
            // Named and absent is a typo, not a reason to fall back to a
            // different key: authenticating as someone else's identity would
            // be a stranger failure than this one.
            false => Err(Error::Ssh(format!("no key at {}", path.display()))),
        };
    }

    let ssh_dir = home()?.join(".ssh");
    DEFAULT_KEYS
        .iter()
        .map(|name| ssh_dir.join(name))
        .find(|path| path.exists())
        .ok_or_else(|| {
            Error::Ssh(format!(
                "no key named, and none of {} in {}",
                DEFAULT_KEYS.join(", "),
                ssh_dir.display()
            ))
        })
}

/// Sorts a key that failed to load into "we need the passphrase" and
/// everything else, because only the first one has a way forward in the UI.
fn key_error(path: &PathBuf, secret: Option<&str>, error: russh::keys::Error) -> Error {
    use russh::keys::Error as KeyError;
    match error {
        KeyError::KeyIsEncrypted => Error::SshSecretRequired(format!(
            "{} is encrypted. Enter its passphrase.",
            path.display()
        )),
        // A key that decodes with no passphrase and fails with one is not
        // corrupt; the passphrase is wrong. Reported as such, since "the key
        // is corrupt" sends the user to regenerate a perfectly good key.
        KeyError::KeyIsCorrupt | KeyError::SshKey(_) if secret.is_some() => {
            Error::SshSecretRequired(format!(
                "The stored passphrase does not decrypt {}.",
                path.display()
            ))
        }
        other => Error::Ssh(format!("{}: {other}", path.display())),
    }
}

fn home() -> Result<PathBuf> {
    // `$HOME` on Unix, `%USERPROFILE%` on Windows. Both are what OpenSSH reads
    // on the same platform, so a path that works in a terminal works here.
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .map(PathBuf::from)
        .ok_or_else(|| Error::Ssh(format!("no home directory (${var} is unset)")))
}

/// Expands a leading `~`, which is what a user copies out of their SSH config
/// and what no filesystem call understands.
fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        Some(rest) => match home() {
            Ok(home) => home.join(rest),
            Err(_) => PathBuf::from(path),
        },
        None => PathBuf::from(path),
    }
}

/// Refuses any host key that `~/.ssh/known_hosts` does not already vouch for.
struct HostKeyCheck {
    host: String,
    port: u16,
    /// Only so the refusal can print the command that fixes it. A message that
    /// says what to run beats one that says what went wrong.
    user: String,
}

impl client::Handler for HostKeyCheck {
    type Error = Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool> {
        let fingerprint = server_public_key.fingerprint(Default::default());
        match russh::keys::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            // Told rather than asked. The user can record the key with the tool
            // that already does it correctly, and this app never becomes the
            // reason a host key was trusted without being looked at.
            Ok(false) => Err(Error::Ssh(format!(
                "{} is not in known_hosts (fingerprint {fingerprint}). \
                 Connect once with `ssh -p {} {}@{}` to record it, then try again.",
                self.host, self.port, self.user, self.host
            ))),
            Err(russh::keys::Error::KeyChanged { line }) => Err(Error::Ssh(format!(
                "{} presented a different host key than the one recorded at \
                 known_hosts line {line} (now {fingerprint}). \
                 Refusing to connect.",
                self.host
            ))),
            Err(e) => Err(Error::Ssh(e.to_string())),
        }
    }
}

impl From<russh::Error> for Error {
    fn from(e: russh::Error) -> Self {
        Error::Ssh(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(key_path: &str) -> SshConfig {
        SshConfig {
            host: "bastion".into(),
            port: 22,
            user: "deploy".into(),
            auth: SshAuth::Key,
            key_path: key_path.into(),
        }
    }

    /// A named key that is not there has to say so. Falling back to a default
    /// identity would authenticate as somebody the user did not name.
    #[test]
    fn refuses_a_named_key_that_does_not_exist() {
        let error = key_path(&config("/nowhere/id_ed25519")).unwrap_err();
        assert!(error.to_string().contains("/nowhere/id_ed25519"));
    }

    /// `~` is what people paste out of their SSH config, and no filesystem
    /// call expands it.
    #[test]
    fn expands_a_leading_tilde() {
        let home = home().expect("HOME is set in the test environment");
        assert_eq!(expand_home("~/.ssh/id_ed25519"), home.join(".ssh/id_ed25519"));
        // Only leading, and only as a path segment: a file actually named "~x"
        // is a file, not a home directory.
        assert_eq!(expand_home("/etc/~/key"), PathBuf::from("/etc/~/key"));
        assert_eq!(expand_home("~weird"), PathBuf::from("~weird"));
    }
}
