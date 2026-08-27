//! The SSH tunnel, against a real jump host.
//!
//! Everything below the tunnel is already covered elsewhere; what is under test
//! here is the part that only a real SSH server can answer:
//!
//! 1. **The forward carries a session.** The driver connects to a loopback
//!    port, and what comes back is the database on the far side, not a hang.
//!
//! 2. **The tunnel outlives the first connection.** `cancel` opens a *second*
//!    connection to the same address while the first is busy, so a forwarder
//!    that only ever serves one client would break query cancellation and
//!    nothing else, which is the kind of bug that shows up in production.
//!
//! Skipped unless `RASHBASE_SSH_HOST` is set, so a normal `cargo test` on a
//! machine with no jump host still passes. The host must already be in
//! `~/.ssh/known_hosts`; the tunnel refuses unknown hosts by design.
//!
//! ```sh
//! RASHBASE_SSH_HOST=bastion.example.com \
//! RASHBASE_SSH_USER=deploy \
//! RASHBASE_PG_HOST=10.0.0.5 \
//! RASHBASE_PG_PASSWORD=... \
//!   cargo test --test ssh_tunnel -- --nocapture
//! ```
//!
//! Optional: `RASHBASE_SSH_PORT` (22), `RASHBASE_SSH_KEY` (the usual ones in
//! `~/.ssh`), `RASHBASE_SSH_SECRET` (the key's passphrase), `RASHBASE_PG_PORT`
//! (5432), `RASHBASE_PG_USER` (postgres), `RASHBASE_PG_DATABASE` (postgres).

use rashbase_studio_lib::drivers::{ConnectionConfig, DbState, SshAuth, SshConfig, SslMode};

fn env_config() -> Option<(ConnectionConfig, String, Option<String>)> {
    let ssh_host = std::env::var("RASHBASE_SSH_HOST").ok()?;
    let password = std::env::var("RASHBASE_PG_PASSWORD").ok()?;
    let var = |name: &str, fallback: &str| {
        std::env::var(name).unwrap_or_else(|_| fallback.to_string())
    };

    Some((
        ConnectionConfig {
            id: "ssh-tunnel".into(),
            driver: "postgres".into(),
            name: "ssh tunnel".into(),
            // As the jump host sees it, which is the whole point: this address
            // is not expected to resolve from here.
            host: var("RASHBASE_PG_HOST", "localhost"),
            port: var("RASHBASE_PG_PORT", "5432").parse().unwrap_or(5432),
            user: var("RASHBASE_PG_USER", "postgres"),
            database: var("RASHBASE_PG_DATABASE", "postgres"),
            // Not `verify-*`: through a tunnel the driver dials 127.0.0.1 and
            // certificate hostname verification can never match.
            ssl_mode: SslMode::Prefer,
            environment: None,
            parent_id: None,
        require_biometric: false,
            ssh: Some(SshConfig {
                host: ssh_host,
                port: var("RASHBASE_SSH_PORT", "22").parse().unwrap_or(22),
                user: var("RASHBASE_SSH_USER", "root"),
                auth: SshAuth::Key,
                key_path: var("RASHBASE_SSH_KEY", ""),
            }),
        },
        password,
        std::env::var("RASHBASE_SSH_SECRET").ok(),
    ))
}

#[tokio::test(flavor = "multi_thread")]
async fn opens_a_session_through_the_tunnel() {
    let Some((config, password, secret)) = env_config() else {
        eprintln!("skipped: RASHBASE_SSH_HOST or RASHBASE_PG_PASSWORD not set");
        return;
    };

    let db = DbState::default();
    let info = db
        .connect(&config, Some(&password), secret.as_deref())
        .await
        .expect("tunnel opened and the database answered through it");
    eprintln!("connected through the tunnel to {}", info.server_version);

    let results = db
        .execute(&config.id, "select 1 as one", None)
        .await
        .unwrap();
    assert_eq!(results[0].rows, vec![vec![Some("1".to_string())]]);

    // The second connection. `cancel` reaches the same forwarder while the
    // first one is still open, which is what a one-shot forward would fail.
    db.cancel(&config.id)
        .await
        .expect("a second connection reached the same tunnel");

    db.disconnect(&config.id).await.unwrap();

    // And once the session is gone so is the tunnel, so the loopback port it
    // was listening on is no longer anybody's.
    assert!(db.execute(&config.id, "select 1", None).await.is_err());
}
