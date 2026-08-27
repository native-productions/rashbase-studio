//! The write path, against a real Postgres.
//!
//! `build_update` is unit tested, but the property that actually decides
//! whether inline editing works cannot be asserted without a server: every
//! parameter is bound as **text** and cast in the statement, on the belief that
//! `cast(text as <type>)` runs that type's own input function for every type a
//! column can have. If that is wrong, editing a `jsonb`, a `numeric(10,2)` or a
//! `text[]` fails at the moment the user presses Enter, and the write path
//! needs a per-OID encode table instead.
//!
//! Also under test: the guarantees that stop an edit reaching the wrong row.
//! Refusing a view, refusing a table with no primary key, refusing an identity
//! that is not the primary key, and rolling back when the statement matched
//! anything other than one row.
//!
//! Skipped unless `RASHBASE_PG_PASSWORD` is set, so a normal `cargo test` on a
//! machine with no database still passes. Unlike the performance gate, this one
//! seeds and drops its own fixture, because the shape of the fixture is part of
//! what is being tested.
//!
//! ```sh
//! RASHBASE_PG_PASSWORD=... cargo test --test write_path -- --nocapture
//! ```

use rashbase_studio_lib::drivers::{ConnectionConfig, DbState, SslMode};

const FIXTURE: &str = r#"
drop view if exists rashbase_write_view;
drop table if exists rashbase_write_test;
drop table if exists rashbase_write_nokey;
drop table if exists rashbase_write_composite;

create table rashbase_write_test (
    id integer primary key,
    email text,
    amount numeric(10,2),
    created_at timestamptz,
    payload jsonb,
    tags text[],
    ratio double precision,
    ok boolean,
    uid uuid,
    note varchar(20)
);
insert into rashbase_write_test values
    (1, 'a@b.c', 1, now(), '{}', '{x}', 0.5, true,
     '00000000-0000-0000-0000-000000000001', 'n');

create table rashbase_write_nokey (level text, body text);
insert into rashbase_write_nokey values ('info', 'hello');

create table rashbase_write_composite (
    tenant uuid, seq bigint, note text,
    primary key (tenant, seq)
);
insert into rashbase_write_composite values
    ('123e4567-e89b-12d3-a456-426614174000', 7, 'before');

create view rashbase_write_view as select * from rashbase_write_test;
"#;

const TEARDOWN: &str = r#"
drop view if exists rashbase_write_view;
drop table if exists rashbase_write_test;
drop table if exists rashbase_write_nokey;
drop table if exists rashbase_write_composite;
"#;

fn env_config() -> Option<(ConnectionConfig, String)> {
    let password = std::env::var("RASHBASE_PG_PASSWORD").ok()?;
    Some((
        ConnectionConfig {
            id: "write-path".into(),
            driver: "postgres".into(),
            name: "write path".into(),
            host: std::env::var("RASHBASE_PG_HOST").unwrap_or_else(|_| "localhost".into()),
            port: std::env::var("RASHBASE_PG_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(5432),
            user: std::env::var("RASHBASE_PG_USER").unwrap_or_else(|_| "postgres".into()),
            database: std::env::var("RASHBASE_PG_DATABASE").unwrap_or_else(|_| "postgres".into()),
            ssl_mode: SslMode::Prefer,
            environment: Some("local".into()),
            parent_id: None,
        require_biometric: false,
            // These gates run against a database they can reach directly.
            ssh: None,
        },
        password,
    ))
}

fn key(column: &str, value: &str) -> (String, String) {
    (column.to_string(), value.to_string())
}

#[tokio::test(flavor = "multi_thread")]
async fn writes_every_type_and_refuses_every_ambiguous_row() {
    let Some((config, password)) = env_config() else {
        eprintln!("skipped: RASHBASE_PG_PASSWORD not set");
        return;
    };

    let db = DbState::default();
    db.connect(&config, Some(&password), None).await.unwrap();
    db.execute(&config.id, FIXTURE, None).await.unwrap();

    let id = &config.id;
    let pk = vec![key("id", "1")];

    /// One edit against the fixture, so the assertions below read as a table of
    /// "this text went in, this is what the database kept".
    async fn set(db: &DbState, id: &str, column: &str, value: &str) -> Option<String> {
        db.update_cell(id, "public", "rashbase_write_test", column, Some(value), &[key("id", "1")])
            .await
            .unwrap_or_else(|e| panic!("{column} rejected {value:?}: {e:?}"))
    }

    // A quote and a backslash are the two characters that would break an
    // interpolated statement. Bound, they are just data.
    assert_eq!(
        set(&db, id, "email", r"o'brien \n literal").await.as_deref(),
        Some(r"o'brien \n literal")
    );

    // The database rounds to the column's scale. Returning the stored value is
    // why the grid can show 123.46 rather than the 123.456 that was typed.
    assert_eq!(set(&db, id, "amount", "123.456").await.as_deref(), Some("123.46"));

    assert_eq!(
        set(&db, id, "created_at", "2026-01-02 03:04:05+00").await.as_deref(),
        Some("2026-01-02 03:04:05+00")
    );
    assert_eq!(
        set(&db, id, "payload", r#"{"a": [1, 2], "b": null}"#).await.as_deref(),
        Some(r#"{"a": [1, 2], "b": null}"#)
    );
    assert_eq!(set(&db, id, "tags", "{alpha,beta}").await.as_deref(), Some("{alpha,beta}"));
    assert_eq!(set(&db, id, "ratio", "0.125").await.as_deref(), Some("0.125"));
    assert_eq!(set(&db, id, "ok", "false").await.as_deref(), Some("false"));
    assert_eq!(
        set(&db, id, "uid", "123e4567-e89b-12d3-a456-426614174000").await.as_deref(),
        Some("123e4567-e89b-12d3-a456-426614174000")
    );
    assert_eq!(set(&db, id, "note", "short").await.as_deref(), Some("short"));

    // NULL and the empty string have to stay tellable apart the whole way down.
    let nulled = db
        .update_cell(id, "public", "rashbase_write_test", "email", None, &pk)
        .await
        .unwrap();
    assert_eq!(nulled, None);
    let emptied = db
        .update_cell(id, "public", "rashbase_write_test", "email", Some(""), &pk)
        .await
        .unwrap();
    assert_eq!(emptied.as_deref(), Some(""));

    // A value the type rejects comes back in the database's own words rather
    // than being coerced into something that was never asked for.
    let bad = db
        .update_cell(id, "public", "rashbase_write_test", "amount", Some("abc"), &pk)
        .await;
    assert!(bad.is_err(), "a non-numeric amount must be refused");

    // ---- Refusals -------------------------------------------------------
    //
    // In the same test rather than its own, because both halves seed the same
    // fixture tables and cargo runs tests concurrently by default.

    // A view has no rows of its own.
    let e = db
        .update_cell(id, "public", "rashbase_write_view", "email", Some("x"), &[key("id", "1")])
        .await
        .unwrap_err();
    assert!(format!("{e:?}").contains("not a table"));

    // No primary key: there is no `where` that provably means one row.
    let e = db
        .update_cell(id, "public", "rashbase_write_nokey", "body", Some("x"), &[key("level", "info")])
        .await
        .unwrap_err();
    assert!(format!("{e:?}").contains("no primary key"));

    // An identity that is not the primary key is refused even when it would
    // match: accepting it is how an edit turns into a rewrite of many rows.
    let e = db
        .update_cell(id, "public", "rashbase_write_test", "email", Some("x"), &[key("email", "a@b.c")])
        .await
        .unwrap_err();
    assert!(format!("{e:?}").contains("primary key"));

    // A partial composite key is the same failure wearing a disguise.
    let e = db
        .update_cell(
            id,
            "public",
            "rashbase_write_composite",
            "note",
            Some("x"),
            &[key("tenant", "123e4567-e89b-12d3-a456-426614174000")],
        )
        .await
        .unwrap_err();
    assert!(format!("{e:?}").contains("primary key"));

    // The whole composite key does work, and both parts reach the statement.
    let ok = db
        .update_cell(
            id,
            "public",
            "rashbase_write_composite",
            "note",
            Some("after"),
            &[
                key("tenant", "123e4567-e89b-12d3-a456-426614174000"),
                key("seq", "7"),
            ],
        )
        .await
        .unwrap();
    assert_eq!(ok.as_deref(), Some("after"));

    // A row that is no longer there rolls back and says so, rather than
    // reporting success for a write that touched nothing.
    let e = db
        .update_cell(id, "public", "rashbase_write_test", "email", Some("x"), &[key("id", "999")])
        .await
        .unwrap_err();
    assert!(format!("{e:?}").contains("no row matched"));

    let e = db
        .update_cell(id, "public", "rashbase_write_test", "email", Some("x"), &[key("id", "1")])
        .await;
    assert!(e.is_ok(), "the guards must not have broken the ordinary case");

    db.execute(&config.id, TEARDOWN, None).await.unwrap();
}
