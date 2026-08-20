//! The only SQL this driver composes rather than receives.

/// Quotes an identifier for interpolation into SQL.
///
/// The one place in the backend where a value reaches a statement as text
/// rather than as a bound parameter, because `from <table>` cannot be
/// parameterised. Doubling embedded quotes is what makes that safe.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Builds the one statement this application generates that writes data.
///
/// Both the new value and every key travel as bound parameters, in that order:
/// `$1` is the value, `$2..` are the key values. Nothing the user typed is
/// interpolated. What *is* interpolated is identifiers, through `quote_ident`,
/// and type names, which come from `format_type` in `pg_catalog` and cannot be
/// quoted as identifiers because `character varying(20)` is not one.
///
/// The casts are what let a single code path carry every type. Parameters are
/// bound as text, and `cast(text as <type>)` runs that type's own input
/// function, so `numeric(10,2)`, `timestamptz`, `jsonb`, `text[]`, enums and
/// domains all arrive correctly with no per-OID table to maintain. `returning`
/// casts back to text so the grid can show what Postgres stored rather than
/// what the user typed, which are different for more types than people expect.
pub fn build_update(
    schema: &str,
    table: &str,
    column: &str,
    column_type: &str,
    keys: &[(String, String)],
) -> String {
    let ident = quote_ident(column);
    let conditions: Vec<String> = keys
        .iter()
        .enumerate()
        .map(|(i, (name, ty))| format!("{} = cast(${} as {})", quote_ident(name), i + 2, ty))
        .collect();

    format!(
        "update {}.{} set {} = cast($1 as {}) where {} returning cast({} as text)",
        quote_ident(schema),
        quote_ident(table),
        ident,
        column_type,
        conditions.join(" and "),
        ident,
    )
}

/// Builds the one statement this application generates that removes data.
///
/// The same bargain `build_update` makes, minus the value: every key travels as
/// a bound parameter starting at `$1`, only identifiers and catalogue type
/// names are interpolated, and the `where` clause is the table's whole primary
/// key. One row per statement rather than an `in (...)` over many, so a
/// mismatch names the row it happened on and the transaction can be rolled back
/// on the first one that does not match exactly once.
pub fn build_delete(schema: &str, table: &str, keys: &[(String, String)]) -> String {
    let conditions: Vec<String> = keys
        .iter()
        .enumerate()
        .map(|(i, (name, ty))| format!("{} = cast(${} as {})", quote_ident(name), i + 1, ty))
        .collect();

    format!(
        "delete from {}.{} where {}",
        quote_ident(schema),
        quote_ident(table),
        conditions.join(" and "),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The only text that reaches a statement without being bound. A missed
    /// quote here is arbitrary SQL execution, so it is worth pinning down.
    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote_ident("users"), "\"users\"");
        assert_eq!(quote_ident("MixedCase"), "\"MixedCase\"");
        assert_eq!(quote_ident("select"), "\"select\"");

        // An embedded quote must be doubled, not dropped: without this the
        // name below would close the identifier and open a statement.
        assert_eq!(
            quote_ident("a\"; drop table users; --"),
            "\"a\"\"; drop table users; --\""
        );
    }

    /// The only statement this application generates that writes data. Every
    /// property asserted here is one that, if it drifted, would let an edit
    /// reach a row the user did not mean.
    #[test]
    fn builds_a_bound_update() {
        let keys = vec![("id".to_string(), "integer".to_string())];
        assert_eq!(
            build_update("public", "users", "email", "text", &keys),
            "update \"public\".\"users\" set \"email\" = cast($1 as text) \
             where \"id\" = cast($2 as integer) returning cast(\"email\" as text)"
        );
    }

    #[test]
    fn numbers_every_key_after_the_value() {
        let keys = vec![
            ("tenant".to_string(), "uuid".to_string()),
            ("seq".to_string(), "bigint".to_string()),
        ];
        let sql = build_update("app", "events", "payload", "jsonb", &keys);

        // $1 is always the value, so a composite key starts at $2 and every
        // part of it produces its own condition joined by `and`.
        assert!(sql.contains("set \"payload\" = cast($1 as jsonb)"));
        assert!(sql.contains("\"tenant\" = cast($2 as uuid) and \"seq\" = cast($3 as bigint)"));
    }

    #[test]
    fn never_writes_without_a_where_or_a_returning() {
        let keys = vec![("id".to_string(), "integer".to_string())];
        let sql = build_update("public", "t", "c", "text", &keys);
        assert!(sql.contains(" where "));
        assert!(sql.contains(" returning "));
        // An unbounded update is the failure this whole path exists to avoid.
        assert!(!sql.contains("where returning"));
    }

    #[test]
    fn quotes_identifiers_on_the_write_path_too() {
        let keys = vec![("a\"b".to_string(), "integer".to_string())];
        let sql = build_update("we\"ird", "ta\"ble", "co\"l", "text", &keys);
        assert!(sql.starts_with("update \"we\"\"ird\".\"ta\"\"ble\" set \"co\"\"l\" ="));
        assert!(sql.contains("\"a\"\"b\" = cast($2 as integer)"));
    }

    /// A parameterised type carries its modifier verbatim; truncating it would
    /// silently change what the database stores.
    #[test]
    fn carries_the_catalogue_type_verbatim() {
        let keys = vec![("id".to_string(), "integer".to_string())];
        let sql = build_update("public", "t", "amount", "numeric(10,2)", &keys);
        assert!(sql.contains("cast($1 as numeric(10,2))"));
    }

    /// The other statement that destroys data. The property that matters is the
    /// one an empty key list would break: a `delete from t` with no `where` is
    /// the whole table, and it would run without complaint.
    #[test]
    fn builds_a_bound_delete() {
        let keys = vec![("id".to_string(), "integer".to_string())];
        assert_eq!(
            build_delete("public", "users", &keys),
            "delete from \"public\".\"users\" where \"id\" = cast($1 as integer)"
        );
    }

    #[test]
    fn numbers_a_composite_key_from_one() {
        let keys = vec![
            ("tenant".to_string(), "uuid".to_string()),
            ("seq".to_string(), "bigint".to_string()),
        ];
        let sql = build_delete("app", "events", &keys);
        // No value to bind, so the key starts at $1 rather than $2.
        assert!(sql.contains("\"tenant\" = cast($1 as uuid) and \"seq\" = cast($2 as bigint)"));
    }

    #[test]
    fn quotes_identifiers_on_the_delete_path_too() {
        let keys = vec![("a\"b".to_string(), "integer".to_string())];
        let sql = build_delete("we\"ird", "ta\"ble", &keys);
        assert!(sql.starts_with("delete from \"we\"\"ird\".\"ta\"\"ble\" where"));
        assert!(sql.contains("\"a\"\"b\" = cast($1 as integer)"));
    }
}
