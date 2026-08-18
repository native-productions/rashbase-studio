//! The export path, against a real Postgres.
//!
//! The unit tests in `dump.rs` pin the statements this composes. They cannot
//! answer the only question that matters about an export, which is whether the
//! file **restores**: whether a dump of a schema carrying identity columns,
//! generated columns, enums, arrays, `bytea`, and a foreign key can be replayed
//! into an empty database and produce the same rows back.
//!
//! So this dumps a deliberately awkward fixture, drops it, replays the dump,
//! and compares. Anything the composer gets wrong — a missing type, a foreign
//! key emitted before the key it points at, an identity that refuses its own
//! values, a backslash that changed meaning — fails here and nowhere else.
//!
//! Skipped unless `RASHBASE_PG_PASSWORD` is set, so a normal `cargo test` on a
//! machine with no database still passes.
//!
//! ```sh
//! RASHBASE_PG_PASSWORD=... cargo test --test export_path -- --nocapture
//! ```

use std::io;

use rashbase_studio_lib::drivers::{
    ConnectionConfig, DbState, DumpWriter, ExportFormat, ExportLayout, ExportMode, ExportRequest,
    ObjectRef, SslMode,
};

const TEARDOWN: &str = "drop schema if exists rashbase_export cascade;";

/// Every shape that has its own way of failing a restore, in one schema.
const FIXTURE: &str = r#"
drop schema if exists rashbase_export cascade;
create schema rashbase_export;

create type rashbase_export.mood as enum ('sad', 'ok', 'glad');

create table rashbase_export.parent (
    id integer generated always as identity primary key,
    label text not null unique
);

create table rashbase_export.child (
    id bigserial primary key,
    parent_id integer not null references rashbase_export.parent(id),
    email text,
    amount numeric(10,2),
    payload jsonb,
    tags text[],
    blob bytea,
    feeling rashbase_export.mood,
    feelings rashbase_export.mood[],
    at timestamptz,
    qty integer not null default 1,
    price numeric(10,2) not null default 0,
    total numeric generated always as (qty * price) stored,
    constraint child_qty_positive check (qty > 0)
);

create index child_email_idx on rashbase_export.child (email);
comment on table rashbase_export.child is 'rows that go out';
comment on column rashbase_export.child.email is 'contact';

insert into rashbase_export.parent (label) values ('one'), ('two');

insert into rashbase_export.child
    (parent_id, email, amount, payload, tags, blob, feeling, feelings, at, qty, price)
values
    (1, 'o''brien \n not-an-escape, "quoted"', 123.46, '{"a": 1}', '{x,y}',
     '\x00ff41'::bytea, 'glad', '{sad,ok}', '2026-08-18 10:00:00+00', 2, 1.50),
    (2, null, null, null, null, null, null, null, null, 1, 0);

create view rashbase_export.summary as
    select id, email from rashbase_export.child;
"#;

/// A `DumpWriter` that keeps the parts in memory, so the test can read the file
/// the user would have got.
#[derive(Default)]
struct Buffer {
    parts: Vec<(String, Vec<u8>)>,
}

impl Buffer {
    fn only(&self) -> String {
        assert_eq!(
            self.parts.len(),
            1,
            "expected one part, got {}",
            self.parts.len()
        );
        String::from_utf8(self.parts[0].1.clone()).expect("utf-8")
    }

    fn named(&self, name: &str) -> String {
        let part = self
            .parts
            .iter()
            .find(|(n, _)| n == name)
            .unwrap_or_else(|| panic!("no part named {name}; have {:?}", self.names()));
        String::from_utf8(part.1.clone()).expect("utf-8")
    }

    fn names(&self) -> Vec<&str> {
        self.parts.iter().map(|(n, _)| n.as_str()).collect()
    }
}

impl DumpWriter for Buffer {
    fn begin(&mut self, name: &str) -> io::Result<()> {
        self.parts.push((name.to_string(), Vec::new()));
        Ok(())
    }

    fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.parts
            .last_mut()
            .expect("begin before write")
            .1
            .extend_from_slice(bytes);
        Ok(())
    }

    fn progress(&mut self, _table: &str, _done: usize, _total: usize) {}
}

fn object(name: &str, kind: &str) -> ObjectRef {
    ObjectRef {
        schema: "rashbase_export".to_string(),
        name: name.to_string(),
        kind: kind.to_string(),
    }
}

fn request(objects: Vec<ObjectRef>, format: ExportFormat, mode: ExportMode) -> ExportRequest {
    ExportRequest {
        objects,
        format,
        mode,
        drop_if_exists: false,
        layout: ExportLayout::Single,
        compress: false,
        directory: String::new(),
        file_name: "fixture".to_string(),
    }
}

fn env_config() -> Option<(ConnectionConfig, String)> {
    let password = std::env::var("RASHBASE_PG_PASSWORD").ok()?;
    Some((
        ConnectionConfig {
            id: "export-path".into(),
            driver: "postgres".into(),
            name: "export path".into(),
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
            ssh: None,
        },
        password,
    ))
}

/// One scalar off the fixture, as text, so before and after can be compared
/// without a decode table in the test.
async fn scalar(db: &DbState, id: &str, sql: &str) -> Option<String> {
    let results = db.execute(id, sql, None).await.unwrap_or_else(|e| {
        panic!("{sql} failed: {e:?}");
    });
    results
        .first()
        .and_then(|r| r.rows.first())
        .and_then(|row| row.first())
        .cloned()
        .flatten()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dump_restores_into_an_empty_database() {
    let Some((config, password)) = env_config() else {
        eprintln!("skipped: RASHBASE_PG_PASSWORD not set");
        return;
    };

    let db = DbState::default();
    db.connect(&config, Some(&password), None).await.unwrap();
    db.execute(&config.id, FIXTURE, None).await.unwrap();
    let id = &config.id;

    // What the fixture holds, read before the dump so the comparison after the
    // restore is against the database's own rendering rather than the literal
    // the fixture typed.
    let before_email = scalar(
        &db,
        id,
        "select email from rashbase_export.child where id = 1",
    )
    .await;
    let before_blob = scalar(
        &db,
        id,
        "select blob::text from rashbase_export.child where id = 1",
    )
    .await;
    let before_total = scalar(
        &db,
        id,
        "select total::text from rashbase_export.child where id = 1",
    )
    .await;

    // The child is named *first* on purpose. Its foreign key points at the
    // parent's primary key, so a dump that emitted constraints relation by
    // relation would place that key before the one it needs and fail below.
    let mut file = Buffer::default();
    db.export(
        id,
        "job",
        &request(
            vec![
                object("child", "table"),
                object("parent", "table"),
                object("summary", "view"),
            ],
            ExportFormat::Sql,
            ExportMode::Full,
        ),
        &mut file,
    )
    .await
    .unwrap();

    let sql = file.only();
    if std::env::var("RASHBASE_DUMP_DEBUG").is_ok() {
        eprintln!("{sql}");
    }

    // The pieces a restore cannot do without, each of which fails differently
    // when it is missing.
    assert!(sql.contains("CREATE TYPE \"rashbase_export\".\"mood\" AS ENUM ('sad', 'ok', 'glad');"));
    assert!(sql.contains("GENERATED ALWAYS AS IDENTITY"));
    // Postgres normalises the expression it stored, so only the declaration
    // shape is asserted; the value it produces is checked after the restore.
    assert!(sql.contains("GENERATED ALWAYS AS ((") && sql.contains(") STORED"));
    assert!(sql.contains("OVERRIDING SYSTEM VALUE"));
    assert!(sql.contains("CREATE SEQUENCE \"rashbase_export\".\"child_id_seq\""));
    assert!(sql.contains("COMMENT ON TABLE \"rashbase_export\".\"child\" IS 'rows that go out';"));
    assert!(sql.contains("CREATE VIEW \"rashbase_export\".\"summary\" AS"));
    assert!(sql.contains("pg_catalog.setval("));

    // A generated column cannot be written, so naming it in an insert would
    // fail every row.
    assert!(!sql.contains("\"total\") VALUES") && !sql.contains(", \"total\","));
    // A view's rows belong to its query; dumping them would restore a copy that
    // stops agreeing with its own definition.
    assert!(!sql.contains("INSERT INTO \"rashbase_export\".\"summary\""));

    // Foreign keys come after every key they could point at, whatever order the
    // relations were named in.
    let fk = sql.find("FOREIGN KEY").expect("a foreign key");
    let parent_pk = sql
        .find("\"parent\" ADD CONSTRAINT \"parent_pkey\"")
        .expect("the parent's primary key");
    assert!(
        parent_pk < fk,
        "the foreign key was written before the key it needs"
    );

    // ---- What each mode and layout writes ---------------------------------
    //
    // Read-only, so it runs against the fixture before the restore below
    // replaces it. One test rather than two: they share a schema, and two
    // tests dropping and recreating the same one race each other.

    let objects = vec![object("parent", "table"), object("child", "table")];

    let mut structure = Buffer::default();
    db.export(
        id,
        "job-structure",
        &request(objects.clone(), ExportFormat::Sql, ExportMode::Structure),
        &mut structure,
    )
    .await
    .unwrap();
    let structure_only = structure.only();
    assert!(structure_only.contains("CREATE TABLE"));
    assert!(!structure_only.contains("INSERT INTO"));

    let mut data = Buffer::default();
    db.export(
        id,
        "job-data",
        &request(objects.clone(), ExportFormat::Sql, ExportMode::Data),
        &mut data,
    )
    .await
    .unwrap();
    let data_only = data.only();
    assert!(data_only.contains("INSERT INTO \"rashbase_export\".\"child\""));
    assert!(!data_only.contains("CREATE TABLE"));
    assert!(!data_only.contains("ADD CONSTRAINT"));

    // One file per relation, each self-contained.
    let mut split = Buffer::default();
    let mut req = request(objects.clone(), ExportFormat::Sql, ExportMode::Full);
    req.layout = ExportLayout::PerTable;
    db.export(id, "job-split", &req, &mut split).await.unwrap();
    assert_eq!(
        split.names(),
        vec!["rashbase_export.parent", "rashbase_export.child"]
    );
    let child = split.named("rashbase_export.child");
    assert!(child.contains("CREATE TABLE \"rashbase_export\".\"child\""));
    assert!(!child.contains("CREATE TABLE \"rashbase_export\".\"parent\""));

    // CSV is the server's own formatting, header row included, one table a file.
    let mut csv = Buffer::default();
    let mut req = request(
        vec![object("child", "table")],
        ExportFormat::Csv,
        ExportMode::Data,
    );
    req.layout = ExportLayout::PerTable;
    db.export(id, "job-csv", &req, &mut csv).await.unwrap();
    let rows = csv.named("rashbase_export.child");
    assert!(rows.starts_with("id,parent_id,email,"));
    // The value holds a comma and a quote, so it has to come back quoted.
    assert!(rows.contains(r#""o'brien \n not-an-escape, ""quoted""""#));

    // Several tables into one CSV would be several header rows glued together.
    let mut refused = Buffer::default();
    let mut req = request(objects, ExportFormat::Csv, ExportMode::Data);
    req.layout = ExportLayout::Single;
    assert!(db.export(id, "job-bad", &req, &mut refused).await.is_err());

    // ---- The restore ------------------------------------------------------

    // The real test: throw the schema away and replay the file.
    db.execute(id, TEARDOWN, None).await.unwrap();
    db.execute(id, "create schema rashbase_export;", None)
        .await
        .unwrap();
    db.execute(id, &sql, None)
        .await
        .unwrap_or_else(|e| panic!("the dump did not restore: {e:?}"));

    assert_eq!(
        scalar(&db, id, "select count(*)::text from rashbase_export.child").await,
        Some("2".to_string())
    );

    // A quote, a backslash, and a comma inside a value: the three characters
    // that break an exporter that quotes on the client.
    assert_eq!(
        scalar(
            &db,
            id,
            "select email from rashbase_export.child where id = 1"
        )
        .await,
        before_email
    );
    assert_eq!(
        scalar(
            &db,
            id,
            "select blob::text from rashbase_export.child where id = 1"
        )
        .await,
        before_blob
    );
    // Recomputed from the restored inputs, never carried across.
    assert_eq!(
        scalar(
            &db,
            id,
            "select total::text from rashbase_export.child where id = 1"
        )
        .await,
        before_total
    );
    assert_eq!(
        scalar(
            &db,
            id,
            "select feeling::text from rashbase_export.child where id = 1"
        )
        .await,
        Some("glad".to_string())
    );
    assert_eq!(
        scalar(
            &db,
            id,
            "select feelings::text from rashbase_export.child where id = 1"
        )
        .await,
        Some("{sad,ok}".to_string())
    );
    // NULL has to survive as NULL rather than as the string "NULL".
    assert_eq!(
        scalar(
            &db,
            id,
            "select count(*)::text from rashbase_export.child where email is null"
        )
        .await,
        Some("1".to_string())
    );

    // `setval` ran, so the next key does not collide with one the dump carried.
    db.execute(
        id,
        "insert into rashbase_export.parent (label) values ('three');",
        None,
    )
    .await
    .unwrap_or_else(|e| panic!("the identity sequence was left behind: {e:?}"));
    assert_eq!(
        scalar(&db, id, "select max(id)::text from rashbase_export.parent").await,
        Some("3".to_string())
    );

    // The check constraint came back with it.
    assert!(db
        .execute(
            id,
            "insert into rashbase_export.child (parent_id, qty) values (1, 0);",
            None
        )
        .await
        .is_err());

    db.execute(id, TEARDOWN, None).await.unwrap();
    db.disconnect(id).await.unwrap();
}
