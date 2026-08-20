//! The Redis driver.
//!
//! The second driver, and the one the `Session` trait's refusing defaults were
//! shaped for: Redis has no schemas, no views, no functions, and no indexes it
//! would let a client read, so almost every catalogue method here is left
//! refusing on purpose rather than answered with a lie.
//!
//! What it does have is a flat key namespace, which is `list_keys`, and a
//! command protocol, which is `execute`.
//!
//! `bull` is a lens over that keyspace rather than a driver of its own. See
//! its own header for why BullMQ is not a third database.

pub mod bull;
mod command;
mod keyspace;
mod session;

use std::sync::Arc;

use async_trait::async_trait;

use crate::drivers::types::ConnectionConfig;
use crate::drivers::{Capabilities, Driver, Session};
use crate::error::{Error, Result};

pub use session::RedisSession;

pub const ID: &str = "redis";

/// What `database` means on a Redis connection.
///
/// Postgres names a database; Redis numbers one. The field is reused rather
/// than a second one added, because everything that already handles it — the
/// connection form, the derived-connection path that gives each database its
/// own session, credential inheritance through `parent_id` — works unchanged
/// once the number is parsed here.
///
/// Blank means "no database chosen", which is the same server-only state a
/// Postgres connection with a blank database is in, and produces the same
/// sidebar: a list to pick from.
pub fn db_index(config: &ConnectionConfig) -> Result<i64> {
    let raw = config.database.trim();
    if raw.is_empty() {
        return Ok(0);
    }
    // `db7` as well as `7`: the sidebar labels databases the way Redis's own
    // INFO does, and a label that cannot be typed back into the form is a
    // label that will be.
    let digits = raw.strip_prefix("db").unwrap_or(raw);
    digits
        .parse::<i64>()
        .map_err(|_| Error::other(format!("{raw} is not a database number")))
}

pub struct RedisDriver;

#[async_trait]
impl Driver for RedisDriver {
    fn id(&self) -> &'static str {
        ID
    }

    fn default_port(&self) -> u16 {
        6379
    }

    /// Almost all false, and that is the honest answer rather than a gap.
    ///
    /// `row_edit` is true because a key can be identified exactly — it *is* its
    /// own identity, which is a stronger guarantee than the primary key the
    /// Postgres path has to go looking for. `cancel` is false because Redis
    /// runs a command to completion and there is nothing to interrupt.
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            schemas: false,
            views: false,
            functions: false,
            indexes: false,
            row_edit: true,
            cancel: false,
            export: false,
            keyspace: true,
        }
    }

    async fn connect(
        &self,
        config: &ConnectionConfig,
        password: Option<&str>,
    ) -> Result<Arc<dyn Session>> {
        let db = db_index(config)?;

        // Built through the builder rather than formatted into a URL: a
        // password holding an `@` or a `/` survives this and does not survive
        // being pasted into `redis://user:pass@host`.
        let mut settings = redis::RedisConnectionInfo::default()
            .set_db(db)
            .set_lib_name("rashbase-studio", env!("CARGO_PKG_VERSION"));

        // Redis before 6 has no usernames and rejects the two-argument AUTH, and
        // "default" is the implicit account rather than one worth naming. Both
        // are sent as absent.
        match config.user.trim() {
            "" | "default" => {}
            user => settings = settings.set_username(user),
        }
        if let Some(pw) = password.filter(|p| !p.is_empty()) {
            settings = settings.set_password(pw);
        }

        // The address is the only way in: `ConnectionInfo` keeps its fields
        // private and has no `Default`, but a bare `ConnectionAddr` converts
        // into one that the builders then fill in.
        let info = redis::IntoConnectionInfo::into_connection_info(redis::ConnectionAddr::Tcp(
            config.host.clone(),
            config.port,
        ))?
        .set_redis_settings(settings);

        let client = redis::Client::open(info)?;
        let conn = client.get_multiplexed_async_connection().await?;

        Ok(Arc::new(
            RedisSession::open(conn, config.id.clone(), db).await?,
        ))
    }
}
