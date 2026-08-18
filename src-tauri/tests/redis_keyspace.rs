//! The Redis driver against a real server.
//!
//! Everything under test here is something unit tests cannot reach, because it
//! is a property of how the driver talks to Redis rather than of any function
//! in isolation:
//!
//! 1. **The walk is complete and does not repeat.** A cursor walk that drops
//!    keys looks exactly like a database with fewer keys in it, and nothing in
//!    the UI would flag it.
//! 2. **The scan budget terminates.** A `contains` filter that matches nothing
//!    is the case that would otherwise walk ten million keys inside one IPC
//!    call and hang the window.
//! 3. **`scanned` is honest.** The footer's claim about what a page cost is
//!    only worth showing if it is true.
//! 4. **Writes land and read back.** Including on a key whose name holds a
//!    space, which is what breaks any command built by pasting names together.
//!
//! Skipped unless `RASHBASE_REDIS_HOST` is set, so a normal `cargo test` on a
//! machine with no Redis still passes.
//!
//! ```sh
//! docker run -d -p 6379:6379 redis:7
//! RASHBASE_REDIS_HOST=127.0.0.1 cargo test --test redis_keyspace -- --nocapture
//! ```

use std::collections::HashSet;

use rashbase_studio_lib::drivers::{ConnectionConfig, DbState, KeyFilter, SslMode};

/// Prefix every key this test writes, so it can clean up after itself and can
/// never be confused with whatever else is in the database it was pointed at.
const NS: &str = "rashbase:test";

fn var(name: &str, fallback: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| fallback.to_string())
}

fn env_config() -> Option<(ConnectionConfig, Option<String>)> {
    let host = std::env::var("RASHBASE_REDIS_HOST").ok()?;
    Some((
        ConnectionConfig {
            id: "redis-keyspace".into(),
            driver: "redis".into(),
            name: "redis keyspace".into(),
            host,
            port: var("RASHBASE_REDIS_PORT", "6379").parse().unwrap_or(6379),
            user: var("RASHBASE_REDIS_USER", ""),
            // A number, not a name. Kept out of db0 so a developer's own keys
            // are not what this test is deleting.
            database: var("RASHBASE_REDIS_DB", "9"),
            ssl_mode: SslMode::Disable,
            environment: Some("local".into()),
            parent_id: None,
            ssh: None,
        },
        std::env::var("RASHBASE_REDIS_PASSWORD").ok(),
    ))
}

/// Refuses to run against a database that holds anything this test did not put
/// there.
///
/// `seed` begins with FLUSHDB, and the database it flushes is whatever
/// `RASHBASE_REDIS_DB` names. A developer who points that at 0 to "just try it"
/// loses their own keys with no warning and no way back — the exact failure
/// this project's own principles say never to design in.
///
/// The test is precise rather than "is it empty", because a rerun legitimately
/// finds its own leftovers: everything written here is under `NS`, so anything
/// outside `NS` belongs to someone else. Set `RASHBASE_REDIS_FORCE=1` to flush
/// regardless.
async fn assert_safe_to_flush(db: &DbState, id: &str, database: &str) {
    if std::env::var("RASHBASE_REDIS_FORCE").is_ok() {
        return;
    }

    let total = db
        .execute(id, "DBSIZE", None)
        .await
        .ok()
        .and_then(|r| r.first()?.rows.first()?.first()?.clone())
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    if total == 0 {
        return;
    }

    let ours = walk_all(
        db,
        id,
        &KeyFilter {
            pattern: Some(format!("{NS}:*")),
            contains: None,
            case_sensitive: false,
        },
        1_000,
    )
    .await
    .len() as i64;

    assert!(
        total <= ours,
        "db{database} holds {} key(s) this test did not write, and it begins with \
         FLUSHDB. Point RASHBASE_REDIS_DB at an empty database, or set \
         RASHBASE_REDIS_FORCE=1 if losing them is what you meant.",
        total - ours
    );
}

/// Writes a known keyspace and returns how many keys it put there.
///
/// One of every type, because the enrichment pipeline branches on type and a
/// fixture of nothing but strings would exercise one arm of it.
async fn seed(db: &DbState, id: &str, keys: usize) -> usize {
    let mut script = String::from("FLUSHDB\n");
    for i in 0..keys {
        script.push_str(&format!("SET {NS}:str:{i} value-{i}\n"));
    }
    script.push_str(&format!("HSET {NS}:hash:1 name dwi city jakarta\n"));
    script.push_str(&format!("RPUSH {NS}:list:1 a b c\n"));
    script.push_str(&format!("SADD {NS}:set:1 x y\n"));
    script.push_str(&format!("ZADD {NS}:zset:1 1 one 2 two\n"));
    // A name holding a space. Any command built by joining names would send
    // this as two arguments and silently act on the wrong thing.
    script.push_str(&format!("SET \"{NS}:with space\" spaced\n"));
    // One that expires, so the TTL column has something other than -1 in it.
    script.push_str(&format!("SETEX {NS}:ttl:1 600 soon\n"));

    db.execute(id, &script, None).await.expect("seed");
    keys + 6
}

async fn walk_all(db: &DbState, id: &str, filter: &KeyFilter, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut cursor = 0u64;
    // A cursor walk can return an empty page and still have more to give, so
    // this loops on `exhausted` rather than on the page being non-empty.
    loop {
        let page = db.list_keys(id, filter, cursor, limit).await.expect("page");
        out.extend(page.keys.into_iter().map(|k| k.key));
        cursor = page.cursor;
        if page.exhausted {
            return out;
        }
        // A walk that never finishes is the failure this whole test exists to
        // catch; failing loudly beats hanging CI.
        assert!(out.len() < 1_000_000, "the walk never came round");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn walks_the_whole_keyspace_exactly_once() {
    let Some((config, password)) = env_config() else {
        eprintln!("skipped: RASHBASE_REDIS_HOST not set");
        return;
    };

    let db = DbState::default();
    let info = db
        .connect(&config, password.as_deref(), None)
        .await
        .expect("connected");
    eprintln!("connected to {} on {}", info.server_version, info.current_database);

    assert_safe_to_flush(&db, &config.id, &config.database).await;
    let total = seed(&db, &config.id, 2_000).await;

    // A page size well under the total, so this is a real multi-page walk
    // rather than one page that happened to fit.
    let found = walk_all(&db, &config.id, &KeyFilter::default(), 200).await;
    let unique: HashSet<&String> = found.iter().collect();

    assert_eq!(
        unique.len(),
        total,
        "the walk reached {} of {total} keys",
        unique.len()
    );
    // Redis may return a key twice across pages; the app tolerates that, but a
    // walk that never terminated would show up here as a runaway count.
    assert!(found.len() < total * 2, "the walk repeated itself excessively");

    db.disconnect(&config.id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_glob_is_matched_by_the_server_and_reaches_only_that_prefix() {
    let Some((config, password)) = env_config() else {
        eprintln!("skipped: RASHBASE_REDIS_HOST not set");
        return;
    };
    let mut config = config;
    config.id = "redis-glob".into();

    let db = DbState::default();
    db.connect(&config, password.as_deref(), None).await.unwrap();
    assert_safe_to_flush(&db, &config.id, &config.database).await;
    seed(&db, &config.id, 500).await;

    // The gesture the feature was asked for, sent verbatim.
    let filter = KeyFilter {
        pattern: Some(format!("{NS}:str:*")),
        contains: None,
        case_sensitive: false,
    };
    let found = walk_all(&db, &config.id, &filter, 100).await;

    assert_eq!(found.len(), 500);
    assert!(
        found.iter().all(|k| k.starts_with(&format!("{NS}:str:"))),
        "the glob let through a key outside its prefix"
    );

    db.disconnect(&config.id).await.unwrap();
}

/// The case that would otherwise hang the window: a value search that matches
/// nothing has to stop on its budget, report what it spent, and hand back a
/// cursor that resumes.
#[tokio::test(flavor = "multi_thread")]
async fn a_value_search_that_matches_nothing_stops_on_its_budget() {
    let Some((config, password)) = env_config() else {
        eprintln!("skipped: RASHBASE_REDIS_HOST not set");
        return;
    };
    let mut config = config;
    config.id = "redis-budget".into();

    let db = DbState::default();
    db.connect(&config, password.as_deref(), None).await.unwrap();
    assert_safe_to_flush(&db, &config.id, &config.database).await;
    seed(&db, &config.id, 5_000).await;

    let filter = KeyFilter {
        pattern: None,
        contains: Some("nothing-holds-this-string".into()),
        case_sensitive: false,
    };
    let page = db.list_keys(&config.id, &filter, 0, 200).await.unwrap();

    assert!(page.keys.is_empty(), "nothing should have matched");
    // The whole point of reporting `scanned`: this page cost thousands of reads
    // and returned nothing, and the footer has to be able to say so.
    assert!(
        page.scanned > 0,
        "a page that read nothing cannot have been searched"
    );
    eprintln!("scanned {} keys for no matches", page.scanned);

    // And a search that does match finds it, so the filter is not simply broken.
    let filter = KeyFilter {
        pattern: Some(format!("{NS}:hash:*")),
        contains: Some("jakarta".into()),
        case_sensitive: false,
    };
    let found = walk_all(&db, &config.id, &filter, 200).await;
    assert_eq!(found, vec![format!("{NS}:hash:1")]);

    db.disconnect(&config.id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_every_type_and_writes_the_two_that_are_writable() {
    let Some((config, password)) = env_config() else {
        eprintln!("skipped: RASHBASE_REDIS_HOST not set");
        return;
    };
    let mut config = config;
    config.id = "redis-write".into();

    let db = DbState::default();
    db.connect(&config, password.as_deref(), None).await.unwrap();
    assert_safe_to_flush(&db, &config.id, &config.database).await;
    seed(&db, &config.id, 10).await;

    let page = db
        .list_keys(&config.id, &KeyFilter::default(), 0, 500)
        .await
        .unwrap();
    let by_key = |name: &str| {
        page.keys
            .iter()
            .find(|k| k.key == name)
            .unwrap_or_else(|| panic!("{name} missing from the page"))
            .clone()
    };

    // Each type reports its own kind, its own size unit, and a preview the row
    // panel can draw.
    let hash = by_key(&format!("{NS}:hash:1"));
    assert_eq!(hash.kind, "hash");
    assert_eq!(hash.size, Some(2));
    let preview = hash.preview.clone().expect("a hash previews as JSON");
    assert!(preview.contains("\"name\""), "hash preview was {preview}");
    // JSON, so the existing viewer draws it without knowing Redis exists.
    serde_json::from_str::<serde_json::Value>(&preview).expect("the preview parses as JSON");

    assert_eq!(by_key(&format!("{NS}:list:1")).kind, "list");
    assert_eq!(by_key(&format!("{NS}:set:1")).kind, "set");
    assert_eq!(by_key(&format!("{NS}:zset:1")).kind, "zset");

    // -1 means "never expires" and has to stay distinct from a real countdown.
    assert_eq!(by_key(&format!("{NS}:str:0")).ttl, Some(-1));
    let ttl = by_key(&format!("{NS}:ttl:1")).ttl.expect("a TTL was read");
    assert!(ttl > 0 && ttl <= 600, "expected a live countdown, got {ttl}");

    // ---- writes -----------------------------------------------------------
    let key = format!("{NS}:str:0");
    let id = |k: &str| vec![("key".to_string(), k.to_string())];

    let stored = db
        .update_cell(&config.id, "", "", "value", Some("rewritten"), &id(&key))
        .await
        .expect("a string is writable");
    assert_eq!(stored.as_deref(), Some("rewritten"));

    // A hash is written as a document, which is what makes the existing JSON
    // editor a Redis editor without it learning a single Redis command.
    let hash_key = format!("{NS}:hash:1");
    db.update_cell(
        &config.id,
        "",
        "",
        "value",
        Some(r#"{"name":"dwi","country":"id"}"#),
        &id(&hash_key),
    )
    .await
    .expect("a hash is writable");
    let after = db
        .execute(&config.id, &format!("HGETALL {hash_key}"), None)
        .await
        .unwrap();
    let flat = format!("{:?}", after[0].rows);
    assert!(flat.contains("country"), "the added field is missing: {flat}");
    // `city` was not in the document, so the diff should have removed it.
    assert!(!flat.contains("jakarta"), "the dropped field survived: {flat}");

    // A collection has no single-cell equivalent and says so rather than
    // failing silently.
    let refusal = db
        .update_cell(&config.id, "", "", "value", Some("x"), &id(&format!("{NS}:set:1")))
        .await;
    assert!(refusal.is_err(), "a set should not be writable as a value");

    // ---- TTL --------------------------------------------------------------
    db.update_cell(&config.id, "", "", "ttl", Some("120"), &id(&key))
        .await
        .expect("TTL is writable");
    let ttl: i64 = db
        .list_keys(
            &config.id,
            &KeyFilter { pattern: Some(key.clone()), contains: None, case_sensitive: false },
            0,
            10,
        )
        .await
        .unwrap()
        .keys[0]
        .ttl
        .unwrap();
    assert!(ttl > 0 && ttl <= 120, "expected an expiry, got {ttl}");

    // Blank clears it, which is what the field's "never" means.
    db.update_cell(&config.id, "", "", "ttl", Some(""), &id(&key))
        .await
        .expect("PERSIST");
    let page = db
        .list_keys(
            &config.id,
            &KeyFilter { pattern: Some(key.clone()), contains: None, case_sensitive: false },
            0,
            10,
        )
        .await
        .unwrap();
    assert_eq!(page.keys[0].ttl, Some(-1), "the expiry was not cleared");

    db.disconnect(&config.id).await.unwrap();
}

/// A key holding a space is what breaks any command built by joining names
/// together, which is exactly why `delete_keys` takes them as arguments.
#[tokio::test(flavor = "multi_thread")]
async fn deletes_keys_including_one_whose_name_holds_a_space() {
    let Some((config, password)) = env_config() else {
        eprintln!("skipped: RASHBASE_REDIS_HOST not set");
        return;
    };
    let mut config = config;
    config.id = "redis-delete".into();

    let db = DbState::default();
    db.connect(&config, password.as_deref(), None).await.unwrap();
    assert_safe_to_flush(&db, &config.id, &config.database).await;
    seed(&db, &config.id, 20).await;

    let doomed = vec![
        format!("{NS}:str:1"),
        format!("{NS}:str:2"),
        format!("{NS}:with space"),
    ];
    let removed = db.delete_keys(&config.id, &doomed).await.expect("deleted");
    assert_eq!(removed, 3, "every named key should have existed");

    let left = walk_all(&db, &config.id, &KeyFilter::default(), 200).await;
    for key in &doomed {
        assert!(!left.contains(key), "{key} survived the delete");
    }

    // Deleting what is already gone is not an error: it is what a Stop pressed
    // a moment too late looks like.
    assert_eq!(db.delete_keys(&config.id, &doomed).await.unwrap(), 0);
    assert_eq!(db.delete_keys(&config.id, &[]).await.unwrap(), 0);

    db.disconnect(&config.id).await.unwrap();
}

/// The console is the escape hatch for everything the browser does not cover,
/// so it has to survive the replies Redis actually sends.
#[tokio::test(flavor = "multi_thread")]
async fn the_console_runs_commands_and_shapes_their_replies() {
    let Some((config, password)) = env_config() else {
        eprintln!("skipped: RASHBASE_REDIS_HOST not set");
        return;
    };
    let mut config = config;
    config.id = "redis-console".into();

    let db = DbState::default();
    db.connect(&config, password.as_deref(), None).await.unwrap();
    assert_safe_to_flush(&db, &config.id, &config.database).await;
    seed(&db, &config.id, 5).await;

    // One line per command, several result sets in order, like a SQL script.
    let results = db
        .execute(
            &config.id,
            &format!("GET {NS}:str:0\nLRANGE {NS}:list:1 0 -1\nDBSIZE"),
            None,
        )
        .await
        .expect("the console ran");
    assert_eq!(results.len(), 3);
    assert_eq!(results[0].rows[0][0].as_deref(), Some("value-0"));
    assert_eq!(results[1].rows.len(), 3, "a list is one row per element");

    // A quoted argument stays whole, which is the whole reason for the
    // tokenizer: split on whitespace and this writes "Dwi" and nothing else.
    db.execute(
        &config.id,
        &format!("HSET {NS}:quoted name \"Dwi Putra\""),
        None,
    )
    .await
    .expect("quoted write");
    let read = db
        .execute(&config.id, &format!("HGET {NS}:quoted name"), None)
        .await
        .unwrap();
    assert_eq!(read[0].rows[0][0].as_deref(), Some("Dwi Putra"));

    // A missing key is NULL, not the text "nil": the grid draws them
    // differently and the distinction has to survive the whole way out.
    let missing = db
        .execute(&config.id, &format!("GET {NS}:not-here"), None)
        .await
        .unwrap();
    assert_eq!(missing[0].rows[0][0], None);

    // A blocking command is refused rather than left to wedge the session,
    // which this driver has no cancel to recover from.
    assert!(db.execute(&config.id, "SUBSCRIBE chan", None).await.is_err());
    // And the session still works afterwards.
    assert!(db.execute(&config.id, "PING", None).await.is_ok());

    db.execute(&config.id, "FLUSHDB", None).await.unwrap();
    db.disconnect(&config.id).await.unwrap();
}
