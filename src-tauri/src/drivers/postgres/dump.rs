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
pub(super) fn sql_literal(value: &str) -> String {
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

/// The columns of the relation's primary key, in key order.
///
/// The conflict target of a safe export's upsert. Read from `pg_index` rather
/// than parsed out of `pg_get_constraintdef`, because "the text between the
/// parentheses" stops being the column list the moment a key is on an
/// expression or an identifier holds a comma.
async fn primary_key_columns(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> Result<Vec<String>> {
    let rows = sqlx::query(
        r#"
        select a.attname
        from pg_catalog.pg_index i
        join pg_catalog.pg_class c on c.oid = i.indrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_attribute a
          on a.attrelid = c.oid and a.attnum = any(i.indkey)
        where n.nspname = $1
          and c.relname = $2
          and i.indisprimary
        order by array_position(i.indkey, a.attnum)
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

/// Extensions that own a type one of the relation's columns uses.
///
/// A `citext` column restores into `type "citext" does not exist` on a database
/// where nobody happened to have run `create extension` first, and that reads as
/// the dump being wrong rather than the target being short of a package.
///
/// Types only. An extension reached solely through a function called in a
/// default would need the default parsed, and a wrong guess here writes a
/// `create extension` the target may not have available to install.
async fn extensions(conn: &mut PgConnection, schema: &str, table: &str) -> Result<Vec<String>> {
    let rows = sqlx::query(
        r#"
        select distinct e.extname
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_type t on t.oid = a.atttypid
        join pg_catalog.pg_depend d
              -- An array type belongs to whatever owns its element type.
          on d.objid = case when t.typelem <> 0 and t.typlen = -1 then t.typelem else t.oid end
         and d.classid = 'pg_catalog.pg_type'::regclass
         and d.deptype = 'e'
        join pg_catalog.pg_extension e on e.oid = d.refobjid
        where n.nspname = $1
          and c.relname = $2
          and a.attnum > 0
          and not a.attisdropped
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
///
/// `safe` adds `if not exists`, which is what lets the same file be run against
/// a database that already has the table without the restore stopping on the
/// first relation it recognises.
pub fn create_table(schema: &str, table: &str, cols: &[DumpColumn], safe: bool) -> String {
    let body = cols
        .iter()
        .map(column_clause)
        .collect::<Vec<_>>()
        .join(",\n");
    format!(
        "CREATE TABLE {}{} (\n{}\n);\n",
        if safe { "IF NOT EXISTS " } else { "" },
        qualified(schema, table),
        body
    )
}

/// Brings a table that already exists up to the columns this dump knows about.
///
/// `create table if not exists` on its own is a lie by omission: it succeeds
/// against a table missing half the columns, and the failure surfaces later as
/// `column "nickname" of relation "users" does not exist` on an `insert` nobody
/// can read. One guarded `add column` per column closes that gap.
///
/// Only ever *adds*. A column whose type has drifted is a migration, and
/// guessing at an `alter column type` is how an export starts destroying data.
pub fn add_columns(schema: &str, table: &str, cols: &[DumpColumn]) -> String {
    let target = qualified(schema, table);
    let mut out = String::new();
    for c in cols {
        let clause = column_clause(c);
        let clause = clause.trim_start();
        // `not null` with nothing to fill the existing rows with is rejected
        // outright, and a restore that stops here has reconciled nothing. The
        // column arrives nullable and the file says so, which is the difference
        // between a dump that lands and a dump that argues.
        let (clause, note) = if c.not_null && c.default.is_none() && c.identity.is_empty() {
            (
                clause.trim_end().trim_end_matches(" NOT NULL"),
                "  -- nullable here: existing rows have nothing to fill it with\n",
            )
        } else {
            (clause, "")
        };
        out.push_str(&format!(
            "ALTER TABLE {target} ADD COLUMN IF NOT EXISTS {clause};\n{note}"
        ));
    }
    out
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
pub fn insert_select(
    schema: &str,
    table: &str,
    cols: &[DumpColumn],
    conflict: Option<&[String]>,
) -> String {
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
    let suffix = match conflict {
        None => ");".to_string(),
        Some(key) => format!(") {};", on_conflict(key, &writable)),
    };
    format!(
        "select {} || concat_ws(', ', {}) || {} from {}",
        sql_literal(&prefix),
        values,
        sql_literal(&suffix),
        target
    )
}

/// What a safe export does when the row is already there.
///
/// The whole point of the mode: a second run of the same file has to converge
/// rather than stop on `duplicate key value violates unique constraint`. With a
/// primary key to aim at, the row is updated to what the dump carries; without
/// one there is nothing to name as the conflict target, so the row is skipped
/// and the statement still succeeds.
///
/// An `always` identity is left out of the update: it refuses to be assigned,
/// and `overriding system value` is an `insert` clause with no `update` half.
fn on_conflict(key: &[String], writable: &[&DumpColumn]) -> String {
    if key.is_empty() {
        return "ON CONFLICT DO NOTHING".to_string();
    }

    let target = key
        .iter()
        .map(|k| quote_ident(k))
        .collect::<Vec<_>>()
        .join(", ");

    let updates: Vec<String> = writable
        .iter()
        .filter(|c| c.identity != "a" && !key.iter().any(|k| k == &c.name))
        .map(|c| {
            let name = quote_ident(&c.name);
            format!("{name} = EXCLUDED.{name}")
        })
        .collect();

    // Every column is part of the key, so an update would set nothing and
    // Postgres rejects an empty `set` list.
    if updates.is_empty() {
        return format!("ON CONFLICT ({target}) DO NOTHING");
    }
    format!("ON CONFLICT ({target}) DO UPDATE SET {}", updates.join(", "))
}

/// The `copy` that streams a table out as CSV, header row included.
pub fn copy_csv(schema: &str, table: &str) -> String {
    format!(
        "COPY {} TO STDOUT WITH (FORMAT csv, HEADER true)",
        qualified(schema, table)
    )
}

/// A statement that adds a constraint, and in safe mode removes the one already
/// wearing its name first.
///
/// `add constraint` has no `if not exists`, so a second run of a dump that
/// carries one stops on `constraint "orders_total_check" already exists`.
/// Dropping by name first is both the guard and the reconcile: a constraint
/// whose definition has drifted comes back as the definition the dump carries.
///
/// Only for the kinds nothing else can be built on — checks and foreign keys.
/// See `guarded_constraint` for the two that can.
pub fn constraint_statement(target: &str, name: &str, definition: &str, safe: bool) -> String {
    let name = quote_ident(name);
    let drop = if safe {
        format!("ALTER TABLE {target} DROP CONSTRAINT IF EXISTS {name};\n")
    } else {
        String::new()
    };
    format!("{drop}ALTER TABLE {target} ADD CONSTRAINT {name} {definition};\n")
}

/// Adds a key only if the table has not got one by that name already.
///
/// Primary and unique keys are the two a foreign key can point at, and the
/// pointer may come from a table nobody selected for this export. Dropping one
/// to re-add it would fail on `cannot drop constraint ... because other objects
/// depend on it`, which turns the safe mode into the least safe one there is.
/// So it is read first and left alone if it is there.
///
/// The cost is that a key whose definition has drifted is not reconciled. That
/// is the right trade: a wrong key is a schema the user has to look at, an
/// aborted restore is one they cannot get past.
pub fn guarded_constraint(target: &str, name: &str, definition: &str) -> String {
    format!(
        "DO $$ BEGIN\n    \
         IF NOT EXISTS (\n        \
             SELECT 1 FROM pg_catalog.pg_constraint\n         \
             WHERE conrelid = {}::regclass AND conname = {}\n    \
         ) THEN\n        \
         ALTER TABLE {target} ADD CONSTRAINT {} {definition};\n    \
         END IF;\nEND $$;\n",
        sql_literal(target),
        sql_literal(name),
        quote_ident(name),
    )
}

/// Removes a constraint if it is there at all, on a table that may not be.
///
/// The prologue of a safe export. Both guards are needed and for different
/// reasons: `alter table if exists` because a structure restore has not created
/// the table yet, `drop constraint if exists` because a data-only restore into
/// a database that never had the constraint is not an error worth stopping for.
pub fn drop_constraint_statement(target: &str, name: &str) -> String {
    format!(
        "ALTER TABLE IF EXISTS {target} DROP CONSTRAINT IF EXISTS {};\n",
        quote_ident(name)
    )
}

/// The server's own `create index` with the guard wedged in.
///
/// String surgery on generated SQL is usually the wrong instinct. It is honest
/// here because `pg_get_indexdef` has exactly two shapes and both start with a
/// fixed keyword sequence — there is no index whose definition begins with
/// anything else.
pub fn guarded_index(definition: &str) -> String {
    for prefix in ["CREATE UNIQUE INDEX ", "CREATE INDEX "] {
        if let Some(rest) = definition.strip_prefix(prefix) {
            return format!("{prefix}IF NOT EXISTS {rest}");
        }
    }
    definition.to_string()
}

/// The enum, and in safe mode the labels it may be short of.
///
/// `create type` has no `if not exists`, so the guard has to be a `do` block
/// reading the catalogue. `to_regtype` answers with NULL rather than raising
/// when the type is absent, which is the whole reason it can be asked at all.
///
/// The `add value` lines exist because a type that is already there is not
/// necessarily the same type: a label added since the last export would
/// otherwise make every row carrying it fail on `invalid input value for enum`.
fn create_enum(t: &EnumType, safe: bool) -> String {
    let labels = t
        .labels
        .iter()
        .map(|l| sql_literal(l))
        .collect::<Vec<_>>()
        .join(", ");
    let name = qualified(&t.schema, &t.name);

    if !safe {
        return format!("CREATE TYPE {name} AS ENUM ({labels});\n");
    }

    let mut out = format!(
        "DO $$ BEGIN\n    IF to_regtype({}) IS NULL THEN\n        CREATE TYPE {name} AS ENUM ({labels});\n    END IF;\nEND $$;\n",
        sql_literal(&name)
    );
    for label in &t.labels {
        out.push_str(&format!(
            "ALTER TYPE {name} ADD VALUE IF NOT EXISTS {};\n",
            sql_literal(label)
        ));
    }
    out
}

fn create_sequence(s: &Sequence, safe: bool) -> String {
    format!(
        "CREATE SEQUENCE {}{} AS {} INCREMENT BY {} MINVALUE {} MAXVALUE {} START WITH {}{};\n",
        if safe { "IF NOT EXISTS " } else { "" },
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

    // What safe mode sells is a restore order and one transaction around it.
    // Loose per-relation files have neither: whoever runs them chooses the
    // order, and a failure in the fourth file leaves the first three applied.
    if req.safe && req.layout == ExportLayout::PerTable {
        return Err(Error::other(
            "A safe export is written as one file, in restore order.",
        ));
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
    let safe = req.safe;

    match req.layout {
        // One file, in restore order across the whole set: every definition
        // first, then every row, then everything that constrains a row. Putting
        // constraints last is what lets the relations be written in any order
        // at all — a foreign key never lands before the table it points at.
        ExportLayout::Single => {
            out.begin(&req.file_name)?;
            preamble(out, &database, &version, safe)?;

            if safe {
                // Schemas, extensions, and enum labels, before the transaction
                // opens: `alter type ... add value` cannot add a label and have
                // it used by the same transaction, and every row carrying a new
                // label is in this file.
                preflight(conn, req, out).await?;
                put!(out, "BEGIN;\n\n");

                // Whatever would stand between the rows and the table they go
                // in. Removed first and restored at the end, which is the only
                // order that works when the target already holds the schema.
                put!(out, "-- constraints, taken off until the rows are in\n");
                for object in &req.objects {
                    stopped(cancel)?;
                    drop_constraints(conn, object, out).await?;
                }
                put!(out, "\n");
            }

            if req.mode.structure() {
                let mut seen = HashSet::new();
                for object in &req.objects {
                    types_and_sequences(conn, object, out, &mut seen, safe).await?;
                }
                for object in &req.objects {
                    stopped(cancel)?;
                    structure(conn, object, req, out).await?;
                }

                // A safe export upserts, and `on conflict (id)` needs the key
                // it names to exist by the time the first row arrives. The
                // primary key is the one constraint that cannot wait.
                if safe {
                    for object in &req.objects {
                        stopped(cancel)?;
                        add_constraints(conn, object, out, &["p"], safe).await?;
                    }
                }
            }

            if req.mode.data() {
                for (i, object) in req.objects.iter().enumerate() {
                    out.progress(&object.name, i, total);
                    stats.rows += data(conn, object, out, cancel, safe).await?;
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
                    keys_and_indexes(conn, object, out, safe).await?;
                }
            } else if safe {
                // Rows only, so nothing above created these. The prologue still
                // took them off, and a restore that leaves a table with fewer
                // constraints than it started with is not safe by any reading.
                for object in &req.objects {
                    stopped(cancel)?;
                    add_constraints(conn, object, out, &["c"], safe).await?;
                }
            }

            if req.mode.structure() || safe {
                for object in &req.objects {
                    stopped(cancel)?;
                    foreign_keys(conn, object, out, safe).await?;
                }
            }

            if req.mode.data() {
                for object in &req.objects {
                    sequence_values(conn, object, out, safe).await?;
                }
            }

            if safe {
                // All of it or none of it. A restore that fails halfway leaves
                // the target exactly as it was, which is what makes trying one
                // a decision the user can take back.
                put!(out, "\nCOMMIT;\n");
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
                preamble(out, &database, &version, false)?;

                if req.mode.structure() {
                    let mut seen = HashSet::new();
                    types_and_sequences(conn, object, out, &mut seen, false).await?;
                    structure(conn, object, req, out).await?;
                }
                if req.mode.data() {
                    stats.rows += data(conn, object, out, cancel, false).await?;
                }
                if req.mode.structure() {
                    keys_and_indexes(conn, object, out, false).await?;
                    foreign_keys(conn, object, out, false).await?;
                }
                if req.mode.data() {
                    sequence_values(conn, object, out, false).await?;
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
fn preamble(
    out: &mut dyn DumpWriter,
    database: &str,
    version: &str,
    safe: bool,
) -> Result<()> {
    put!(out, "-- Rashbase Studio dump{}\n", if safe { " (safe)" } else { "" });
    put!(out, "-- database: {database}\n");
    put!(out, "-- server:   {version}\n");
    if safe {
        put!(out, "--\n");
        put!(out, "-- Safe: this file can be restored into an empty database, into a\n");
        put!(out, "-- database that already holds some of it, or twice in a row. It runs\n");
        put!(out, "-- in one transaction: if any statement fails, nothing is applied.\n");
    }
    put!(out, "\n");
    put!(out, "SET statement_timeout = 0;\n");
    put!(out, "SET client_encoding = 'UTF8';\n");
    put!(out, "SET standard_conforming_strings = on;\n");
    put!(out, "SET check_function_bodies = false;\n");
    put!(out, "SET client_min_messages = warning;\n\n");
    Ok(())
}

/// What a safe restore needs in place before the transaction can even start.
///
/// Schemas and extensions because a relation cannot be created in a schema that
/// is not there and a `citext` column cannot be created at all without the
/// extension behind it. Enums because `alter type ... add value` is the one
/// statement here that a transaction block will not let the same transaction
/// use — a label added and then written to would fail on `unsafe use of new
/// value of enum type`.
async fn preflight(
    conn: &mut PgConnection,
    req: &ExportRequest,
    out: &mut dyn DumpWriter,
) -> Result<()> {
    let mut seen = HashSet::new();

    for object in &req.objects {
        if seen.insert(format!("schema:{}", object.schema)) {
            put!(
                out,
                "CREATE SCHEMA IF NOT EXISTS {};\n",
                quote_ident(&object.schema)
            );
        }
    }

    for object in &req.objects {
        if !object.has_own_rows() {
            continue;
        }
        for name in extensions(conn, &object.schema, &object.name).await? {
            if seen.insert(format!("ext:{name}")) {
                put!(
                    out,
                    "CREATE EXTENSION IF NOT EXISTS {};\n",
                    quote_ident(&name)
                );
            }
        }
    }

    for object in &req.objects {
        if !object.has_own_rows() {
            continue;
        }
        for t in enum_types(conn, &object.schema, &object.name).await? {
            if seen.insert(format!("type:{}.{}", t.schema, t.name)) {
                put!(out, "{}", create_enum(&t, true));
            }
        }
    }

    put!(out, "\n");
    Ok(())
}

/// Types and sequences the relation depends on, each written once.
///
/// `seen` spans the whole file: two tables using the same enum must not each
/// declare it, or the second `create type` fails the restore.
///
/// Under `safe` the enums are already in the preflight above, so only the
/// sequences are left here — inside the transaction, where they belong.
async fn types_and_sequences(
    conn: &mut PgConnection,
    object: &ObjectRef,
    out: &mut dyn DumpWriter,
    seen: &mut HashSet<String>,
    safe: bool,
) -> Result<()> {
    if !object.has_own_rows() {
        return Ok(());
    }

    if !safe {
        for t in enum_types(conn, &object.schema, &object.name).await? {
            if seen.insert(format!("type:{}.{}", t.schema, t.name)) {
                put!(out, "{}", create_enum(&t, false));
            }
        }
    }
    for s in sequences(conn, &object.schema, &object.name).await? {
        if s.standalone && seen.insert(format!("seq:{}.{}", s.schema, s.name)) {
            put!(out, "{}", create_sequence(&s, safe));
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
    // Never under `safe`: dropping the relation would take the target's rows
    // with it, which is the one outcome the mode exists to rule out. The two
    // are held apart in the dialog as well; this is the backend agreeing.
    if req.drop_if_exists && !req.safe {
        put!(
            out,
            "{}",
            drop_statement(&object.schema, &object.name, &object.kind)
        );
    }

    let target = qualified(&object.schema, &object.name);
    match object.kind.as_str() {
        // `create or replace` rather than a drop, in both modes: a view holds
        // nothing, and dropping one takes every view built on it with it — the
        // target's, not the dump's.
        "view" => {
            let body = view_body(conn, &object.schema, &object.name).await?;
            put!(
                out,
                "CREATE{} VIEW {} AS\n{}\n",
                if req.safe { " OR REPLACE" } else { "" },
                target,
                body.trim_end()
            );
        }
        "matview" => {
            let body = view_body(conn, &object.schema, &object.name).await?;
            put!(
                out,
                "CREATE MATERIALIZED VIEW {}{} AS\n{}\n",
                if req.safe { "IF NOT EXISTS " } else { "" },
                target,
                body.trim_end()
            );
        }
        _ => {
            let cols = columns(conn, &object.schema, &object.name).await?;
            put!(
                out,
                "{}",
                create_table(&object.schema, &object.name, &cols, req.safe)
            );
            // `if not exists` on its own says nothing about a table that exists
            // and is short a column. This is what makes the restore converge
            // rather than merely not fail.
            if req.safe {
                put!(
                    out,
                    "-- brings a table that was already there up to these columns; every\n\
                     -- line below does nothing on a restore that just created it\n"
                );
                put!(out, "{}", add_columns(&object.schema, &object.name, &cols));
            }
            for line in comments(conn, &object.schema, &object.name).await? {
                put!(out, "{line}\n");
            }
        }
    }
    put!(out, "\n");
    Ok(())
}

/// Removes the constraints that stand between a row and the table it goes in.
///
/// The prologue of a safe export, and the reason `data only` into a database
/// that already has the schema stops being a guessing game about which table to
/// select first: with the foreign keys off, the order of the inserts no longer
/// decides whether they succeed. Both are added back before the transaction
/// commits, so the target never ends up with fewer than it started with.
async fn drop_constraints(
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
        .filter(|c| c.kind == "f" || c.kind == "c")
    {
        put!(out, "{}", drop_constraint_statement(&target, &c.name));
    }
    Ok(())
}

/// Adds back the constraints of the given kinds, in the order the server lists
/// them.
///
/// `p` primary key, `u` unique, `c` check, `f` foreign key. Which kinds land in
/// which phase is the whole shape of the file, so the caller says rather than
/// this deciding.
async fn add_constraints(
    conn: &mut PgConnection,
    object: &ObjectRef,
    out: &mut dyn DumpWriter,
    kinds: &[&str],
    safe: bool,
) -> Result<()> {
    if !object.has_own_rows() {
        return Ok(());
    }

    let target = qualified(&object.schema, &object.name);
    for c in constraints(conn, &object.schema, &object.name)
        .await?
        .iter()
        .filter(|c| kinds.contains(&c.kind.as_str()))
    {
        // A key something else may be pointing at cannot be dropped to be
        // re-added; everything else can, and is, so a drifted definition comes
        // back as the one the dump carries.
        let statement = if safe && (c.kind == "p" || c.kind == "u") {
            guarded_constraint(&target, &c.name, &c.definition)
        } else {
            constraint_statement(&target, &c.name, &c.definition, safe)
        };
        put!(out, "{statement}");
    }
    Ok(())
}

/// Keys, checks, and indexes: everything that belongs after the rows it would
/// otherwise slow down being loaded.
///
/// Under `safe` the primary key is not here — it went in ahead of the data,
/// because the upsert names it as its conflict target.
async fn keys_and_indexes(
    conn: &mut PgConnection,
    object: &ObjectRef,
    out: &mut dyn DumpWriter,
    safe: bool,
) -> Result<()> {
    if !object.has_own_rows() {
        return Ok(());
    }

    let kinds: &[&str] = if safe { &["u", "c"] } else { &["p", "u", "c"] };
    add_constraints(conn, object, out, kinds, safe).await?;

    for definition in indexes(conn, &object.schema, &object.name).await? {
        let definition = if safe {
            guarded_index(&definition)
        } else {
            definition
        };
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
    safe: bool,
) -> Result<()> {
    add_constraints(conn, object, out, &["f"], safe).await
}

/// Where each sequence had got to, so the restored table's next insert does not
/// collide with a key the dump already carried.
///
/// The `where` is the guard a safe restore needs: `setval` on a sequence that is
/// not there raises, and a data-only restore has created no sequences at all.
async fn sequence_values(
    conn: &mut PgConnection,
    object: &ObjectRef,
    out: &mut dyn DumpWriter,
    safe: bool,
) -> Result<()> {
    if !object.has_own_rows() {
        return Ok(());
    }
    for s in sequences(conn, &object.schema, &object.name).await? {
        if let Some(value) = s.last_value {
            let name = sql_literal(&qualified(&s.schema, &s.name));
            let guard = if safe {
                format!(" WHERE to_regclass({name}) IS NOT NULL")
            } else {
                String::new()
            };
            put!(
                out,
                "SELECT pg_catalog.setval({name}, {value}, true){guard};\n"
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
    safe: bool,
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

    // The conflict target, and the reason a safe dump can be run twice. Without
    // a primary key there is nothing to name, so the row is skipped rather than
    // updated — worth saying in the file, because "some rows did not change" is
    // otherwise indistinguishable from a bug.
    let key = if safe {
        let key = primary_key_columns(conn, &object.schema, &object.name).await?;
        if key.is_empty() {
            put!(
                out,
                "-- no primary key: a row already present is left as it is\n"
            );
        }
        Some(key)
    } else {
        None
    };

    let statement = insert_select(&object.schema, &object.name, &cols, key.as_deref());
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
        let ddl = create_table("pu\"blic", "us'ers", &cols, false);
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
        let sql = insert_select("public", "users", &cols, None);
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
        let sql = insert_select("public", "lines", &cols, None);
        assert!(sql.contains("(\"id\")"));
        assert!(!sql.contains("total"));
    }

    /// Without the override a dump of an `always` identity cannot restore its
    /// own primary keys, which is the failure that makes an export useless.
    #[test]
    fn overrides_an_always_identity_so_keys_survive_the_restore() {
        let mut id = column("id", "integer");
        id.identity = "a".to_string();
        let sql = insert_select("public", "users", &[id], None);
        assert!(sql.contains("(\"id\") OVERRIDING SYSTEM VALUE VALUES ("));

        let mut by_default = column("id", "integer");
        by_default.identity = "d".to_string();
        let sql = insert_select("public", "users", &[by_default], None);
        assert!(!sql.contains("OVERRIDING"));
    }

    /// An apostrophe in a table name would end the composed literal early.
    #[test]
    fn survives_an_apostrophe_in_a_relation_name() {
        let sql = insert_select("public", "user's", &[column("id", "integer")], None);
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

    // -----------------------------------------------------------------------
    // Safe export
    //
    // Every one of these is a sentence a restore prints when the guard is
    // missing. They are worth pinning individually because each failure stops
    // the file at a different line and reads like a different bug.
    // -----------------------------------------------------------------------

    /// `relation "users" already exists`.
    #[test]
    fn a_safe_create_does_not_argue_with_what_is_already_there() {
        let cols = vec![column("id", "integer")];
        assert!(create_table("public", "users", &cols, true)
            .starts_with("CREATE TABLE IF NOT EXISTS \"public\".\"users\""));
        assert!(create_table("public", "users", &cols, false)
            .starts_with("CREATE TABLE \"public\".\"users\""));
    }

    /// `column "nickname" of relation "users" does not exist`, three hundred
    /// lines after the `create table if not exists` that skipped over it.
    #[test]
    fn a_table_that_is_already_there_gets_the_columns_it_is_missing() {
        let mut nickname = column("nickname", "text");
        nickname.default = Some("''".to_string());
        nickname.not_null = true;

        let sql = add_columns("public", "users", &[column("id", "integer"), nickname]);
        assert!(sql.contains("ALTER TABLE \"public\".\"users\" ADD COLUMN IF NOT EXISTS \"id\" integer;"));
        assert!(sql.contains("\"nickname\" text DEFAULT '' NOT NULL;"));
    }

    /// `column "nickname" of relation "users" contains null values` — the
    /// reconcile cannot demand of the rows already there what it has nothing to
    /// fill them with.
    #[test]
    fn a_column_added_to_a_populated_table_arrives_nullable() {
        let mut nickname = column("nickname", "text");
        nickname.not_null = true;
        let sql = add_columns("public", "users", &[nickname]);
        assert!(sql.contains("ADD COLUMN IF NOT EXISTS \"nickname\" text;"));
        assert!(!sql.contains("NOT NULL"));
        assert!(sql.contains("-- nullable here"));
    }

    /// `duplicate key value violates unique constraint "users_pkey"`, which is
    /// what every second run of an ordinary dump ends on.
    #[test]
    fn a_row_that_is_already_there_is_brought_up_to_date() {
        let cols = vec![column("id", "integer"), column("email", "text")];
        let key = vec!["id".to_string()];
        let sql = insert_select("public", "users", &cols, Some(&key));
        assert!(sql.ends_with(
            "|| ') ON CONFLICT (\"id\") DO UPDATE SET \"email\" = EXCLUDED.\"email\";' \
             from \"public\".\"users\""
        ));
    }

    #[test]
    fn a_composite_key_names_every_column_it_is_made_of() {
        let cols = vec![
            column("order_id", "integer"),
            column("line", "integer"),
            column("qty", "integer"),
        ];
        let key = vec!["order_id".to_string(), "line".to_string()];
        let sql = insert_select("public", "lines", &cols, Some(&key));
        assert!(sql.contains("ON CONFLICT (\"order_id\", \"line\") DO UPDATE SET \"qty\" = EXCLUDED.\"qty\""));
    }

    /// Without a key there is nothing to name as the conflict target, and
    /// `on conflict` with no target and an update half does not parse.
    #[test]
    fn a_table_with_no_key_skips_rather_than_fails() {
        let cols = vec![column("event", "text")];
        let sql = insert_select("public", "log", &cols, Some(&[]));
        assert!(sql.contains("ON CONFLICT DO NOTHING"));
        assert!(!sql.contains("DO UPDATE"));
    }

    /// `syntax error at or near ";"` — an empty `set` list is not a statement.
    #[test]
    fn a_table_that_is_all_key_has_nothing_left_to_update() {
        let cols = vec![column("tag_id", "integer"), column("post_id", "integer")];
        let key = vec!["tag_id".to_string(), "post_id".to_string()];
        let sql = insert_select("public", "tagged", &cols, Some(&key));
        assert!(sql.contains("ON CONFLICT (\"tag_id\", \"post_id\") DO NOTHING"));
    }

    /// `column "id" can only be updated to DEFAULT`. An `always` identity takes
    /// a value on the way in through `overriding system value`, which has no
    /// `update` half to hide behind.
    #[test]
    fn an_always_identity_is_never_updated() {
        let mut serial = column("serial", "integer");
        serial.identity = "a".to_string();
        let cols = vec![column("id", "integer"), serial, column("email", "text")];
        let key = vec!["id".to_string()];
        let sql = insert_select("public", "users", &cols, Some(&key));
        assert!(sql.contains("DO UPDATE SET \"email\" = EXCLUDED.\"email\";"));
        assert!(!sql.contains("\"serial\" = EXCLUDED"));
    }

    /// `constraint "child_qty_positive" already exists`. There is no
    /// `add constraint if not exists`, so the name has to be cleared first —
    /// which doubles as the reconcile when the definition has drifted.
    #[test]
    fn a_constraint_makes_room_for_itself_before_it_lands() {
        let safe = constraint_statement("\"public\".\"users\"", "users_age", "CHECK (age > 0)", true);
        assert_eq!(
            safe,
            "ALTER TABLE \"public\".\"users\" DROP CONSTRAINT IF EXISTS \"users_age\";\n\
             ALTER TABLE \"public\".\"users\" ADD CONSTRAINT \"users_age\" CHECK (age > 0);\n"
        );
        assert_eq!(
            constraint_statement("\"public\".\"users\"", "users_age", "CHECK (age > 0)", false),
            "ALTER TABLE \"public\".\"users\" ADD CONSTRAINT \"users_age\" CHECK (age > 0);\n"
        );
    }

    /// `cannot drop constraint "users_pkey" ... because other objects depend on
    /// it`. The foreign key holding it down may be on a table nobody selected,
    /// so a key is read for rather than replaced.
    #[test]
    fn a_key_something_may_point_at_is_never_dropped() {
        let sql = guarded_constraint("\"public\".\"users\"", "users_pkey", "PRIMARY KEY (id)");
        assert!(sql.contains("SELECT 1 FROM pg_catalog.pg_constraint"));
        assert!(sql.contains("WHERE conrelid = '\"public\".\"users\"'::regclass"));
        assert!(sql.contains("conname = 'users_pkey'"));
        assert!(sql.contains(
            "ALTER TABLE \"public\".\"users\" ADD CONSTRAINT \"users_pkey\" PRIMARY KEY (id);"
        ));
        assert!(!sql.contains("DROP CONSTRAINT"));
    }

    /// The prologue runs before the tables exist in a structure restore and
    /// before the constraint exists in a database that never had it. Both
    /// guards are load-bearing.
    #[test]
    fn the_prologue_survives_a_table_that_is_not_there_yet() {
        assert_eq!(
            drop_constraint_statement("\"public\".\"orders\"", "orders_user_id_fkey"),
            "ALTER TABLE IF EXISTS \"public\".\"orders\" \
             DROP CONSTRAINT IF EXISTS \"orders_user_id_fkey\";\n"
        );
    }

    /// `relation "users_email_idx" already exists`.
    #[test]
    fn an_index_is_guarded_whichever_of_the_two_shapes_it_has() {
        assert_eq!(
            guarded_index("CREATE INDEX users_email_idx ON public.users USING btree (email)"),
            "CREATE INDEX IF NOT EXISTS users_email_idx ON public.users USING btree (email)"
        );
        assert_eq!(
            guarded_index("CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email)"),
            "CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON public.users USING btree (email)"
        );
        // Only the keyword the server actually wrote, and only once.
        assert_eq!(
            guarded_index("CREATE INDEX a ON t (x) WHERE x = 'CREATE INDEX '"),
            "CREATE INDEX IF NOT EXISTS a ON t (x) WHERE x = 'CREATE INDEX '"
        );
    }

    /// `type "mood" already exists`. `create type` has no guard of its own, so
    /// the guard has to read the catalogue.
    #[test]
    fn an_enum_is_created_only_when_it_is_missing() {
        let mood = EnumType {
            schema: "public".into(),
            name: "mood".into(),
            labels: vec!["sad".into(), "glad".into()],
        };

        let plain = create_enum(&mood, false);
        assert_eq!(
            plain,
            "CREATE TYPE \"public\".\"mood\" AS ENUM ('sad', 'glad');\n"
        );

        let safe = create_enum(&mood, true);
        assert!(safe.contains("IF to_regtype('\"public\".\"mood\"') IS NULL THEN"));
        assert!(safe.contains("CREATE TYPE \"public\".\"mood\" AS ENUM ('sad', 'glad');"));
        // A type that is already there is not necessarily the same type: a
        // label added since the last export would fail every row carrying it.
        assert!(safe.contains("ALTER TYPE \"public\".\"mood\" ADD VALUE IF NOT EXISTS 'sad';"));
        assert!(safe.contains("ALTER TYPE \"public\".\"mood\" ADD VALUE IF NOT EXISTS 'glad';"));
        assert_eq!(safe.matches("ADD VALUE").count(), 2);
    }

    #[test]
    fn a_safe_sequence_does_not_argue_either() {
        let seq = Sequence {
            schema: "public".into(),
            name: "users_id_seq".into(),
            data_type: "bigint".into(),
            increment: 1,
            min_value: 1,
            max_value: i64::MAX,
            start_value: 1,
            cycle: false,
            last_value: Some(7),
            standalone: true,
        };
        assert!(create_sequence(&seq, true)
            .starts_with("CREATE SEQUENCE IF NOT EXISTS \"public\".\"users_id_seq\""));
        assert!(create_sequence(&seq, false)
            .starts_with("CREATE SEQUENCE \"public\".\"users_id_seq\""));
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
