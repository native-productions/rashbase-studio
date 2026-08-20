use serde::Serialize;

/// Everything that crosses the IPC boundary as a failure.
///
/// Serialized as a flat object so the frontend always handles one shape:
/// `{ message, code, detail, hint, position }`. `position` is the 1-based
/// character offset Postgres reports for syntax errors, which the editor uses
/// to place the error marker.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{message}")]
    Db {
        message: String,
        code: Option<String>,
        detail: Option<String>,
        hint: Option<String>,
        position: Option<u32>,
    },

    #[error("connection {0} is not open")]
    UnknownConnection(String),

    /// The driver behind this session has no such concept. Not a failure: a
    /// key-value store has no schemas, and saying so is the honest answer.
    #[error("this database does not support {0}")]
    Unsupported(&'static str),

    #[error("credential store: {0}")]
    Keyring(String),

    /// A secret is stored but this build cannot read it. Carries the platform's
    /// own words as the hint, since the OS message ("the passphrase you
    /// entered is not correct") describes an access-control failure, not a
    /// wrong password, and on its own sends the user hunting for the wrong bug.
    #[error("Saved password could not be read from the keychain. Enter it again to reconnect.")]
    CredentialUnreadable(String),

    /// The tunnel could not be built. Carries the SSH layer's own words for
    /// the same reason the Postgres errors do: "Permission denied (publickey)"
    /// tells the user which of six things went wrong, "could not connect"
    /// tells them nothing.
    #[error("SSH: {0}")]
    Ssh(String),

    /// The tunnel needs a secret that is not stored: an encrypted key with no
    /// passphrase on file, a passphrase that no longer decrypts the key, or a
    /// jump host that rejected the password. All three are fixed the same way,
    /// by typing it, so they are one variant with the reason in the message.
    #[error("{0}")]
    SshSecretRequired(String),

    /// The person at the keyboard did not confirm they are there — Touch ID
    /// was cancelled, refused, or is not available. Carries the platform's own
    /// words, and is coded so the frontend can tell it apart from a connection
    /// that failed: this one must not reopen the sheet asking for a password,
    /// because the password was never the problem.
    #[error("{0}")]
    AuthRefused(String),

    /// The user stopped an export while it was running. Coded so the frontend
    /// can say "stopped" rather than showing it as a failure: nothing went
    /// wrong, and the partial file has already been removed.
    #[error("Export stopped.")]
    Cancelled,

    #[error("{0}")]
    Other(String),
}

impl Error {
    pub fn other(msg: impl Into<String>) -> Self {
        Error::Other(msg.into())
    }
}

impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        // Pull apart the Postgres error so the UI can point at the offending
        // token instead of dumping a one-line string.
        if let sqlx::Error::Database(db) = &e {
            let pg = db.downcast_ref::<sqlx::postgres::PgDatabaseError>();
            return Error::Db {
                message: pg.message().to_string(),
                code: Some(pg.code().to_string()),
                detail: pg.detail().map(str::to_string),
                hint: pg.hint().map(str::to_string),
                position: match pg.position() {
                    Some(sqlx::postgres::PgErrorPosition::Original(p)) => Some(p as u32),
                    _ => None,
                },
            };
        }
        Error::Db {
            message: e.to_string(),
            code: None,
            detail: None,
            hint: None,
            position: None,
        }
    }
}

/// Redis errors carry the server's own words, like the Postgres ones do.
///
/// `code` is the error class Redis puts at the front of its reply — WRONGTYPE,
/// NOAUTH, READONLY — pulled out so the UI can show it the same way it shows a
/// Postgres SQLSTATE. There is no statement position to report: Redis rejects a
/// command as a whole, never at a character offset.
impl From<redis::RedisError> for Error {
    fn from(e: redis::RedisError) -> Self {
        Error::Db {
            message: e.detail().unwrap_or_else(|| e.category()).to_string(),
            code: e.code().map(str::to_string),
            detail: None,
            hint: None,
            position: None,
        }
    }
}

impl From<keyring::Error> for Error {
    fn from(e: keyring::Error) -> Self {
        Error::Keyring(e.to_string())
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Other(e.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Other(e.to_string())
    }
}

/// Error code for a credential that exists but cannot be read. The frontend
/// matches on this string to reopen the connection sheet.
pub const CREDENTIAL_UNREADABLE: &str = "CREDENTIAL_UNREADABLE";

/// Error code for a tunnel that stopped for want of a passphrase or password.
/// The frontend matches on it to reopen the sheet with the SSH secret focused,
/// rather than on the database password the user did not get asked for.
pub const SSH_SECRET_REQUIRED: &str = "SSH_SECRET_REQUIRED";

/// Error code for a refused or cancelled Touch ID prompt. The frontend matches
/// on it to report the refusal plainly instead of treating it as a broken
/// credential.
pub const AUTH_REFUSED: &str = "AUTH_REFUSED";

/// Error code for work the user stopped on purpose. The frontend matches on it
/// to close quietly instead of raising an error toast.
pub const CANCELLED: &str = "CANCELLED";

/// The single shape every rejected command produces. Keeping it flat means the
/// frontend has one error branch, not one per failure mode.
#[derive(Serialize)]
struct ErrorPayload<'a> {
    message: String,
    code: Option<&'a str>,
    detail: Option<&'a str>,
    hint: Option<&'a str>,
    position: Option<u32>,
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let payload = match self {
            Error::Db {
                code,
                detail,
                hint,
                position,
                ..
            } => ErrorPayload {
                message: self.to_string(),
                code: code.as_deref(),
                detail: detail.as_deref(),
                hint: hint.as_deref(),
                position: *position,
            },
            // Coded so the frontend can reopen the connection sheet rather than
            // leaving the user with a toast and no way forward.
            Error::CredentialUnreadable(platform) => ErrorPayload {
                message: self.to_string(),
                code: Some(CREDENTIAL_UNREADABLE),
                detail: None,
                hint: Some(platform),
                position: None,
            },
            Error::Cancelled => ErrorPayload {
                message: self.to_string(),
                code: Some(CANCELLED),
                detail: None,
                hint: None,
                position: None,
            },
            Error::AuthRefused(_) => ErrorPayload {
                message: self.to_string(),
                code: Some(AUTH_REFUSED),
                detail: None,
                hint: None,
                position: None,
            },
            Error::SshSecretRequired(_) => ErrorPayload {
                message: self.to_string(),
                code: Some(SSH_SECRET_REQUIRED),
                detail: None,
                hint: None,
                position: None,
            },
            _ => ErrorPayload {
                message: self.to_string(),
                code: None,
                detail: None,
                hint: None,
                position: None,
            },
        };
        payload.serialize(s)
    }
}

pub type Result<T> = std::result::Result<T, Error>;
