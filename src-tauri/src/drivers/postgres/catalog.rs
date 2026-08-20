//! Everything this driver reads out of `pg_catalog`.
//!
//! Free functions over a borrowed connection rather than methods on the
//! session: the session holds the connection behind a mutex, and more than one
//! of these runs while that lock is already held. Taking the connection as an
//! argument is what keeps `update_cell` from deadlocking against itself.

use std::collections::HashMap;

use sqlx::postgres::PgConnection;
use sqlx::Row;

use crate::drivers::postgres::sql::quote_ident;
use crate::drivers::types::{
    ColumnInfo, ColumnRef, FunctionEntry, GraphColumn, GraphTable, IndexInfo, Relation, RowCount,
    SchemaEntry, SchemaGraph, TableEntry,
};
use crate::error::{Error, Result};

/// Databases on this server that the connected role can actually open.
///
/// `has_database_privilege` is not decoration: on hosted Postgres
/// `pg_database` lists every tenant's database, and offering the user a
/// list where all but one refuse the connection is worse than no list.
pub async fn list_databases(conn: &mut PgConnection) -> Result<Vec<String>> {
    let rows = sqlx::query(
        r#"
        select datname
        from pg_catalog.pg_database
        where datallowconn
          and not datistemplate
          and has_database_privilege(datname, 'CONNECT')
        order by datname
        "#,
    )
    .fetch_all(&mut *conn)
    .await?;
    rows.into_iter()
        .map(|r| Ok(r.try_get::<String, _>(0)?))
        .collect()
}

pub async fn list_schemas(conn: &mut PgConnection) -> Result<Vec<SchemaEntry>> {
    let rows = sqlx::query(
        r#"
        select nspname
        from pg_catalog.pg_namespace
        where nspname <> 'information_schema'
          and nspname not like 'pg\_%'
        order by nspname
        "#,
    )
    .fetch_all(&mut *conn)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(SchemaEntry {
                name: r.try_get::<String, _>(0)?,
            })
        })
        .collect()
}

pub async fn list_tables(conn: &mut PgConnection, schema: &str) -> Result<Vec<TableEntry>> {
    let rows = sqlx::query(
        r#"
        select c.relname,
               case c.relkind
                   when 'r' then 'table'
                   when 'p' then 'table'
                   when 'v' then 'view'
                   when 'm' then 'matview'
                   when 'f' then 'foreign'
                   else 'other'
               end as kind,
               obj_description(c.oid, 'pg_class') as comment
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1
          and c.relkind in ('r', 'p', 'v', 'm', 'f')
        order by kind, c.relname
        "#,
    )
    .bind(schema)
    .fetch_all(&mut *conn)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(TableEntry {
                name: r.try_get::<String, _>(0)?,
                kind: r.try_get::<String, _>(1)?,
                comment: r.try_get::<Option<String>, _>(2)?,
            })
        })
        .collect()
}

/// The planner's estimate, which costs nothing regardless of table size.
///
/// Postgres 14+ stores `-1` for a relation that has never been analysed,
/// and a freshly loaded table reports `0`. Both would read as "empty" in
/// the footer, so the caller falls through to the exact count instead.
///
/// `None` means the relation is gone, which the caller reports rather than
/// silently counting nothing.
pub async fn estimate_rows(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> Result<Option<i64>> {
    let row = sqlx::query(
        r#"
        select c.reltuples::bigint
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relname = $2
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(r) => Ok(Some(r.try_get::<i64, _>(0)?)),
        None => Ok(None),
    }
}

pub async fn count_rows(conn: &mut PgConnection, schema: &str, table: &str) -> Result<RowCount> {
    let sql = format!(
        "select count(*) from {}.{}",
        quote_ident(schema),
        quote_ident(table)
    );
    let row = sqlx::query(&sql).fetch_one(&mut *conn).await?;
    Ok(RowCount {
        value: row.try_get::<i64, _>(0)?,
        exact: true,
    })
}

/// Columns of one relation, in attribute order.
pub async fn list_columns(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>> {
    let rows = sqlx::query(
        r#"
        select a.attname,
               pg_catalog.format_type(a.atttypid, a.atttypmod),
               a.attnotnull,
               pg_catalog.pg_get_expr(d.adbin, d.adrelid),
               coalesce(pk.iskey, false),
               pg_catalog.col_description(a.attrelid, a.attnum),
               -- Enum labels ride along with the columns rather than costing a
               -- second round trip: the editor needs them the moment a cell is
               -- double clicked, and this query already runs when a table opens.
               coalesce(
                   (select array_agg(e.enumlabel::text order by e.enumsortorder)
                      from pg_catalog.pg_enum e
                     where e.enumtypid = a.atttypid),
                   '{}'::text[]
               ),
               -- What this column points at, when it is a single-column foreign
               -- key. Rides along for the same reason the enum labels do: the
               -- grid needs it the moment a cell is selected, and this query
               -- already runs when a table opens.
               fk.fschema,
               fk.ftable,
               fk.fcolumn
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        left join pg_catalog.pg_attrdef d
               on d.adrelid = a.attrelid and d.adnum = a.attnum
        left join lateral (
            select true as iskey
            from pg_catalog.pg_constraint k
            where k.conrelid = a.attrelid
              and k.contype = 'p'
              and a.attnum = any(k.conkey)
        ) pk on true
        left join lateral (
            select rn.nspname as fschema, rc.relname as ftable, ra.attname as fcolumn
            from pg_catalog.pg_constraint k
            join pg_catalog.pg_class rc on rc.oid = k.confrelid
            join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
            join pg_catalog.pg_attribute ra
                 on ra.attrelid = k.confrelid and ra.attnum = k.confkey[1]
            where k.conrelid = a.attrelid
              and k.contype = 'f'
              -- One column each side. A composite key cannot be followed from a
              -- single cell, so it is left absent rather than half-reported.
              and array_length(k.conkey, 1) = 1
              and k.conkey[1] = a.attnum
            limit 1
        ) fk on true
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
            Ok(ColumnInfo {
                name: r.try_get::<String, _>(0)?,
                data_type: r.try_get::<String, _>(1)?,
                not_null: r.try_get::<bool, _>(2)?,
                default: r.try_get::<Option<String>, _>(3)?,
                primary_key: r.try_get::<bool, _>(4)?,
                comment: r.try_get::<Option<String>, _>(5)?,
                enum_values: r.try_get::<Vec<String>, _>(6)?,
                references: match (
                    r.try_get::<Option<String>, _>(7)?,
                    r.try_get::<Option<String>, _>(8)?,
                    r.try_get::<Option<String>, _>(9)?,
                ) {
                    (Some(schema), Some(table), Some(column)) => Some(ColumnRef {
                        schema,
                        table,
                        column,
                    }),
                    _ => None,
                },
            })
        })
        .collect()
}

/// Every column of every relation in the schema, in one statement.
///
/// The same shape as `list_columns` with the relation predicate dropped and the
/// enum lookup removed. Both differences are the point: the diagram wants all
/// of them at once and none of the enum labels, and the correlated `array_agg`
/// that is cheap for one relation is paid per column here.
///
/// Returned paired with the relation name because the caller is about to group
/// by it, and a `GraphColumn` on its own cannot say where it came from.
async fn schema_columns(
    conn: &mut PgConnection,
    schema: &str,
) -> Result<Vec<(String, GraphColumn)>> {
    let rows = sqlx::query(
        r#"
        select c.relname,
               a.attname,
               pg_catalog.format_type(a.atttypid, a.atttypmod),
               a.attnotnull,
               coalesce(pk.iskey, false)
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        left join lateral (
            select true as iskey
            from pg_catalog.pg_constraint k
            where k.conrelid = a.attrelid
              and k.contype = 'p'
              and a.attnum = any(k.conkey)
        ) pk on true
        where n.nspname = $1
          and c.relkind in ('r', 'p', 'v', 'm', 'f')
          and a.attnum > 0
          and not a.attisdropped
        order by c.relname, a.attnum
        "#,
    )
    .bind(schema)
    .fetch_all(&mut *conn)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok((
                r.try_get::<String, _>(0)?,
                GraphColumn {
                    name: r.try_get::<String, _>(1)?,
                    data_type: r.try_get::<String, _>(2)?,
                    not_null: r.try_get::<bool, _>(3)?,
                    primary_key: r.try_get::<bool, _>(4)?,
                },
            ))
        })
        .collect()
}

/// Foreign keys declared by relations in this schema.
///
/// `conkey` and `confkey` are attribute numbers, and their order is what pairs
/// a composite key's columns with the ones they point at. `with ordinality` is
/// what preserves that order: without it the join to `pg_attribute` returns the
/// names in whatever order the planner liked, and a two-column key silently
/// reads as pointing at the wrong pair.
///
/// The `confrelid` side is not filtered by schema. A key that leaves the schema
/// is still a fact about the relation that declared it, and dropping it here
/// would leave the caller unable to tell "no reference" from "a reference you
/// cannot draw".
async fn foreign_keys(conn: &mut PgConnection, schema: &str) -> Result<Vec<Relation>> {
    let rows = sqlx::query(
        r#"
        select con.conname,
               cl.relname,
               (select array_agg(a.attname order by k.ord)
                  from unnest(con.conkey) with ordinality k(attnum, ord)
                  join pg_catalog.pg_attribute a
                    on a.attrelid = con.conrelid and a.attnum = k.attnum),
               fns.nspname,
               fcl.relname,
               (select array_agg(a.attname order by k.ord)
                  from unnest(con.confkey) with ordinality k(attnum, ord)
                  join pg_catalog.pg_attribute a
                    on a.attrelid = con.confrelid and a.attnum = k.attnum)
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_class cl on cl.oid = con.conrelid
        join pg_catalog.pg_namespace ns on ns.oid = cl.relnamespace
        join pg_catalog.pg_class fcl on fcl.oid = con.confrelid
        join pg_catalog.pg_namespace fns on fns.oid = fcl.relnamespace
        where con.contype = 'f'
          and ns.nspname = $1
        order by cl.relname, con.conname
        "#,
    )
    .bind(schema)
    .fetch_all(&mut *conn)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(Relation {
                name: r.try_get::<String, _>(0)?,
                table: r.try_get::<String, _>(1)?,
                columns: r.try_get::<Vec<String>, _>(2)?,
                ref_schema: r.try_get::<String, _>(3)?,
                ref_table: r.try_get::<String, _>(4)?,
                ref_columns: r.try_get::<Vec<String>, _>(5)?,
            })
        })
        .collect()
}

/// The whole schema as a graph: three statements, not one per relation.
pub async fn schema_graph(conn: &mut PgConnection, schema: &str) -> Result<SchemaGraph> {
    let entries = list_tables(&mut *conn, schema).await?;
    let columns = schema_columns(&mut *conn, schema).await?;
    let relations = foreign_keys(&mut *conn, schema).await?;

    // One pass, keyed by relation name, rather than a scan of `columns` per
    // table: the quadratic version is invisible on ten tables and is the whole
    // cost on a schema with a few hundred.
    let mut by_table: HashMap<String, Vec<GraphColumn>> = HashMap::new();
    for (table, column) in columns {
        by_table.entry(table).or_default().push(column);
    }

    let tables = entries
        .into_iter()
        .map(|e| GraphTable {
            columns: by_table.remove(&e.name).unwrap_or_default(),
            name: e.name,
            kind: e.kind,
            comment: e.comment,
        })
        .collect();

    Ok(SchemaGraph { tables, relations })
}

pub async fn list_indexes(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> Result<Vec<IndexInfo>> {
    let rows = sqlx::query(
        r#"
        select ic.relname,
               pg_catalog.pg_get_indexdef(i.indexrelid),
               i.indisunique,
               i.indisprimary
        from pg_catalog.pg_index i
        join pg_catalog.pg_class c on c.oid = i.indrelid
        join pg_catalog.pg_class ic on ic.oid = i.indexrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relname = $2
        order by i.indisprimary desc, ic.relname
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_all(&mut *conn)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(IndexInfo {
                name: r.try_get::<String, _>(0)?,
                definition: r.try_get::<String, _>(1)?,
                unique: r.try_get::<bool, _>(2)?,
                primary: r.try_get::<bool, _>(3)?,
            })
        })
        .collect()
}

pub async fn list_functions(
    conn: &mut PgConnection,
    schema: &str,
) -> Result<Vec<FunctionEntry>> {
    let rows = sqlx::query(
        r#"
        select p.oid::bigint,
               p.proname,
               pg_catalog.pg_get_function_identity_arguments(p.oid),
               pg_catalog.pg_get_function_result(p.oid),
               case p.prokind when 'p' then 'procedure' else 'function' end
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1
          and p.prokind in ('f', 'p')
        order by p.proname, p.oid
        "#,
    )
    .bind(schema)
    .fetch_all(&mut *conn)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(FunctionEntry {
                oid: r.try_get::<i64, _>(0)?,
                name: r.try_get::<String, _>(1)?,
                args: r.try_get::<String, _>(2)?,
                returns: r.try_get::<String, _>(3)?,
                kind: r.try_get::<String, _>(4)?,
            })
        })
        .collect()
}

/// The routine's source as Postgres would dump it.
pub async fn function_definition(conn: &mut PgConnection, oid: i64) -> Result<String> {
    let row = sqlx::query("select pg_catalog.pg_get_functiondef($1::oid)")
        .bind(oid)
        .fetch_one(&mut *conn)
        .await?;
    Ok(row.try_get::<String, _>(0)?)
}

/// `pretty` is on: the stored parse tree is reformatted the way `\d+`
/// prints it, which is the version a person can read.
pub async fn view_definition(
    conn: &mut PgConnection,
    schema: &str,
    name: &str,
) -> Result<String> {
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
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(r) => Ok(r.try_get::<String, _>(0)?),
        None => Err(Error::other(format!("no such view: {schema}.{name}"))),
    }
}

/// The relation kind, or `None` when nothing by that name exists.
pub async fn relkind(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar(
        "select c.relkind::text
           from pg_catalog.pg_class c
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and c.relname = $2",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(&mut *conn)
    .await?)
}
