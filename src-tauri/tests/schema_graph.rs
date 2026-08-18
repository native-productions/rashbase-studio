//! The schema graph, against a real Postgres.
//!
//! What cannot be asserted without a server is the catalogue query itself. Two
//! properties in particular are invisible when they break:
//!
//!  * `conkey` and `confkey` are attribute numbers, and their order is what
//!    pairs a composite key's columns with the ones they point at. Without
//!    `with ordinality` the join to `pg_attribute` returns them in whatever
//!    order the planner liked, and a two-column key silently reads as pointing
//!    at the wrong pair — a diagram that is confidently wrong rather than
//!    obviously broken.
//!  * A key whose target is in another schema must still be reported, with the
//!    schema it points at, so the frontend can mark the column without drawing
//!    an edge to a node that is not on the canvas.
//!
//! Skipped unless `RASHBASE_PG_PASSWORD` is set, so a normal `cargo test` on a
//! machine with no database still passes. Seeds and drops its own fixture,
//! because the shape of the fixture is what is being tested.
//!
//! ```sh
//! RASHBASE_PG_PASSWORD=... cargo test --test schema_graph -- --nocapture
//! ```

use rashbase_studio_lib::drivers::{ConnectionConfig, DbState, SslMode};

const FIXTURE: &str = r#"
drop table if exists rashbase_erd_items;
drop table if exists rashbase_erd_orders;
drop table if exists rashbase_erd_nodes;
drop table if exists rashbase_erd_users;
drop schema if exists rashbase_erd_other cascade;

create schema rashbase_erd_other;
create table rashbase_erd_other.tenants (id uuid primary key);

create table rashbase_erd_users (id uuid primary key, email text not null);

-- Three keys to the same table: the frontend collapses them into one edge, so
-- all three have to arrive for the label to name all three.
-- One key out of the schema, which must arrive naming where it went.
create table rashbase_erd_orders (
    tenant uuid,
    id uuid,
    created_by uuid references rashbase_erd_users(id),
    updated_by uuid references rashbase_erd_users(id),
    owned_by uuid references rashbase_erd_users(id),
    tenant_id uuid references rashbase_erd_other.tenants(id),
    primary key (tenant, id)
);

-- A composite key whose two columns are deliberately named so that pairing
-- them in the wrong order produces a different, checkable answer.
create table rashbase_erd_items (
    tenant uuid,
    ord uuid,
    foreign key (tenant, ord) references rashbase_erd_orders(tenant, id)
);

create table rashbase_erd_nodes (
    id uuid primary key,
    parent_id uuid references rashbase_erd_nodes(id)
);
"#;

const TEARDOWN: &str = r#"
drop table if exists rashbase_erd_items;
drop table if exists rashbase_erd_orders;
drop table if exists rashbase_erd_nodes;
drop table if exists rashbase_erd_users;
drop schema if exists rashbase_erd_other cascade;
"#;

fn env_config() -> Option<(ConnectionConfig, String)> {
    let password = std::env::var("RASHBASE_PG_PASSWORD").ok()?;
    Some((
        ConnectionConfig {
            id: "schema-graph".into(),
            driver: "postgres".into(),
            name: "schema graph".into(),
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

#[tokio::test(flavor = "multi_thread")]
async fn reads_a_schema_as_a_graph() {
    let Some((config, password)) = env_config() else {
        eprintln!("skipped: RASHBASE_PG_PASSWORD not set");
        return;
    };

    let db = DbState::default();
    db.connect(&config, Some(&password), None).await.unwrap();
    db.execute(&config.id, FIXTURE, None).await.unwrap();

    let graph = db.schema_graph(&config.id, "public").await.unwrap();

    let table = |name: &str| {
        graph
            .tables
            .iter()
            .find(|t| t.name == name)
            .unwrap_or_else(|| panic!("{name} missing from the graph"))
            .clone()
    };

    // Columns arrive with the relation, in attribute order, with the primary
    // key marked — everything a collapsed node draws.
    let users = table("rashbase_erd_users");
    assert_eq!(
        users.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["id", "email"],
    );
    assert!(users.columns[0].primary_key);
    assert!(!users.columns[1].primary_key);
    assert!(users.columns[1].not_null);
    assert_eq!(users.columns[0].data_type, "uuid");

    let named = |name: &str| {
        graph
            .relations
            .iter()
            .find(|r| r.name == name)
            .unwrap_or_else(|| panic!("{name} missing from the graph"))
    };

    // All three keys to the same table survive as separate relations. The
    // frontend is what collapses them, and it cannot name what it never got.
    let to_users: Vec<_> = graph
        .relations
        .iter()
        .filter(|r| r.table == "rashbase_erd_orders" && r.ref_table == "rashbase_erd_users")
        .collect();
    assert_eq!(to_users.len(), 3);

    // The composite key pairs positionally. Reversed, this would read
    // `tenant → id`, which is a different and wrong claim about the schema.
    let composite = named("rashbase_erd_items_tenant_ord_fkey");
    assert_eq!(composite.columns, ["tenant", "ord"]);
    assert_eq!(composite.ref_columns, ["tenant", "id"]);
    assert_eq!(composite.ref_table, "rashbase_erd_orders");

    // A key out of the schema is reported, naming where it went.
    let outward = named("rashbase_erd_orders_tenant_id_fkey");
    assert_eq!(outward.ref_schema, "rashbase_erd_other");
    assert_eq!(outward.ref_table, "tenants");

    // And a self reference is one relation, not zero and not two.
    let loop_key = named("rashbase_erd_nodes_parent_id_fkey");
    assert_eq!(loop_key.table, "rashbase_erd_nodes");
    assert_eq!(loop_key.ref_table, "rashbase_erd_nodes");

    db.execute(&config.id, TEARDOWN, None).await.unwrap();
    db.disconnect(&config.id).await.unwrap();
}
