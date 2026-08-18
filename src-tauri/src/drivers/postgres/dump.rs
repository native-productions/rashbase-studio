//! Composing a dump of a set of relations.
//!
//! # Why not `pg_dump`
//!
//! Shelling out would be less code and is the first thing anyone suggests. It
//! is also wrong here: the binary may be absent, a `pg_dump` older than the
//! server refuses outright, and neither version can see through the SSH tunnel
//! this application opens on the user's behalf. Everything below is read from
//! `pg_catalog` over the connection that already works.
//!
//! # Where the escaping happens
//!
//! Not here. Row values are turned into SQL literals by `quote_nullable` on
//! the server, so the dump inherits Postgres' own rules for backslashes,
//! embedded quotes, `bytea`, and the difference between SQL NULL and the string
//! "NULL". The client never sees a value it has to decide how to quote, which
//! removes the entire class of bug that makes hand-rolled exporters unsafe to
//! restore. CSV goes further and never passes through this process at all:
//! `copy ... to stdout` streams bytes the server has already formatted.
//!
//! What *is* composed here is `create table`, because there is no server
//! function that prints one. Every other definition — constraints, indexes,
//! views — comes back from `pg_get_*def` verbatim.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::TryStreamExt;
use sqlx::postgres::PgConnection;
use sqlx::Row;

use crate::drivers::postgres::sql::quote_ident;
use crate::drivers::types::{DumpStats, ExportFormat, ExportLayout, ExportRequest, ObjectRef};
use crate::drivers::DumpWriter;
use crate::error::{Error, Result};

/// How often the cancel flag is read while rows stream.
///
/// Per row would be a relaxed atomic load per row, which is cheap but not free
/// on a ten-million-row table. Every few hundred rows is well under the delay a
/// person can perceive after pressing Stop.
const CANCEL_CHECK_EVERY: u64 = 512;

/// Quotes a value as a SQL string literal.
///
/// Only ever applied to text this module composed — table names on their way
/// into a `select` that builds `insert` statements. Values never come near it:
/// they are quoted server-side. Without this an identifier containing an
/// apostrophe would end the literal early and the generated statement would be
/// nonsense at best.
fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// A schema-qualified relation name, quoted.
fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(name))
}

// ---------------------------------------------------------------------------
// What the catalogue is asked for
// ---------------------------------------------------------------------------

/// A column as `create table` needs it, which is more than the cell editor did.
///
/// `identity` and `generated` are the two the editor never had to care about
/// and a dump cannot omit: an identity column written out as a plain `integer`
/// silently loses its sequence, and a generated column written out as writable
/// is rejected by the first `insert` that reaches it.
#[derive(Debug, Clone)]
pub struct DumpColumn {
    pub name: String,
    /// `format_type` output, so `numeric(10,2)` keeps its modifier.
    pub data_type: String,
    pub not_null: bool,
    /// Doubles as the generation expression when `generated` is set, which is
    /// where Postgres stores it.
    pub default: Option<String>,
    /// `a` always, `d` by default, empty for an ordinary column.
    pub identity: String,
    /// `s` stored, empty for an ordinary column.
    pub generated: String,
}

impl DumpColumn {
    /// Whether a value for this column can be written by an `insert`.
    fn writable(&self) -> bool {
        self.generated.is_empty()
    }
}

async fn columns(conn: &mut PgConnection, schema: &str, table: &str) -> Result<Vec<DumpColumn>> {
    let rows = sqlx::query(
        r#"
        select a.attname,
               pg_catalog.format_type(a.atttypid, a.atttypmod),
               a.attnotnull,
               pg_catalog.pg_get_expr(d.adbin, d.adrelid),
               a.attidentity::text,
               a.attgenerated::text
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        left join pg_catalog.pg_attrdef d
               on d.adrelid = a.attrelid and d.adnum = a.attnum
        where n.nspname = $1
          and c.relname = $2
          and a.attnum > 0
          and not a.attisdropped
        order by a.attnum
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_all(&mut *conn)
    .await?;

    rows.into_iter()
        .map(|r| {
            Ok(DumpColumn {
                name: r.try_get::<String, _>(0)?,
                data_type: r.try_get::<String, _>(1)?,
                not_null: r.try_get::<bool, _>(2)?,
                default: r.try_get::<Option<String>, _>(3)?,
                identity: r.try_get::<String, _>(4)?,
                generated: r.try_get::<String, _>(5)?,
            })
        })
        .collect()
}

/// One constraint, as the server prints it.
struct Constraint {
    name: String,
    definition: String,
    /// `p` primary key, `u` unique, `c` check, `f` foreign key.
    kind: String,
}

async fn constraints(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> Result<Vec<Constraint>> {
    let rows = sqlx::query(
        r#"
        select con.conname,
               pg_catalog.pg_get_constraintdef(con.oid),
               con.contype::text
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_class c on c.oid = con.conrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1
          and c.relname = $2
          and con.contype in ('p', 'u', 'c', 'f')
        order by con.contype, con.conname
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_all(&mut *conn)
    .await?;

    rows.into_iter()
        .map(|r| {
            Ok(Constraint {
                name: r.try_get::<String, _>(0)?,
                definition: r.try_get::<String, _>(1)?,
                kind: r.try_get::<String, _>(2)?,
            })
        })
        .collect()
}

/// Indexes that are not the implementation of a constraint.
///
/// A primary key's index is created by its `add constraint`, so emitting the
/// index as well would fail the restore on a duplicate name.
async fn indexes(conn: &mut PgConnection, schema: &str, table: &str) -> Result<Vec<String>> {
    let rows = sqlx::query(
        r#"
        select pg_catalog.pg_get_indexdef(i.indexrelid)
        from pg_catalog.pg_index i
        join pg_catalog.pg_class c on c.oid = i.indrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1
          and c.relname = $2
          and not exists (
              select 1 from pg_catalog.pg_constraint con
              where con.conindid = i.indexrelid
          )
        order by 1
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_all(&mut *conn)
    .await?;
    rows.into_iter()
        .map(|r| Ok(r.try_get::<String, _>(0)?))
        .collect()
}

/// An enum type one of the dumped relations depends on.
struct EnumType {
    schema: String,
    name: String,
    labels: Vec<String>,
}

/// Enum types reachable from a relation's columns, arrays included.
///
/// Without these a structure-only dump restores into `type "mood" does not
/// exist`, which reads as the dump being broken rather than incomplete.
///
/// The distinct pass over the types matters: two columns of the same enum —
/// `mood` and `mood[]`, say — are two attribute rows, and aggregating the
/// labels across them writes every label twice.
async fn enum_types(conn: &mut PgConnection, schema: &str, table: &str) -> Result<Vec<EnumType>> {
    let rows = sqlx::query(
        r#"
        select en.nspname,
               base.typname,
               (select array_agg(e.enumlabel::text order by e.enumsortorder)
                  from pg_catalog.pg_enum e
                 where e.enumtypid = base.oid)
        from (
            select distinct
                   -- An array type points at its element through `typelem`;
                   -- the labels live on the element, never on the array.
                   case when t.typelem <> 0 and t.typlen = -1 then t.typelem else t.oid end as oid
            from pg_catalog.pg_attribute a
            join pg_catalog.pg_class c on c.oid = a.attrelid
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            join pg_catalog.pg_type t on t.oid = a.atttypid
            where n.nspname = $1
              and c.relname = $2
              and a.attnum > 0
              and not a.attisdropped
        ) used
        join pg_catalog.pg_type base on base.oid = used.oid
        join pg_catalog.pg_namespace en on en.oid = base.typnamespace
        where base.typtype = 'e'
        order by en.nspname, base.typname
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_all(&mut *conn)
    .await?;

    rows.into_iter()
        .map(|r| {
            Ok(EnumType {
                schema: r.try_get::<String, _>(0)?,
                name: r.try_get::<String, _>(1)?,
                labels: r.try_get::<Vec<String>, _>(2)?,
            })
        })
        .collect()
}

/// A sequence a dumped table owns.
struct Sequence {
    schema: String,
    name: String,
    data_type: String,
    increment: i64,
    min_value: i64,
    max_value: i64,
    start_value: i64,
    cycle: bool,
    last_value: Option<i64>,
    /// True when the sequence was created by a `serial` column and so has to be
    /// created explicitly. An identity column's sequence comes with the
    /// `create table`, and creating it again fails.
    standalone: bool,
}

async fn sequences(conn: &mut PgConnection, schema: &str, table: &str) -> Result<Vec<Sequence>> {
    let rows = sqlx::query(
        r#"
        select sn.nspname,
               s.relname,
               seq.data_type::text,
               seq.increment_by,
               seq.min_value,
               seq.max_value,
               seq.start_value,
               seq.cycle,
               seq.last_value,
               d.deptype::text
        from pg_catalog.pg_class s
        join pg_catalog.pg_namespace sn on sn.oid = s.relnamespace
        join pg_catalog.pg_depend d
          on d.objid = s.oid
         and d.classid = 'pg_catalog.pg_class'::regclass
         and d.deptype in ('a', 'i')
        join pg_catalog.pg_class c on c.oid = d.refobjid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        left join pg_catalog.pg_sequences seq
               on seq.schemaname = sn.nspname and seq.sequencename = s.relname
        where s.relkind = 'S'
          and n.nspname = $1
          and c.relname = $2
        order by sn.nspname, s.relname
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_all(&mut *conn)
    .await?;

    rows.into_iter()
        .map(|r| {
            Ok(Sequence {
                schema: r.try_get::<String, _>(0)?,
                name: r.try_get::<String, _>(1)?,
                data_type: r
                    .try_get::<Option<String>, _>(2)?
                    .unwrap_or_else(|| "bigint".into()),
                increment: r.try_get::<Option<i64>, _>(3)?.unwrap_or(1),
                min_value: r.try_get::<Option<i64>, _>(4)?.unwrap_or(1),
                max_value: r.try_get::<Option<i64>, _>(5)?.unwrap_or(i64::MAX),
                start_value: r.try_get::<Option<i64>, _>(6)?.unwrap_or(1),
                cycle: r.try_get::<Option<bool>, _>(7)?.unwrap_or(false),
                last_value: r.try_get::<Option<i64>, _>(8)?,
                standalone: r.try_get::<String, _>(9)? == "a",
            })
        })
        .collect()
}

/// `comment on` statements for a relation and its columns.
///
/// Two queries rather than one with a `coalesce`: falling back from the column
/// comment to the table's would give every uncommented column the table's
/// sentence, which is worse than no comments at all.
async fn comments(conn: &mut PgConnection, schema: &str, table: &str) -> Result<Vec<String>> {
    let mut out = Vec::new();

    let on_table: Option<String> = sqlx::query_scalar(
        r#"
        select pg_catalog.obj_description(c.oid, 'pg_class')
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relname = $2
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(&mut *conn)
    .await?
    .flatten();

    if let Some(text) = on_table {
        out.push(format!(
            "COMMENT ON TABLE {} IS {};",
            qualified(schema, table),
            sql_literal(&text)
        ));
    }

    let rows = sqlx::query(
        r#"
        select a.attname, pg_catalog.col_description(c.oid, a.attnum)
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1
          and c.relname = $2
          and a.attnum > 0
          and not a.attisdropped
          and pg_catalog.col_description(c.oid, a.attnum) is not null
        order by a.attnum
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_all(&mut *conn)
    .await?;

    for r in rows {
        out.push(format!(
            "COMMENT ON COLUMN {}.{} IS {};",
            qualified(schema, table),
            quote_ident(&r.try_get::<String, _>(0)?),
            sql_literal(&r.try_get::<String, _>(1)?)
        ));
    }

    Ok(out)
}

/// The relation's own definition text, for a view or materialized view.
async fn view_body(conn: &mut PgConnection, schema: &str, name: &str) -> Result<String> {
    let row = sqlx::query(
        r#"
        select pg_catalog.pg_get_viewdef(c.oid, true)
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relname = $2
        "#,
    )
    .bind(schema)
    .bind(name)
    .fetch_one(&mut *conn)
    .await?;
    Ok(row.try_get::<String, _>(0)?)
}

// ---------------------------------------------------------------------------
// What the file says
// ---------------------------------------------------------------------------

/// The `create table` body. The one definition Postgres will not print for us.
pub fn create_table(schema: &str, table: &str, cols: &[DumpColumn]) -> String {
    let body = cols
        .iter()
        .map(column_clause)
        .collect::<Vec<_>>()
        .join(",\n");
    format!(
        "CREATE TABLE {} (\n{}\n);\n",
        qualified(schema, table),
        body
    )
}

/// One column of a `create table`.
///
/// The order of the three exclusive branches is the order Postgres accepts
/// them in: a generated column stores its expression where a default would, and
/// an identity column has no default of its own to print.
pub fn column_clause(c: &DumpColumn) -> String {
    let mut out = format!("    {} {}", quote_ident(&c.name), c.data_type);
    if c.generated == "s" {
        if let Some(expr) = &c.default {
            out.push_str(&format!(" GENERATED ALWAYS AS ({expr}) STORED"));
        }
    } else if c.identity == "a" {
        out.push_str(" GENERATED ALWAYS AS IDENTITY");
    } else if c.identity == "d" {
        out.push_str(" GENERATED BY DEFAULT AS IDENTITY");
    } else if let Some(default) = &c.default {
        out.push_str(&format!(" DEFAULT {default}"));
    }
    if c.not_null {
        out.push_str(" NOT NULL");
    }
    out
}

/// A statement that removes the relation if it is there, for a re-runnable dump.
pub fn drop_statement(schema: &str, name: &str, kind: &str) -> String {
    let what = match kind {
        "view" => "VIEW",
        "matview" => "MATERIALIZED VIEW",
        _ => "TABLE",
    };
    format!(
        "DROP {} IF EXISTS {} CASCADE;\n",
        what,
        qualified(schema, name)
    )
}

/// The `select` that makes the server write this table's `insert` statements.
///
/// Every value goes through `quote_nullable`, so the literal in the file is the
/// server's own rendering of the value and SQL NULL comes out as the keyword
/// rather than the string. Generated columns are left out because they cannot
/// be written; an identity column declared `always` needs the insert to say so.
pub fn insert_select(schema: &str, table: &str, cols: &[DumpColumn]) -> String {
    let target = qualified(schema, table);
    let writable: Vec<&DumpColumn> = cols.iter().filter(|c| c.writable()).collect();

    let names = writable
        .iter()
        .map(|c| quote_ident(&c.name))
        .collect::<Vec<_>>()
        .join(", ");
    let values = writable
        .iter()
        .map(|c| format!("quote_nullable({}::text)", quote_ident(&c.name)))
        .collect::<Vec<_>>()
        .join(", ");

    // An `always` identity refuses a supplied value unless the statement
    // overrides it, and a dump that cannot restore its own keys is not a dump.
    let overriding = if writable.iter().any(|c| c.identity == "a") {
        " OVERRIDING SYSTEM VALUE"
    } else {
        ""
    };

    let prefix = format!("INSERT INTO {target} ({names}){overriding} VALUES (");
    format!(
        "select {} || concat_ws(', ', {}) || {} from {}",
        sql_literal(&prefix),
        values,
        sql_literal(");"),
        target
    )
}

/// The `copy` that streams a table out as CSV, header row included.
pub fn copy_csv(schema: &str, table: &str) -> String {
    format!(
        "COPY {} TO STDOUT WITH (FORMAT csv, HEADER true)",
        qualified(schema, table)
    )
}

fn create_enum(t: &EnumType) -> String {
    let labels = t
        .labels
        .iter()
        .map(|l| sql_literal(l))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "CREATE TYPE {} AS ENUM ({});\n",
        qualified(&t.schema, &t.name),
        labels
    )
}

fn create_sequence(s: &Sequence) -> String {
    format!(
        "CREATE SEQUENCE {} AS {} INCREMENT BY {} MINVALUE {} MAXVALUE {} START WITH {}{};\n",
        qualified(&s.schema, &s.name),
        s.data_type,
        s.increment,
        s.min_value,
        s.max_value,
        s.start_value,
        if s.cycle { " CYCLE" } else { " NO CYCLE" }
    )
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Writes a formatted chunk, turning an IO failure into the one error type.
macro_rules! put {
    ($out:expr, $($arg:tt)*) => {
        $out.write(format!($($arg)*).as_bytes())?
    };
}

/// Runs one export over an already-open connection.
///
/// The connection is the caller's to provide precisely because it must not be
/// the session's: see `Session::dump`.
pub async fn run(
    conn: &mut PgConnection,
    req: &ExportRequest,
    out: &mut dyn DumpWriter,
    cancel: &AtomicBool,
) -> Result<DumpStats> {
    if req.objects.is_empty() {
        return Err(Error::other("Nothing was selected to export."));
    }

    match req.format {
        ExportFormat::Csv => csv(conn, req, out, cancel).await,
        ExportFormat::Sql => sql(conn, req, out, cancel).await,
    }
}

/// CSV: one relation per file, formatted entirely by the server.
async fn csv(
    conn: &mut PgConnection,
    req: &ExportRequest,
    out: &mut dyn DumpWriter,
    cancel: &AtomicBool,
) -> Result<DumpStats> {
    // A single CSV file holding several tables would be several different
    // header rows glued together, which no reader can take apart again.
    if req.layout == ExportLayout::Single && req.objects.len() > 1 {
        return Err(Error::other(
            "CSV holds one table per file. Choose one table, or export one file per table.",
        ));
    }

    let total = req.objects.len();
    let mut stats = DumpStats::default();

    for (i, object) in req.objects.iter().enumerate() {
        stopped(cancel)?;
        out.progress(&object.name, i, total);
        out.begin(&format!("{}.{}", object.schema, object.name))?;

        let statement = copy_csv(&object.schema, &object.name);
        let mut stream = conn.copy_out_raw(&statement).await?;
        let mut since_check = 0u64;
        while let Some(chunk) = stream.try_next().await? {
            out.write(&chunk)?;
            since_check += 1;
            if since_check >= CANCEL_CHECK_EVERY {
                since_check = 0;
                stopped(cancel)?;
            }
        }
        stats.tables += 1;
    }

    out.progress("", total, total);
    Ok(stats)
}

/// SQL, in whichever of the two layouts was asked for.
async fn sql(
    conn: &mut PgConnection,
    req: &ExportRequest,
    out: &mut dyn DumpWriter,
    cancel: &AtomicBool,
) -> Result<DumpStats> {
    let (database, version) = server(conn).await?;
    let total = req.objects.len();
    let mut stats = DumpStats::default();

    match req.layout {
        // One file, in restore order across the whole set: every definition
        // first, then every row, then everything that constrains a row. Putting
        // constraints last is what lets the relations be written in any order
        // at all — a foreign key never lands before the table it points at.
        ExportLayout::Single => {
            out.begin(&req.file_name)?;
            preamble(out, &database, &version)?;

            if req.mode.structure() {
                let mut seen = HashSet::new();
                for object in &req.objects {
                    types_and_sequences(conn, object, out, &mut seen).await?;
                }
                for object in &req.objects {
                    stopped(cancel)?;
                    structure(conn, object, req, out).await?;
                }
            }

            if req.mode.data() {
                for (i, object) in req.objects.iter().enumerate() {
                    out.progress(&object.name, i, total);
                    stats.rows += data(conn, object, out, cancel).await?;
                }
            }

            if req.mode.structure() {
                // Keys and indexes for every relation before any foreign key,
                // not relation by relation. A foreign key needs the key it
                // points at to exist already, and the relations are written in
                // whatever order the user picked them in — so the phases are
                // what orders the file, never the selection.
                for object in &req.objects {
                    stopped(cancel)?;
                    keys_and_indexes(conn, object, out).await?;
                }
                for object in &req.objects {
                    stopped(cancel)?;
                    foreign_keys(conn, object, out).await?;
                }
            }

            if req.mode.data() {
                for object in &req.objects {
                    sequence_values(conn, object, out).await?;
                }
            }

            stats.tables = req.objects.len();
        }

        // One file per relation, each self-contained: the same phases, but
        // scoped to the one relation, so any single file can be restored on its
        // own once its dependencies exist.
        ExportLayout::PerTable => {
            for (i, object) in req.objects.iter().enumerate() {
                stopped(cancel)?;
                out.progress(&object.name, i, total);
                out.begin(&format!("{}.{}", object.schema, object.name))?;
                preamble(out, &database, &version)?;

                if req.mode.structure() {
                    let mut seen = HashSet::new();
                    types_and_sequences(conn, object, out, &mut seen).await?;
                    structure(conn, object, req, out).await?;
                }
                if req.mode.data() {
                    stats.rows += data(conn, object, out, cancel).await?;
                }
                if req.mode.structure() {
                    keys_and_indexes(conn, object, out).await?;
                    foreign_keys(conn, object, out).await?;
                }
                if req.mode.data() {
                    sequence_values(conn, object, out).await?;
                }
                stats.tables += 1;
            }
        }
    }

    out.progress("", total, total);
    Ok(stats)
}

async fn server(conn: &mut PgConnection) -> Result<(String, String)> {
    let row = sqlx::query("select current_database(), version()")
        .fetch_one(&mut *conn)
        .await?;
    Ok((row.try_get::<String, _>(0)?, row.try_get::<String, _>(1)?))
}

/// The header and the session settings a restore needs.
///
/// `standard_conforming_strings` is the one that matters: `quote_nullable`
/// produced these literals under it, and restoring with it off would reinterpret
/// every backslash in the file.
fn preamble(out: &mut dyn DumpWriter, database: &str, version: &str) -> Result<()> {
    put!(out, "-- Rashbase Studio dump\n");
    put!(out, "-- database: {database}\n");
    put!(out, "-- server:   {version}\n\n");
    put!(out, "SET statement_timeout = 0;\n");
    put!(out, "SET client_encoding = 'UTF8';\n");
    put!(out, "SET standard_conforming_strings = on;\n");
    put!(out, "SET check_function_bodies = false;\n");
    put!(out, "SET client_min_messages = warning;\n\n");
    Ok(())
}

/// Types and sequences the relation depends on, each written once.
///
/// `seen` spans the whole file: two tables using the same enum must not each
/// declare it, or the second `create type` fails the restore.
async fn types_and_sequences(
    conn: &mut PgConnection,
    object: &ObjectRef,
    out: &mut dyn DumpWriter,
    seen: &mut HashSet<String>,
) -> Result<()> {
    if !object.has_own_rows() {
        return Ok(());
    }

    for t in enum_types(conn, &object.schema, &object.name).await? {
        if seen.insert(format!("type:{}.{}", t.schema, t.name)) {
            put!(out, "{}", create_enum(&t));
        }
    }
    for s in sequences(conn, &object.schema, &object.name).await? {
        if s.standalone && seen.insert(format!("seq:{}.{}", s.schema, s.name)) {
            put!(out, "{}", create_sequence(&s));
        }
    }
    put!(out, "\n");
    Ok(())
}

/// The relation itself: the optional drop, then its definition and comments.
async fn structure(
    conn: &mut PgConnection,
    object: &ObjectRef,
    req: &ExportRequest,
    out: &mut dyn DumpWriter,
) -> Result<()> {
    if req.drop_if_exists {
        put!(
            out,
            "{}",
            drop_statement(&object.schema, &object.name, &object.kind)
        );
    }

    match object.kind.as_str() {
        "view" => {
            let body = view_body(conn, &object.schema, &object.name).await?;
            put!(
                out,
                "CREATE VIEW {} AS\n{}\n",
                qualified(&object.schema, &object.name),
                body.trim_end()
            );
        }
        "matview" => {
            let body = view_body(conn, &object.schema, &object.name).await?;
            put!(
                out,
                "CREATE MATERIALIZED VIEW {} AS\n{}\n",
                qualified(&object.schema, &object.name),
                body.trim_end()
            );
        }
        _ => {
            let cols = columns(conn, &object.schema, &object.name).await?;
            put!(out, "{}", create_table(&object.schema, &object.name, &cols));
            for line in comments(conn, &object.schema, &object.name).await? {
                put!(out, "{line}\n");
            }
        }
    }
    put!(out, "\n");
    Ok(())
}

/// Keys, checks, and indexes: everything that belongs after the rows it would
/// otherwise slow down being loaded.
async fn keys_and_indexes(
    conn: &mut PgConnection,
    object: &ObjectRef,
    out: &mut dyn DumpWriter,
) -> Result<()> {
    if !object.has_own_rows() {
        return Ok(());
    }

    let target = qualified(&object.schema, &object.name);
    for c in constraints(conn, &object.schema, &object.name)
        .await?
        .iter()
        .filter(|c| c.kind != "f")
    {
        put!(
            out,
            "ALTER TABLE {} ADD CONSTRAINT {} {};\n",
            target,
            quote_ident(&c.name),
            c.definition
        );
    }
    for definition in indexes(conn, &object.schema, &object.name).await? {
        put!(out, "{definition};\n");
    }
    put!(out, "\n");
    Ok(())
}

/// Foreign keys, last of all: each one needs the key it points at to exist.
async fn foreign_keys(
    conn: &mut PgConnection,
    object: &ObjectRef,
    out: &mut dyn DumpWriter,
) -> Result<()> {
    if !object.has_own_rows() {
        return Ok(());
    }

    let target = qualified(&object.schema, &object.name);
    for c in constraints(conn, &object.schema, &object.name)
        .await?
        .iter()
        .filter(|c| c.kind == "f")
    {
        put!(
            out,
            "ALTER TABLE {} ADD CONSTRAINT {} {};\n",
            target,
            quote_ident(&c.name),
            c.definition
        );
    }
    Ok(())
}

/// Where each sequence had got to, so the restored table's next insert does not
/// collide with a key the dump already carried.
async fn sequence_values(
    conn: &mut PgConnection,
    object: &ObjectRef,
    out: &mut dyn DumpWriter,
) -> Result<()> {
    if !object.has_own_rows() {
        return Ok(());
    }
    for s in sequences(conn, &object.schema, &object.name).await? {
        if let Some(value) = s.last_value {
            put!(
                out,
                "SELECT pg_catalog.setval({}, {}, true);\n",
                sql_literal(&qualified(&s.schema, &s.name)),
                value
            );
        }
    }
    Ok(())
}

/// Streams one relation's rows as `insert` statements.
///
/// The rows are never collected: each one arrives as a finished statement and
/// goes straight to the writer, so a table larger than memory exports in
/// constant space.
async fn data(
    conn: &mut PgConnection,
    object: &ObjectRef,
    out: &mut dyn DumpWriter,
    cancel: &AtomicBool,
) -> Result<u64> {
    // A view's rows belong to its query and a materialized view's come back
    // with `refresh`; writing either as inserts would restore a copy that stops
    // agreeing with its own definition.
    if !object.has_own_rows() {
        return Ok(0);
    }

    let cols = columns(conn, &object.schema, &object.name).await?;
    if cols.iter().all(|c| !c.writable()) {
        return Ok(0);
    }

    put!(
        out,
        "-- data: {}\n",
        qualified(&object.schema, &object.name)
    );

    let statement = insert_select(&object.schema, &object.name, &cols);
    let mut rows = 0u64;
    {
        let mut stream = sqlx::query_scalar::<_, Option<String>>(&statement).fetch(&mut *conn);
        while let Some(line) = stream.try_next().await? {
            if let Some(line) = line {
                out.write(line.as_bytes())?;
                out.write(b"\n")?;
            }
            rows += 1;
            if rows.is_multiple_of(CANCEL_CHECK_EVERY) {
                stopped(cancel)?;
            }
        }
    }
    put!(out, "\n");
    Ok(rows)
}

/// Refuses to continue once the user has pressed Stop.
fn stopped(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        return Err(Error::Cancelled);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drivers::types::ExportMode;

    fn column(name: &str, data_type: &str) -> DumpColumn {
        DumpColumn {
            name: name.to_string(),
            data_type: data_type.to_string(),
            not_null: false,
            default: None,
            identity: String::new(),
            generated: String::new(),
        }
    }

    /// The one literal this module builds by hand. An identifier carrying an
    /// apostrophe would otherwise close the string early and the generated
    /// statement would run as something nobody wrote.
    #[test]
    fn escapes_the_literals_it_composes() {
        assert_eq!(sql_literal("plain"), "'plain'");
        assert_eq!(sql_literal("it's"), "'it''s'");
        assert_eq!(
            sql_literal("'; drop table users; --"),
            "'''; drop table users; --'"
        );
    }

    /// A type modifier that gets truncated changes what the restored column can
    /// hold, silently.
    #[test]
    fn keeps_the_catalogue_type_verbatim() {
        let mut amount = column("amount", "numeric(10,2)");
        amount.not_null = true;
        amount.default = Some("0".to_string());
        assert_eq!(
            column_clause(&amount),
            "    \"amount\" numeric(10,2) DEFAULT 0 NOT NULL"
        );
    }

    #[test]
    fn writes_identity_and_generated_columns_as_declarations_not_defaults() {
        let mut always = column("id", "integer");
        always.identity = "a".to_string();
        always.not_null = true;
        assert_eq!(
            column_clause(&always),
            "    \"id\" integer GENERATED ALWAYS AS IDENTITY NOT NULL"
        );

        let mut by_default = column("seq", "bigint");
        by_default.identity = "d".to_string();
        assert!(column_clause(&by_default).contains("GENERATED BY DEFAULT AS IDENTITY"));

        // A generated column stores its expression where a default would live,
        // so reading it as a default would emit something Postgres rejects.
        let mut total = column("total", "numeric");
        total.generated = "s".to_string();
        total.default = Some("(qty * price)".to_string());
        assert_eq!(
            column_clause(&total),
            "    \"total\" numeric GENERATED ALWAYS AS ((qty * price)) STORED"
        );
        assert!(!column_clause(&total).contains("DEFAULT"));
    }

    #[test]
    fn quotes_every_identifier_in_a_create_table() {
        let cols = vec![column("select", "text"), column("we\"ird", "integer")];
        let ddl = create_table("pu\"blic", "us'ers", &cols);
        assert!(ddl.starts_with("CREATE TABLE \"pu\"\"blic\".\"us'ers\" (\n"));
        assert!(ddl.contains("    \"select\" text"));
        assert!(ddl.contains("    \"we\"\"ird\" integer"));
        assert!(ddl.ends_with(");\n"));
    }

    /// Every value in the file is quoted by the server. If a value ever reached
    /// the statement any other way, a dump would stop being safe to restore.
    #[test]
    fn puts_every_value_through_the_server_quoting() {
        let cols = vec![column("id", "integer"), column("email", "text")];
        let sql = insert_select("public", "users", &cols);
        assert_eq!(
            sql,
            "select 'INSERT INTO \"public\".\"users\" (\"id\", \"email\") VALUES (' \
             || concat_ws(', ', quote_nullable(\"id\"::text), quote_nullable(\"email\"::text)) \
             || ');' from \"public\".\"users\""
        );
    }

    #[test]
    fn leaves_generated_columns_out_of_the_insert() {
        let mut total = column("total", "numeric");
        total.generated = "s".to_string();
        let cols = vec![column("id", "integer"), total];
        let sql = insert_select("public", "lines", &cols);
        assert!(sql.contains("(\"id\")"));
        assert!(!sql.contains("total"));
    }

    /// Without the override a dump of an `always` identity cannot restore its
    /// own primary keys, which is the failure that makes an export useless.
    #[test]
    fn overrides_an_always_identity_so_keys_survive_the_restore() {
        let mut id = column("id", "integer");
        id.identity = "a".to_string();
        let sql = insert_select("public", "users", &[id]);
        assert!(sql.contains("(\"id\") OVERRIDING SYSTEM VALUE VALUES ("));

        let mut by_default = column("id", "integer");
        by_default.identity = "d".to_string();
        let sql = insert_select("public", "users", &[by_default]);
        assert!(!sql.contains("OVERRIDING"));
    }

    /// An apostrophe in a table name would end the composed literal early.
    #[test]
    fn survives_an_apostrophe_in_a_relation_name() {
        let sql = insert_select("public", "user's", &[column("id", "integer")]);
        assert!(sql.contains("'INSERT INTO \"public\".\"user''s\" (\"id\") VALUES ('"));
        assert!(sql.ends_with("from \"public\".\"user's\""));
    }

    #[test]
    fn names_the_right_thing_to_drop() {
        assert_eq!(
            drop_statement("public", "users", "table"),
            "DROP TABLE IF EXISTS \"public\".\"users\" CASCADE;\n"
        );
        assert_eq!(
            drop_statement("public", "active", "view"),
            "DROP VIEW IF EXISTS \"public\".\"active\" CASCADE;\n"
        );
        assert_eq!(
            drop_statement("public", "daily", "matview"),
            "DROP MATERIALIZED VIEW IF EXISTS \"public\".\"daily\" CASCADE;\n"
        );
    }

    #[test]
    fn copies_csv_with_a_header() {
        assert_eq!(
            copy_csv("public", "users"),
            "COPY \"public\".\"users\" TO STDOUT WITH (FORMAT csv, HEADER true)"
        );
    }

    /// The modes are what the include control means, and getting one backwards
    /// would write the opposite of what the user chose.
    #[test]
    fn modes_say_what_they_include() {
        assert!(ExportMode::Structure.structure() && !ExportMode::Structure.data());
        assert!(!ExportMode::Data.structure() && ExportMode::Data.data());
        assert!(ExportMode::Full.structure() && ExportMode::Full.data());
    }

    /// Only a real table's rows are its own. Dumping a view's rows as inserts
    /// restores a copy that immediately disagrees with its own definition.
    #[test]
    fn only_tables_carry_rows_worth_dumping() {
        let of = |kind: &str| ObjectRef {
            schema: "public".into(),
            name: "x".into(),
            kind: kind.into(),
        };
        assert!(of("table").has_own_rows());
        assert!(of("foreign").has_own_rows());
        assert!(!of("view").has_own_rows());
        assert!(!of("matview").has_own_rows());
    }
}
