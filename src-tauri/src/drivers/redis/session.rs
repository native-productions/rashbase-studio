//! One Redis session: a dedicated connection and everything run over it.
//!
//! One connection rather than a pool, for the same reason `PgSession` holds
//! one: a session is stateful. `SELECT n` picks the database for everything
//! after it, and a pool handing out a different connection per command would
//! silently run half the tab's work against database 0.

use async_trait::async_trait;
use redis::aio::MultiplexedConnection;
use tokio::sync::Mutex;

use crate::drivers::redis::command;
use crate::drivers::redis::keyspace;
use crate::drivers::types::{ConnectionInfo, KeyFilter, KeyPage, QueryResult};
use crate::drivers::Session;
use crate::error::{Error, Result};

pub struct RedisSession {
    /// `None` once closed. Taken out of the option rather than moved out of the
    /// session, because closing works through a shared reference: the session
    /// lives behind an `Arc` that in-flight commands also hold.
    conn: Mutex<Option<MultiplexedConnection>>,
    info: ConnectionInfo,
}

impl RedisSession {
    pub(super) async fn open(
        mut conn: MultiplexedConnection,
        id: String,
        db: i64,
    ) -> Result<Self> {
        // Two facts the status bar shows for every connection, asked once here
        // rather than on every render.
        let server: String = redis::cmd("INFO")
            .arg("server")
            .query_async(&mut conn)
            .await
            .unwrap_or_default();
        let client_id: i64 = redis::cmd("CLIENT")
            .arg("ID")
            .query_async(&mut conn)
            .await
            .unwrap_or(0);

        Ok(Self {
            conn: Mutex::new(Some(conn)),
            info: ConnectionInfo {
                id,
                server_version: format!("Redis {}", info_field(&server, "redis_version").unwrap_or_else(|| "?".into())),
                // Redis client ids outgrow i32 on a long-lived server. Truncating
                // is honest enough for a number the status bar only prints, and
                // the alternative is widening a field every other driver fills
                // with a real pid.
                backend_pid: client_id as i32,
                current_database: format!("db{db}"),
            },
        })
    }

    /// The live connection, or a refusal naming the session that no longer has
    /// one. The mirror of `PgSession::live`, and reached the same way: by a
    /// command that was already in flight when the user disconnected.
    fn live<'a>(
        &self,
        guard: &'a mut Option<MultiplexedConnection>,
    ) -> Result<&'a mut MultiplexedConnection> {
        guard
            .as_mut()
            .ok_or_else(|| Error::UnknownConnection(self.info.id.clone()))
    }
}

/// Pulls one `field:value` line out of an INFO section.
///
/// INFO is a text blob with `\r\n` separators and `#` section headings, and
/// parsing the two fields we want out of it beats pulling in a parser for a
/// format only this function reads.
fn info_field(blob: &str, field: &str) -> Option<String> {
    blob.lines()
        .find_map(|line| line.strip_prefix(field)?.strip_prefix(':'))
        .map(|v| v.trim().to_string())
}

#[async_trait]
impl Session for RedisSession {
    fn info(&self) -> &ConnectionInfo {
        &self.info
    }

    async fn close(&self) -> Result<()> {
        // Dropping the connection closes the socket. There is no graceful
        // terminate worth waiting on, and nothing left to tell the user.
        self.conn.lock().await.take();
        Ok(())
    }

    /// Runs typed commands, one per line.
    ///
    /// The counterpart of the Postgres driver's multi-statement script: several
    /// lines produce several result sets in order, which is the shape the tab
    /// strip already draws. Nothing is rewritten — what the user typed is what
    /// is sent, and the row cap trims the reply rather than the command.
    async fn execute(&self, script: &str, max_rows: Option<usize>) -> Result<Vec<QueryResult>> {
        let mut guard = self.conn.lock().await;
        let conn = self.live(&mut guard)?;
        let mut results = Vec::new();

        for line in script.lines() {
            let args = command::tokenize(line)?;
            let Some((name, rest)) = args.split_first() else {
                continue;
            };
            command::reject_if_blocking(name)?;

            let mut cmd = redis::cmd(name);
            for arg in rest {
                cmd.arg(arg);
            }

            let started = std::time::Instant::now();
            let value: redis::Value = cmd.query_async(&mut *conn).await?;
            let mut result =
                command::to_result(value, name, started.elapsed().as_millis() as u64);

            // Trimmed after the fact, not with a COUNT bolted onto the command:
            // rewriting what someone typed would make the console lie about what
            // it ran. `rows_affected` keeps the real count, so the footer can
            // still say "200 of 40,000".
            if let Some(max) = max_rows {
                if result.rows.len() > max {
                    result.rows.truncate(max);
                    result.truncated = true;
                }
            }
            results.push(result);
        }

        Ok(results)
    }

    async fn list_keys(&self, filter: &KeyFilter, cursor: u64, limit: usize) -> Result<KeyPage> {
        let mut guard = self.conn.lock().await;
        keyspace::list_keys(self.live(&mut guard)?, filter, cursor, limit).await
    }

    async fn delete_keys(&self, keys: &[String]) -> Result<u64> {
        let mut guard = self.conn.lock().await;
        keyspace::delete_keys(self.live(&mut guard)?, keys).await
    }

    /// Databases on this server, as `db0 … dbN`.
    ///
    /// From `CONFIG GET databases`, falling back to Redis's own default of 16
    /// when the command is disabled, which managed hosts often do. Every
    /// database is listed rather than only the populated ones: an empty
    /// database is somewhere to write, and a picker that hides it would make
    /// that unreachable.
    async fn list_databases(&self) -> Result<Vec<String>> {
        let mut guard = self.conn.lock().await;
        let conn = self.live(&mut guard)?;

        let count: i64 = redis::cmd("CONFIG")
            .arg("GET")
            .arg("databases")
            .query_async::<(String, String)>(&mut *conn)
            .await
            .ok()
            .and_then(|(_, v)| v.parse().ok())
            .unwrap_or(16);

        Ok((0..count.clamp(1, 1024)).map(|n| format!("db{n}")).collect())
    }

    /// Writes one field of one key.
    ///
    /// `schema` and `table` are ignored: a key is its own identity, which is a
    /// stronger guarantee than the primary key the Postgres path has to go
    /// looking for in the catalogue. `keys` carries exactly one pair naming the
    /// key, and `column` says which of the row's fields is being written.
    ///
    /// Returns what Redis actually holds afterwards rather than what was typed,
    /// so the grid cannot end up disagreeing with the server.
    async fn update_cell(
        &self,
        _schema: &str,
        _table: &str,
        column: &str,
        value: Option<&str>,
        keys: &[(String, String)],
    ) -> Result<Option<String>> {
        let key = keys
            .iter()
            .find(|(name, _)| name == "key")
            .map(|(_, v)| v.clone())
            .ok_or_else(|| Error::other("no key names the row to write"))?;

        let mut guard = self.conn.lock().await;
        let conn = self.live(&mut guard)?;

        match column {
            "ttl" => write_ttl(conn, &key, value).await,
            "value" => write_value(conn, &key, value).await,
            // The other columns describe the key rather than hold it. Renaming
            // through a cell edit would be a different operation wearing the
            // same gesture, and a silent copy-and-delete at that.
            "key" => Err(Error::other(
                "A key cannot be renamed here. Delete it and write it under the new name.",
            )),
            other => Err(Error::other(format!("{other} is not writable"))),
        }
    }
}

/// Sets or clears an expiry.
///
/// Blank and NULL both mean "no expiry", because both are how a person says it
/// in a field that currently reads `-1`.
async fn write_ttl(
    conn: &mut MultiplexedConnection,
    key: &str,
    value: Option<&str>,
) -> Result<Option<String>> {
    let trimmed = value.map(str::trim).unwrap_or("");

    if trimmed.is_empty() || trimmed == "-1" {
        redis::cmd("PERSIST").arg(key).query_async::<i64>(conn).await?;
    } else {
        let seconds: i64 = trimmed
            .parse()
            .map_err(|_| Error::other(format!("{trimmed} is not a number of seconds")))?;
        if seconds <= 0 {
            return Err(Error::other(
                "A TTL of zero or less would delete the key. Use the delete gesture instead.",
            ));
        }
        redis::cmd("EXPIRE")
            .arg(key)
            .arg(seconds)
            .query_async::<i64>(conn)
            .await?;
    }

    let ttl: i64 = redis::cmd("TTL").arg(key).query_async(conn).await?;
    Ok(Some(ttl.to_string()))
}

/// Writes a key's value, by whatever means its type allows.
///
/// Strings are set outright. A hash is written as a document: the JSON the row
/// panel handed back is diffed against what is stored, and only the fields that
/// actually changed move. That is what makes the existing JSON editor a Redis
/// editor without it learning a single Redis command.
async fn write_value(
    conn: &mut MultiplexedConnection,
    key: &str,
    value: Option<&str>,
) -> Result<Option<String>> {
    let kind: String = redis::cmd("TYPE").arg(key).query_async(conn).await?;

    match kind.as_str() {
        "string" | "none" => {
            let Some(text) = value else {
                return Err(Error::other(
                    "A string key has no NULL. Delete the key instead.",
                ));
            };
            // KEEPTTL, because editing a value is not a decision about when it
            // expires, and silently resetting the expiry on every save is the
            // kind of surprise that costs someone a cache.
            redis::cmd("SET")
                .arg(key)
                .arg(text)
                .arg("KEEPTTL")
                .query_async::<redis::Value>(conn)
                .await?;
            Ok(Some(text.to_string()))
        }

        "hash" => {
            let text = value.unwrap_or("{}");
            let next: serde_json::Map<String, serde_json::Value> = serde_json::from_str(text)
                .map_err(|e| Error::other(format!("A hash has to be a JSON object: {e}")))?;

            let current: std::collections::HashMap<String, String> =
                redis::cmd("HGETALL").arg(key).query_async(conn).await?;

            // Only what moved. A hash of two hundred fields where one changed
            // should be one HSET, not two hundred.
            let mut pipe = redis::pipe();
            let mut touched = false;
            for (field, raw) in &next {
                let text = match raw {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                if current.get(field) != Some(&text) {
                    pipe.cmd("HSET").arg(key).arg(field).arg(&text);
                    touched = true;
                }
            }
            for field in current.keys() {
                if !next.contains_key(field) {
                    pipe.cmd("HDEL").arg(key).arg(field);
                    touched = true;
                }
            }
            if touched {
                pipe.query_async::<redis::Value>(conn).await?;
            }

            let stored: redis::Value = redis::cmd("HGETALL").arg(key).query_async(conn).await?;
            Ok(Some(keyspace::preview_of(&stored, "hash")))
        }

        other => Err(Error::other(format!(
            "Editing a {other} is not supported yet. Use the command console: \
             a {other} is changed by its own commands rather than by rewriting it whole."
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::info_field;

    /// INFO is `\r\n` separated with `#` section headings, and the version is
    /// the one field the status bar shows on every Redis connection.
    #[test]
    fn reads_a_field_out_of_an_info_blob() {
        let blob = "# Server\r\nredis_version:7.2.4\r\nos:Darwin\r\n";
        assert_eq!(info_field(blob, "redis_version").as_deref(), Some("7.2.4"));
        assert_eq!(info_field(blob, "os").as_deref(), Some("Darwin"));
        assert_eq!(info_field(blob, "nothing_here"), None);
    }
}
