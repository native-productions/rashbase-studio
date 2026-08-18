//! What every driver speaks, and what the frontend receives.
//!
//! Nothing here is Postgres-specific. A type that only one driver can produce
//! belongs in that driver's own module; anything in this file is part of the
//! contract a second driver has to satisfy.

use serde::{Deserialize, Serialize};

/// What a connection saved before drivers existed must be.
fn default_driver() -> String {
    "postgres".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    /// Which driver opens this connection. Matches `Driver::id`.
    ///
    /// Defaulted rather than required: every `connections.json` written before
    /// there was more than one driver has no such field, and a saved connection
    /// that stops loading because the app grew a second database is not a
    /// migration the user should have to notice.
    #[serde(default = "default_driver")]
    pub driver: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    #[serde(default)]
    pub ssl_mode: SslMode,
    /// Free-form label used to tint the UI, e.g. "prod" turns the tab red.
    /// The one guardrail that stops a DELETE landing on the wrong server.
    #[serde(default)]
    pub environment: Option<String>,
    /// The connection this one was derived from by picking a database off its
    /// server, and which owns the credential both of them authenticate with.
    ///
    /// Switching database would otherwise mean copying the password into a
    /// second keystore entry per database, which is one more copy of a secret
    /// for every click. `None` on a connection the user typed themselves.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Set when the database is only reachable from inside another machine's
    /// network. The connection is opened against a local port that forwards
    /// over SSH instead of against `host` directly; `host` and `port` keep
    /// naming the database as the *jump host* sees it, which is what the user
    /// typed and what the tunnel asks for.
    #[serde(default)]
    pub ssh: Option<SshConfig>,
}

/// What the jump host is, and how to prove who we are to it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth: SshAuth,
    /// Private key to authenticate with, when `auth` is `Key`. `~` is expanded
    /// at connect time. Blank means "try the usual identity files", which is
    /// what the user means by leaving it empty.
    #[serde(default)]
    pub key_path: String,
}

fn default_ssh_port() -> u16 {
    22
}

/// Which secret the SSH side of a connection needs.
///
/// The secret itself is never in here: like the database password it lives in
/// the OS keystore and is resolved backend-side.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SshAuth {
    /// A private key, whose passphrase is the stored secret when it has one.
    #[default]
    Key,
    /// A password on the jump host account.
    Password,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: String,
    pub server_version: String,
    pub backend_pid: i32,
    pub current_database: String,
}

/// Display class for a column, derived from its type name.
///
/// Drives alignment and color in the grid. Kept coarse on purpose: the grid
/// needs to know "is this right-aligned and numeric-colored", not the exact OID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TypeClass {
    Number,
    Bool,
    Text,
    Temporal,
    Json,
    Binary,
    Uuid,
    Array,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
    pub type_class: TypeClass,
}

/// One result set. A script with several row-returning statements produces
/// several of these, in execution order.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    /// Row-major. `None` is SQL NULL, which the grid renders differently from
    /// the literal string "NULL" — a distinction most clients get wrong.
    pub rows: Vec<Vec<Option<String>>>,
    /// What the server said it produced, which for a `select` is the true row
    /// count even when `rows` holds fewer. That gap is the whole point of
    /// `truncated`: the footer can say "1,000 of 38,412" honestly.
    pub rows_affected: u64,
    /// Set when the row cap stopped this result short. Never a guess: it means
    /// rows arrived that were deliberately not kept.
    pub truncated: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaEntry {
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableEntry {
    pub name: String,
    pub kind: String,
    pub comment: Option<String>,
}

/// A row count and whether it can be trusted to the digit.
///
/// A planner estimate is free and stale; `count(*)` is exact and walks the
/// table. The UI shows the cheap one with a `~` and lets the user pay for the
/// precise one when they care.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowCount {
    pub value: i64,
    pub exact: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    /// What the server's own describe command would print, not the internal
    /// type name.
    pub data_type: String,
    pub not_null: bool,
    pub default: Option<String>,
    pub primary_key: bool,
    pub comment: Option<String>,
    /// Labels of the column's enum type, in declaration order.
    ///
    /// Empty for every other type, which is the whole test the frontend makes:
    /// a non-empty list is what turns the cell editor into a closed list rather
    /// than a text field. Scalar enums only — an array of enums would need the
    /// editor to compose an array literal, which is a different feature.
    #[serde(default)]
    pub enum_values: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    /// The server's own definition, verbatim. Reprinting it in our own words
    /// would only add a way to be wrong.
    pub definition: String,
    pub unique: bool,
    pub primary: bool,
}

/// A routine in a schema.
///
/// Keyed by `oid` rather than name: overloads share a name, and the oid is
/// stable for the life of the session, which is all the frontend needs it for.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionEntry {
    pub oid: i64,
    pub name: String,
    /// Identity arguments, as the server's own describe command would print them.
    pub args: String,
    pub returns: String,
    /// "function" or "procedure".
    pub kind: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every connection saved before there was more than one driver has no
    /// `driver` field. If this stops defaulting, the app opens with an empty
    /// sidebar and the user's saved connections look deleted.
    #[test]
    fn reads_a_connection_saved_before_drivers_existed() {
        let json = r#"{
            "id": "abc",
            "name": "local",
            "host": "localhost",
            "port": 5432,
            "user": "postgres",
            "database": "shop",
            "sslMode": "prefer",
            "environment": "local",
            "parentId": null
        }"#;
        let config: ConnectionConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.driver, "postgres");
        assert_eq!(config.database, "shop");
        // And nothing about it claims to be tunnelled.
        assert!(config.ssh.is_none());
    }

    /// The tunnel travels as camelCase like everything else on the wire, and a
    /// jump host saved without a port still has one. A `port: 0` here would
    /// send the tunnel at the wrong service with no error to explain it.
    #[test]
    fn reads_an_ssh_tunnel_off_the_wire() {
        let json = r#"{
            "id": "abc",
            "name": "prod",
            "host": "10.0.0.5",
            "port": 5432,
            "user": "app",
            "database": "shop",
            "ssh": { "host": "bastion.example.com", "user": "deploy", "auth": "key",
                     "keyPath": "~/.ssh/id_ed25519" }
        }"#;
        let config: ConnectionConfig = serde_json::from_str(json).unwrap();
        let ssh = config.ssh.expect("tunnel");
        assert_eq!(ssh.port, 22);
        assert_eq!(ssh.auth, SshAuth::Key);
        assert_eq!(ssh.key_path, "~/.ssh/id_ed25519");
    }

    /// And a file written after the field exists keeps what it says, rather
    /// than being quietly reset to the default on every read.
    #[test]
    fn keeps_the_driver_a_saved_connection_names() {
        let json = r#"{
            "id": "abc",
            "driver": "mysql",
            "name": "local",
            "host": "localhost",
            "port": 3306,
            "user": "root",
            "database": "shop"
        }"#;
        let config: ConnectionConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.driver, "mysql");
        // The optional fields fall back without needing to be written out.
        assert!(config.environment.is_none());
        assert!(config.parent_id.is_none());
    }
}
