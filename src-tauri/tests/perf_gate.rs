//! The Phase 0 performance gate, against a real Postgres.
//!
//! Two things are under test, and both decide whether the architecture holds:
//!
//! 1. **The text-format assumption.** The read path runs user SQL over the
//!    simple query protocol on the belief that Postgres returns every value as
//!    text, which is what makes generic decoding of arbitrary types tractable.
//!    If that is wrong, uuid/jsonb/numeric/array columns fail to decode and the
//!    whole approach needs a per-OID decode table instead.
//!
//! 2. **The cost of moving 100k rows.** Not just the query, but the JSON
//!    serialization that has to cross the IPC boundary to reach the grid.
//!
//! Skipped unless `RASHBASE_PG_PASSWORD` is set, so a normal `cargo test` on a
//! machine with no database still passes.
//!
//! ```sh
//! RASHBASE_PG_PASSWORD=... cargo test --test perf_gate -- --nocapture
//! ```

use rashbase_studio_lib::drivers::{ConnectionConfig, DbState, SslMode, TypeClass};

fn env_config() -> Option<(ConnectionConfig, String)> {
    let password = std::env::var("RASHBASE_PG_PASSWORD").ok()?;
    Some((
        ConnectionConfig {
            id: "perf-gate".into(),
            driver: "postgres".into(),
            name: "perf gate".into(),
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

#[tokio::test(flavor = "multi_thread")]
async fn decodes_every_column_type_over_the_simple_protocol() {
    let Some((config, password)) = env_config() else {
        eprintln!("skipped: RASHBASE_PG_PASSWORD not set");
        return;
    };

    let state = DbState::default();
    state.connect(&config, Some(&password), None).await.unwrap();

    let results = state
        .execute(&config.id, "select * from perf_test order by id limit 5", None)
        .await
        .unwrap();
    let result = results.last().expect("one result set");

    assert_eq!(result.rows.len(), 5);
    assert_eq!(result.columns.len(), 12, "perf_test has 12 columns");

    // The types that would break a naive decoder: uuid, numeric, timestamptz,
    // jsonb, and a text array all have non-trivial binary representations.
    let by_name = |name: &str| {
        result
            .columns
            .iter()
            .position(|c| c.name == name)
            .unwrap_or_else(|| panic!("column {name} missing"))
    };

    for name in ["uid", "score", "created_at", "payload", "tags", "is_active"] {
        let i = by_name(name);
        let value = result.rows[0][i]
            .as_deref()
            .unwrap_or_else(|| panic!("{name} decoded as NULL on a non-null row"));
        assert!(!value.is_empty(), "{name} decoded to an empty string");
        eprintln!("  {name:<12} {:<14} = {value}", result.columns[i].type_name);
    }

    // Classification drives alignment and colour in the grid.
    assert_eq!(result.columns[by_name("id")].type_class, TypeClass::Number);
    assert_eq!(result.columns[by_name("score")].type_class, TypeClass::Number);
    assert_eq!(result.columns[by_name("is_active")].type_class, TypeClass::Bool);
    assert_eq!(result.columns[by_name("created_at")].type_class, TypeClass::Temporal);
    assert_eq!(result.columns[by_name("payload")].type_class, TypeClass::Json);
    assert_eq!(result.columns[by_name("uid")].type_class, TypeClass::Uuid);
    assert_eq!(result.columns[by_name("tags")].type_class, TypeClass::Array);

    // SQL NULL must survive as None, not as the string "NULL". full_name is
    // null on every 17th row.
    let name_col = by_name("full_name");
    let seventeenth = state
        .execute(
            &config.id,
            "select full_name from perf_test where id = 17",
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        seventeenth.last().unwrap().rows[0][0],
        None,
        "NULL collapsed into a string somewhere"
    );
    assert!(result.rows[0][name_col].is_some());

    state.disconnect(&config.id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn measures_cost_of_one_hundred_thousand_rows() {
    let Some((config, password)) = env_config() else {
        eprintln!("skipped: RASHBASE_PG_PASSWORD not set");
        return;
    };

    let state = DbState::default();
    state.connect(&config, Some(&password), None).await.unwrap();

    let started = std::time::Instant::now();
    let results = state
        .execute(&config.id, "select * from perf_test", None)
        .await
        .unwrap();
    let query_ms = started.elapsed().as_millis();

    let result = results.last().unwrap();
    assert_eq!(result.rows.len(), 100_000);

    // Everything the grid needs has to be serialized and handed across IPC.
    // This, not the query, is where a naive "send it all" design falls over.
    let ser_start = std::time::Instant::now();
    let json = serde_json::to_string(&result).unwrap();
    let serialize_ms = ser_start.elapsed().as_millis();

    eprintln!("\n  ---- perf gate: 100k rows x 12 columns ----");
    eprintln!("  query + decode : {query_ms} ms");
    eprintln!("  json serialize : {serialize_ms} ms");
    eprintln!("  payload        : {:.1} MB", json.len() as f64 / 1_048_576.0);
    eprintln!("  total backend  : {} ms\n", query_ms + serialize_ms);

    // The same statement under the row cap. Nothing about the SQL changes, so
    // the server still does all the work; what the cap removes is the part that
    // actually reaches the window.
    let capped_start = std::time::Instant::now();
    let capped = state
        .execute(&config.id, "select * from perf_test", Some(1_000))
        .await
        .unwrap();
    let capped_ms = capped_start.elapsed().as_millis();

    let capped = capped.last().unwrap();
    assert_eq!(capped.rows.len(), 1_000, "the cap decides how many rows are kept");
    assert!(capped.truncated, "a result stopped short has to say so");
    // The command tag still describes the whole statement, which is what lets
    // the footer say "1,000 of 100,000" rather than pretending there were 1,000.
    assert_eq!(capped.rows_affected, 100_000);

    let capped_json = serde_json::to_string(&capped).unwrap();
    eprintln!("  ---- same query, cap 1000 ----");
    eprintln!("  query + decode : {capped_ms} ms");
    eprintln!("  payload        : {:.1} MB", capped_json.len() as f64 / 1_048_576.0);
    eprintln!(
        "  payload cut to : {:.1}%\n",
        capped_json.len() as f64 / json.len() as f64 * 100.0
    );

    state.disconnect(&config.id).await.unwrap();
}
