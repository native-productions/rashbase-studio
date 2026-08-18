//! The PostgreSQL driver.

mod catalog;
mod dump;
mod session;
mod sql;
mod types;

use std::sync::Arc;

use async_trait::async_trait;
use sqlx::postgres::{PgConnectOptions, PgConnection};
use sqlx::{ConnectOptions, Connection, Row};

use crate::drivers::types::{ConnectionConfig, ConnectionInfo};
use crate::drivers::{Capabilities, Driver, Session};
use crate::error::Result;

pub use session::PgSession;

pub const ID: &str = "postgres";

pub struct PgDriver;

#[async_trait]
impl Driver for PgDriver {
    fn id(&self) -> &'static str {
        ID
    }

    fn default_port(&self) -> u16 {
        5432
    }

    /// Postgres answers all of it, which is why the client was built against it
    /// first: the catalogue is complete enough that nothing here is a guess.
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            schemas: true,
            views: true,
            functions: true,
            indexes: true,
            row_edit: true,
            cancel: true,
            export: true,
        }
    }

    async fn connect(
        &self,
        config: &ConnectionConfig,
        password: Option<&str>,
    ) -> Result<Arc<dyn Session>> {
        let mut options = PgConnectOptions::new()
            .host(&config.host)
            .port(config.port)
            .username(&config.user)
            .database(&config.database)
            .ssl_mode(config.ssl_mode.into())
            .application_name("Rashbase Studio")
            // Query logging is noise for an interactive client; the UI already
            // shows every statement the user ran.
            .disable_statement_logging();

        if let Some(pw) = password {
            options = options.password(pw);
        }

        let mut conn = PgConnection::connect_with(&options).await?;

        let row = sqlx::query("select pg_backend_pid(), version(), current_database()")
            .fetch_one(&mut conn)
            .await?;
        let info = ConnectionInfo {
            id: config.id.clone(),
            backend_pid: row.try_get::<i32, _>(0)?,
            server_version: row.try_get::<String, _>(1)?,
            current_database: row.try_get::<String, _>(2)?,
        };

        Ok(Arc::new(PgSession::new(conn, options, info)))
    }
}
