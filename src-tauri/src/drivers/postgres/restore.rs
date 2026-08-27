//! Running a `.sql` file back into a database.
//!
//! # What goes wrong without this, and why
//!
//! A dump written by another client is written table by table, in whatever
//! order that client walked the catalogue — usually alphabetical. Restoring it
//! somewhere else then fails three ways, and only the first is obvious:
//!
//! 1. **Order.** `order_items` sorts before `orders`, so a child row reaches
//!    the server before its parent and the foreign key refuses it. The file is
//!    consistent read to the end; it is only inconsistent read in order.
//! 2. **Roles.** `ALTER TABLE … OWNER TO shop_app` and every `GRANT` name a
//!    role on the server the dump came from. The restore stops on `role
//!    "shop_app" does not exist` before a single row has moved.
//! 3. **Sequences.** This one does not fail the restore at all. An
//!    `autoincrement()` column restored with its values leaves its sequence
//!    where it was, and the *application's* next insert collides on the primary
//!    key — hours later, somewhere else, looking like a different bug.
//!
//! All three are handled here, and each is a switch the user can see before
//! anything runs.
//!
//! # One transaction, and no half-applied file
//!
//! Everything below happens inside one transaction. A statement the server
//! refuses rolls the whole thing back and returns the server's own words plus
//! the line of the file it was on. There is deliberately no continue-on-error:
//! a database holding two thirds of a dump is the state this path exists to
//! make impossible, and it is a state nobody can tell apart from a success.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use sqlx::postgres::PgConnection;
use sqlx::Row;

use crate::drivers::postgres::dump::sql_literal;
use crate::drivers::postgres::script::{self, FileScript, Kind, Statement};
use crate::drivers::postgres::sql::quote_ident;
use crate::drivers::types::{ImportPreflight, ImportRequest, ImportStats};
use crate::drivers::ImportProgress;
use crate::error::{Error, Result};

/// How often the dialog is told where the import has got to.
///
/// Per statement would be an IPC message per row on a file of single-row
/// inserts, which costs more than the inserts. Every 64 is well under the
/// interval at which a progress bar reads as moving.
const TICK_EVERY: usize = 64;

/// How much `COPY` data is buffered before it goes to the wire.
const COPY_CHUNK: usize = 64 * 1024;

/// Runs one statement over the simple query protocol.
///
/// Written as `Executor::execute(conn, raw_sql(sql))` rather than the shorter
/// `raw_sql(sql).execute(conn)`, which does not compile here. The method form
/// leaves the executor's lifetime free, so the future it builds can only be
/// shown `Send` for one specific lifetime — and `Session::import` is an
/// `async_trait` method, whose boxed future has to be `Send` for every lifetime.
/// Naming the executor pins it. The error is reported against the trait method
/// and says nothing about this line, so: do not "simplify" it back.
///
/// The simple protocol and not the extended one, for the reason
/// `session.rs::execute` gives: this is user-authored SQL out of a file, it may
/// carry session commands and multi-statement bodies, and the extended protocol
/// refuses both.
async fn simple(conn: &mut PgConnection, sql: &str) -> std::result::Result<u64, sqlx::Error> {
    let done = sqlx::Executor::execute(&mut *conn, sqlx::raw_sql(sql)).await?;
    Ok(done.rows_affected())
}

/// How the foreign keys were actually held off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hold {
    /// Not asked for.
    None,
    /// `session_replication_role = replica`: the foreign key triggers do not
    /// run at all. Unaffected by when the constraints were created, which is
    /// why it is tried first.
    Replica,
    /// Each foreign key made deferrable and deferred to the end of the
    /// transaction. Works as the table's owner, where `replica` needs more.
    Deferred,
}

impl Hold {
    fn label(self) -> Option<String> {
        match self {
            Hold::None => None,
            Hold::Replica => Some("session_replication_role".to_string()),
            Hold::Deferred => Some("deferred".to_string()),
        }
    }
}

/// A foreign key that was not deferrable until this import made it so.
struct Loosened {
    schema: String,
    table: String,
    name: String,
}

impl Loosened {
    fn target(&self) -> String {
        format!("{}.{}", quote_ident(&self.schema), quote_ident(&self.table))
    }
}

/// How many tables the preflight lists before it stops telling them apart.
///
/// A file naming eight hundred relations is a list nobody reads. What is left
/// out is said rather than silently dropped.
const TABLE_LIMIT: usize = 200;

/// The bookkeeping tables each ORM keeps its own migration history in.
///
/// TypeORM's is called `migrations`, which is also a name a person might give a
/// real table, so it is only on this list when the file carried
/// `typeorm_metadata` as well — which is what the preflight decided when it
/// named the ORM. Prisma's and Drizzle's names are theirs alone.
fn history_tables(orm: Option<&str>) -> &'static [&'static str] {
    match orm {
        Some("Prisma") => &["_prisma_migrations"],
        Some("Drizzle") => &["__drizzle_migrations"],
        Some("TypeORM") => &["typeorm_metadata", "migrations"],
        _ => &[],
    }
}

/// Reads a file and reports what is in it, without opening a connection.
///
/// The whole point of the dialog: an import is the largest write this
/// application makes, and the same bargain the pending `UPDATE` preview and the
/// staged Redis deletions make applies to it — what is about to happen is shown
/// first. Costing no connection is what lets that be true before the user has
/// decided anything.
pub fn preflight(path: &str) -> Result<ImportPreflight> {
    let file = Path::new(path);
    let bytes = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    let (mut script, compressed) = script::open(file)?;

    let mut out = ImportPreflight {
        bytes,
        compressed,
        ..Default::default()
    };

    let mut kinds: HashMap<&'static str, usize> = HashMap::new();
    // Insertion order is kept on purpose. File order is the information: it is
    // the order that was going to fail, and a table listed above the one it
    // points at is the whole argument for holding the keys.
    let mut order: Vec<String> = Vec::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut schemas: Vec<String> = Vec::new();

    loop {
        let statement = match script.next_statement() {
            Ok(Some(s)) => s,
            Ok(None) => break,
            // Not fatal to the dialog: what was read is still worth showing,
            // and the reason it stopped is what the user needs to see.
            Err(e) => {
                out.parse_error = Some(e.to_string());
                break;
            }
        };

        out.statements += 1;
        *kinds.entry(statement.kind.label()).or_insert(0) += 1;
        if statement.ownership {
            out.ownership_statements += 1;
        }

        if let Some(target) = &statement.target {
            if counts.get(target).is_none() && order.len() < TABLE_LIMIT {
                order.push(target.clone());
            }
            *counts.entry(target.clone()).or_insert(0) += 1;

            if let Some(schema) = script::schema_of(target) {
                if !schemas.iter().any(|s| s == schema) {
                    schemas.push(schema.to_string());
                }
            }
        }

        let history = matches!(statement.kind, Kind::Insert | Kind::Copy)
            && HISTORY_TABLES
                .iter()
                .any(|name| script::relation_is(statement.target.as_deref(), name));

        if statement.copy_data {
            out.uses_copy = true;
            let rows = match script.skip_copy_data() {
                Ok(rows) => rows,
                Err(e) => {
                    out.parse_error = Some(e.to_string());
                    break;
                }
            };
            if history {
                out.migration_rows += rows as usize;
            }
        } else if history {
            out.migration_rows += 1;
        }
    }

    out.orm = detect_orm(&counts);
    out.table_count = counts.len();
    out.tables = order
        .into_iter()
        .map(|name| {
            let count = counts.get(&name).copied().unwrap_or(0);
            (name, count)
        })
        .collect();
    out.schemas = schemas;

    let mut by_kind: Vec<(String, usize)> = kinds
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
    by_kind.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    out.by_kind = by_kind;

    Ok(out)
}

/// Every table an ORM might keep its migration history in.
const HISTORY_TABLES: &[&str] = &[
    "_prisma_migrations",
    "__drizzle_migrations",
    "typeorm_metadata",
    "migrations",
];

/// Which ORM wrote this file, read off the bookkeeping table it keeps.
///
/// The first two names belong to one tool each and nothing else uses them.
/// TypeORM's history table is called `migrations`, which is a name anyone might
/// give a real table, so it is never the evidence: `typeorm_metadata` is, and
/// `migrations` is only treated as history once that has been found.
fn detect_orm(tables: &HashMap<String, usize>) -> Option<String> {
    let has = |name: &str| tables.keys().any(|t| script::relation_is(Some(t), name));

    if has("_prisma_migrations") {
        Some("Prisma".to_string())
    } else if has("__drizzle_migrations") {
        Some("Drizzle".to_string())
    } else if has("typeorm_metadata") {
        Some("TypeORM".to_string())
    } else {
        None
    }
}


/// Runs the file, and leaves the database untouched if any part of it fails.
pub async fn import(
    conn: &mut PgConnection,
    req: &ImportRequest,
    cancel: &AtomicBool,
    progress: &mut dyn ImportProgress,
) -> Result<ImportStats> {
    let (mut script, _) = script::open(std::path::Path::new(&req.path))?;

    simple(conn, "BEGIN").await?;

    match run(conn, &mut script, req, cancel, progress).await {
        Ok(stats) => {
            simple(conn, "COMMIT").await?;
            Ok(stats)
        }
        Err(e) => {
            // Best effort, and it has to be: the connection is sitting in a
            // failed transaction, where `ROLLBACK` is the one statement
            // Postgres will still accept. If even that fails the connection is
            // gone, and the transaction dies with it — which is the same
            // outcome by a worse road.
            let _ = simple(conn, "ROLLBACK").await;
            Err(e)
        }
    }
}

async fn run(
    conn: &mut PgConnection,
    script: &mut FileScript,
    req: &ImportRequest,
    cancel: &AtomicBool,
    progress: &mut dyn ImportProgress,
) -> Result<ImportStats> {
    let mut stats = ImportStats::default();
    let mut schemas: BTreeSet<String> = BTreeSet::new();
    let mut loosened: Vec<Loosened> = Vec::new();
    let mut last_table = String::new();
    let mut ticked = 0usize;

    // Where a statement that names no schema will land. Asked once, because
    // guessing `public` would reset sequences in a schema the file never
    // touched and miss the one it did.
    let default_schema: String = sqlx::query_scalar("select current_schema()")
        .fetch_one(&mut *conn)
        .await
        .unwrap_or_else(|_| "public".to_string());

    let mut hold = Hold::None;
    if req.hold_foreign_keys {
        hold = match try_replica(conn).await {
            true => Hold::Replica,
            false => Hold::Deferred,
        };
    }
    // The deferral pass has to run before data reaches a table whose keys are
    // already in place, and again after any DDL, because a key the file itself
    // created is created enforcing.
    let mut pass_due = hold == Hold::Deferred;

    let history = history_tables(req.orm.as_deref());

    while let Some(statement) = script.next_statement()? {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }

        if let Some(target) = &statement.target {
            let schema = script::schema_of(target).unwrap_or(&default_schema);
            schemas.insert(schema.to_string());
            last_table = target.clone();
        }

        if should_skip(&statement, req, history) {
            if statement.copy_data {
                script.skip_copy_data()?;
            }
            stats.skipped += 1;
            continue;
        }

        let carries_data = matches!(statement.kind, Kind::Insert | Kind::Copy);
        if carries_data && pass_due {
            defer_keys(conn, &schemas, &mut loosened).await?;
            pass_due = false;
        }
        if hold == Hold::Deferred && matches!(statement.kind, Kind::Create | Kind::Alter) {
            pass_due = true;
        }

        if statement.copy_data {
            progress.tick(stats.statements, script.bytes(), &last_table);
            stats.rows += copy_in(conn, script, &statement).await?;
        } else {
            stats.rows += simple(conn, &statement.text)
                .await
                .map_err(|e| at_line(e, &statement))?;
        }

        stats.statements += 1;
        if stats.statements - ticked >= TICK_EVERY {
            ticked = stats.statements;
            progress.tick(stats.statements, script.bytes(), &last_table);
        }
    }

    // Every deferred check runs here rather than at `COMMIT`, so a key that
    // does not hold is reported while there is still a transaction to name it
    // in. Then the keys go back to being enforced exactly as they were: a
    // schema quietly left more permissive than it was found is a change nobody
    // asked for.
    if !loosened.is_empty() {
        simple(conn, "SET CONSTRAINTS ALL IMMEDIATE").await?;
        for key in &loosened {
            let sql = format!(
                "ALTER TABLE {} ALTER CONSTRAINT {} NOT DEFERRABLE",
                key.target(),
                quote_ident(&key.name)
            );
            simple(conn, &sql).await?;
        }
    }

    if req.reset_sequences {
        stats.sequences_reset = reset_sequences(conn, &schemas).await?;
    }

    stats.key_hold = hold.label();
    progress.tick(stats.statements, script.bytes(), &last_table);
    Ok(stats)
}

/// Whether a statement is left out, and why.
///
/// The first rule is not a switch and must never become one. This runs the file
/// inside a transaction of its own, so the file's own transaction control
/// cannot also run: a `COMMIT` in the file would commit *this* transaction
/// partway through, and everything after it would apply outside one — which is
/// precisely the half-applied dump the whole path exists to rule out. Files
/// this application's own safe export writes carry `BEGIN;` and `COMMIT;`, so
/// this is the common case rather than a defensive one.
fn should_skip(statement: &Statement, req: &ImportRequest, history: &[&str]) -> bool {
    if statement.kind == Kind::Transaction {
        return true;
    }
    if req.skip_ownership && statement.ownership {
        return true;
    }
    // Only the rows. The table itself is created, because the application on
    // this server expects to find it — what it must not find is another
    // server's account of which migrations have run.
    if req.skip_migration_history && matches!(statement.kind, Kind::Insert | Kind::Copy) {
        return history
            .iter()
            .any(|name| script::relation_is(statement.target.as_deref(), name));
    }
    false
}

/// Tries the mechanism that needs no knowledge of the schema, inside a
/// savepoint so a refusal costs nothing.
///
/// Without the savepoint a server that will not grant this — most managed
/// Postgres — would abort the transaction on the first statement of the import,
/// and the fallback would never get a chance to run.
///
/// `SET LOCAL`, so it lasts exactly as long as the transaction. A plain `SET`
/// here would survive the commit and leave the user's tab with its triggers
/// disabled for every statement they ran afterwards.
async fn try_replica(conn: &mut PgConnection) -> bool {
    if simple(conn, "SAVEPOINT rb_import_hold").await.is_err() {
        return false;
    }
    let ok = simple(conn, "SET LOCAL session_replication_role = replica")
        .await
        .is_ok();
    let after = if ok {
        "RELEASE SAVEPOINT rb_import_hold"
    } else {
        "ROLLBACK TO SAVEPOINT rb_import_hold"
    };
    let _ = simple(conn, after).await;
    ok
}

/// Makes every enforcing foreign key in the touched schemas deferrable, and
/// defers it.
///
/// Only the ones that are not deferrable already, so a key the schema itself
/// declared `DEFERRABLE` is left alone and never put back as something it was
/// not. `loosened` is what gets undone at the end.
async fn defer_keys(
    conn: &mut PgConnection,
    schemas: &BTreeSet<String>,
    loosened: &mut Vec<Loosened>,
) -> Result<()> {
    if schemas.is_empty() {
        return Ok(());
    }
    let names: Vec<String> = schemas.iter().cloned().collect();
    let rows = sqlx::query(
        r#"
        select n.nspname, c.relname, con.conname
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_class c on c.oid = con.conrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where con.contype = 'f'
          and not con.condeferrable
          and n.nspname = any($1)
        "#,
    )
    .bind(&names)
    .fetch_all(&mut *conn)
    .await?;

    for row in rows {
        let key = Loosened {
            schema: row.try_get(0)?,
            table: row.try_get(1)?,
            name: row.try_get(2)?,
        };
        let sql = format!(
            "ALTER TABLE {} ALTER CONSTRAINT {} DEFERRABLE INITIALLY DEFERRED",
            key.target(),
            quote_ident(&key.name)
        );
        simple(conn, &sql).await?;
        loosened.push(key);
    }

    simple(conn, "SET CONSTRAINTS ALL DEFERRED").await?;
    Ok(())
}

/// Streams one `COPY` data block from the file onto the wire.
///
/// The bytes are the file's own, never decoded and re-encoded: `COPY` text
/// format gives `\N`, a tab and a backslash meanings that a round trip through
/// anything is a chance to change.
async fn copy_in(
    conn: &mut PgConnection,
    script: &mut FileScript,
    statement: &Statement,
) -> Result<u64> {
    // The terminator is the client's, not part of the command, and
    // `copy_in_raw` sends what it is given as one query.
    let text = statement.text.trim().trim_end_matches(';');
    let mut sink = conn
        .copy_in_raw(text)
        .await
        .map_err(|e| at_line(e, statement))?;

    let mut rows = 0u64;
    let mut buffer: Vec<u8> = Vec::with_capacity(COPY_CHUNK);
    loop {
        match script.next_copy_line() {
            Ok(Some(line)) => {
                buffer.extend_from_slice(line);
                rows += 1;
            }
            Ok(None) => break,
            Err(e) => {
                // The server is mid-`COPY` and will not take anything else
                // until this one is closed out. Aborting says why, in the
                // stream, rather than leaving the connection wedged.
                let _ = sink.abort("import stopped while reading the file").await;
                return Err(e);
            }
        }
        if buffer.len() >= COPY_CHUNK {
            sink.send(buffer.as_slice())
                .await
                .map_err(|e| at_line(e, statement))?;
            buffer.clear();
        }
    }
    if !buffer.is_empty() {
        sink.send(buffer.as_slice())
            .await
            .map_err(|e| at_line(e, statement))?;
    }
    sink.finish().await.map_err(|e| at_line(e, statement))?;
    Ok(rows)
}

/// Moves every identity and `serial` sequence past the highest value imported.
///
/// The half of the problem that does not announce itself. A restore can finish
/// perfectly and still leave the application unable to insert a row, because
/// the sequence behind the primary key is back where it was before the dump
/// carried three hundred thousand rows in with their keys already set.
///
/// `pg_get_serial_sequence` answers for identity columns as well as `serial`
/// ones, so one query covers both. The `where` is what makes the count honest:
/// a table with no rows produces no `setval` and is not counted as one.
async fn reset_sequences(conn: &mut PgConnection, schemas: &BTreeSet<String>) -> Result<usize> {
    if schemas.is_empty() {
        return Ok(0);
    }
    let names: Vec<String> = schemas.iter().cloned().collect();
    let rows = sqlx::query(
        r#"
        select n.nspname, c.relname, a.attname,
               pg_catalog.pg_get_serial_sequence(
                   format('%I.%I', n.nspname, c.relname), a.attname)
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_attribute a
          on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where c.relkind = 'r'
          and n.nspname = any($1)
          and pg_catalog.pg_get_serial_sequence(
                  format('%I.%I', n.nspname, c.relname), a.attname) is not null
        "#,
    )
    .bind(&names)
    .fetch_all(&mut *conn)
    .await?;

    let mut moved = 0usize;
    for row in rows {
        let schema: String = row.try_get(0)?;
        let table: String = row.try_get(1)?;
        let column: String = row.try_get(2)?;
        let sequence: String = row.try_get(3)?;

        let sql = format!(
            "select pg_catalog.setval({}, high.value, true) \
             from (select max({}) as value from {}.{}) high \
             where high.value is not null",
            sql_literal(&sequence),
            quote_ident(&column),
            quote_ident(&schema),
            quote_ident(&table),
        );
        moved += sqlx::query(&sql).fetch_all(&mut *conn).await?.len();
    }
    Ok(moved)
}

/// Keeps the server's words and adds where in the file they were said.
///
/// The message, the code, the detail and the hint are Postgres' exactly. The
/// line and the statement go in `context`, which is this application's field,
/// so nothing the user reads as the database's answer was written here.
fn at_line(e: sqlx::Error, statement: &Statement) -> Error {
    let Error::Db {
        message,
        code,
        detail,
        hint,
        ..
    } = Error::from(e)
    else {
        return Error::other("the import failed for a reason the driver did not report");
    };

    // Enough of the statement to recognise it in an editor, not so much that a
    // million-row `insert` fills the dialog.
    let mut excerpt: String = statement.text.trim().chars().take(240).collect();
    if statement.text.trim().chars().count() > 240 {
        excerpt.push('…');
    }

    Error::Import {
        message,
        code,
        detail,
        hint,
        context: format!("line {}\n{}", statement.line, excerpt),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// The one rule here that is a judgement call rather than a lookup. Prisma
    /// and Drizzle own their names; `migrations` is a word, and skipping a real
    /// table called that would silently drop the user's data.
    #[test]
    fn only_the_named_orm_history_tables_are_recognised() {
        assert_eq!(history_tables(Some("Prisma")), ["_prisma_migrations"]);
        assert_eq!(history_tables(Some("Drizzle")), ["__drizzle_migrations"]);
        assert_eq!(history_tables(Some("TypeORM")), ["typeorm_metadata", "migrations"]);
        // No ORM detected: `migrations` is just a table.
        assert!(history_tables(None).is_empty());
        assert!(history_tables(Some("something else")).is_empty());
    }

    fn statement(kind: Kind, target: &str) -> Statement {
        Statement {
            kind,
            text: String::new(),
            target: Some(target.to_string()),
            line: 1,
            copy_data: false,
            ownership: false,
        }
    }

    fn request(orm: Option<&str>) -> ImportRequest {
        ImportRequest {
            path: String::new(),
            orm: orm.map(str::to_string),
            hold_foreign_keys: true,
            skip_ownership: true,
            skip_migration_history: true,
            reset_sequences: true,
            total_statements: 0,
        }
    }

    /// Skipping the history means skipping its *rows*. Skipping the
    /// `create table` as well would leave the application looking for a table
    /// that is not there, which is a worse failure than the one being avoided.
    #[test]
    fn history_loses_its_rows_and_keeps_its_table() {
        let req = request(Some("Prisma"));
        let history = history_tables(req.orm.as_deref());

        let insert = statement(Kind::Insert, "public._prisma_migrations");
        assert!(should_skip(&insert, &req, history));

        let create = statement(Kind::Create, "public._prisma_migrations");
        assert!(!should_skip(&create, &req, history));

        let other = statement(Kind::Insert, "public.users");
        assert!(!should_skip(&other, &req, history));
    }

    /// The one skip no switch controls. A file written by this application's
    /// own safe export carries `BEGIN;` and `COMMIT;`, and running that
    /// `COMMIT` inside the import's transaction commits it halfway through —
    /// leaving the rest of the file to apply outside any transaction at all.
    #[test]
    fn the_files_own_transaction_control_never_runs() {
        let mut req = request(None);
        req.skip_ownership = false;
        req.skip_migration_history = false;

        assert!(should_skip(&statement(Kind::Transaction, "-"), &req, &[]));
        assert!(!should_skip(&statement(Kind::Insert, "public.users"), &req, &[]));
    }

    /// With the switch off nothing is skipped, including the statements that
    /// are the reason the switch exists.
    #[test]
    fn a_switch_that_is_off_skips_nothing() {
        let mut req = request(Some("Prisma"));
        req.skip_migration_history = false;
        req.skip_ownership = false;
        let history = history_tables(req.orm.as_deref());

        let insert = statement(Kind::Insert, "public._prisma_migrations");
        assert!(!should_skip(&insert, &req, history));

        let mut owner = statement(Kind::Alter, "public.users");
        owner.ownership = true;
        assert!(!should_skip(&owner, &req, history));
    }


    fn scratch(name: &str, body: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rashbase-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::File::create(&path).unwrap().write_all(body).unwrap();
        path
    }

    /// The dump this feature exists for: written table by table, alphabetical,
    /// with the child above the parent. The preflight has to show that order,
    /// because it is the explanation for every switch in the dialog.
    #[test]
    fn a_dump_is_reported_in_the_order_it_will_run() {
        let sql = b"-- exported\n\
                    INSERT INTO public.order_items VALUES (1, 8812);\n\
                    INSERT INTO public.orders VALUES (8812);\n\
                    ALTER TABLE public.orders OWNER TO shop_app;\n\
                    INSERT INTO public._prisma_migrations VALUES ('a');\n";
        let path = scratch("shop.sql", sql);

        let out = preflight(path.to_str().unwrap()).unwrap();
        assert_eq!(out.statements, 4);
        assert_eq!(
            out.tables.iter().map(|(t, _)| t.as_str()).collect::<Vec<_>>(),
            vec![
                "public.order_items",
                "public.orders",
                "public._prisma_migrations"
            ]
        );
        assert_eq!(out.schemas, vec!["public"]);
        assert_eq!(out.table_count, 3);
        assert_eq!(out.orm.as_deref(), Some("Prisma"));
        assert_eq!(out.ownership_statements, 1);
        assert_eq!(out.migration_rows, 1);
        assert!(!out.uses_copy);
        assert!(out.parse_error.is_none());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// pg_dump's default format. The rows are in a data block, so counting
    /// statements is not counting rows and the two must not be confused.
    #[test]
    fn a_copy_dump_counts_its_rows_without_running_anything() {
        let sql = b"COPY public._prisma_migrations (id) FROM stdin;\n\
                    a\n\
                    b\n\
                    \\.\n\
                    COPY public.users (id) FROM stdin;\n\
                    1\n\
                    \\.\n";
        let path = scratch("pg.sql", sql);

        let out = preflight(path.to_str().unwrap()).unwrap();
        assert_eq!(out.statements, 2);
        assert!(out.uses_copy);
        assert_eq!(out.orm.as_deref(), Some("Prisma"));
        // Both rows of the history block, and neither of the users block.
        assert_eq!(out.migration_rows, 2);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A table called `migrations` is a table called `migrations` until
    /// something says otherwise. Naming the file TypeORM's on that alone would
    /// put a switch in front of the user that silently drops their rows.
    #[test]
    fn a_table_named_migrations_is_not_evidence_of_an_orm() {
        let path = scratch(
            "plain.sql",
            b"INSERT INTO public.migrations VALUES (1);\n",
        );
        let out = preflight(path.to_str().unwrap()).unwrap();
        assert_eq!(out.orm, None);
        // Counted against no ORM, so the switch that would skip them is not
        // offered at all.
        assert_eq!(out.migration_rows, 1);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());

        let path = scratch(
            "typeorm.sql",
            b"CREATE TABLE public.typeorm_metadata (t text);\n\
              INSERT INTO public.migrations VALUES (1);\n",
        );
        let out = preflight(path.to_str().unwrap()).unwrap();
        assert_eq!(out.orm.as_deref(), Some("TypeORM"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A file this application wrote, read back. The two halves have to meet or
    /// the safe export is a file only psql can restore.
    #[test]
    fn a_gzipped_file_is_read_without_being_named_gz() {
        use flate2::write::GzEncoder;
        use flate2::Compression;

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(b"CREATE TABLE public.users (id int);\nINSERT INTO public.users VALUES (1);\n")
            .unwrap();
        let body = encoder.finish().unwrap();

        // Deliberately not named `.gz`: the magic number decides, not the name.
        let path = scratch("shop.sql", &body);
        let out = preflight(path.to_str().unwrap()).unwrap();
        assert!(out.compressed);
        assert_eq!(out.statements, 2);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
