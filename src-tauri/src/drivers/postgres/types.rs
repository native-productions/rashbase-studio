//! Mapping between Postgres' own type vocabulary and the wire types.

use sqlx::postgres::PgSslMode;

use crate::drivers::types::{SslMode, TypeClass};

impl From<SslMode> for PgSslMode {
    fn from(m: SslMode) -> Self {
        match m {
            SslMode::Disable => PgSslMode::Disable,
            SslMode::Prefer => PgSslMode::Prefer,
            SslMode::Require => PgSslMode::Require,
            SslMode::VerifyCa => PgSslMode::VerifyCa,
            SslMode::VerifyFull => PgSslMode::VerifyFull,
        }
    }
}

pub fn classify(type_name: &str) -> TypeClass {
    // Postgres names array types by prefixing the element type with '_'.
    if type_name.starts_with('_') || type_name.ends_with("[]") {
        return TypeClass::Array;
    }
    match type_name.to_ascii_uppercase().as_str() {
        "INT2" | "INT4" | "INT8" | "SMALLINT" | "INT" | "INTEGER" | "BIGINT" | "FLOAT4"
        | "FLOAT8" | "REAL" | "DOUBLE PRECISION" | "NUMERIC" | "DECIMAL" | "MONEY" | "OID" => {
            TypeClass::Number
        }
        "BOOL" | "BOOLEAN" => TypeClass::Bool,
        "JSON" | "JSONB" => TypeClass::Json,
        "DATE" | "TIME" | "TIMETZ" | "TIMESTAMP" | "TIMESTAMPTZ" | "INTERVAL" => {
            TypeClass::Temporal
        }
        "BYTEA" => TypeClass::Binary,
        "UUID" => TypeClass::Uuid,
        "TEXT" | "VARCHAR" | "CHAR" | "BPCHAR" | "NAME" | "CITEXT" | "XML" => TypeClass::Text,
        _ => TypeClass::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Classification decides alignment and color for every cell in the grid.
    /// If it silently drifts, thousands of cells render wrong at once.
    #[test]
    fn classifies_postgres_type_names() {
        assert_eq!(classify("int4"), TypeClass::Number);
        assert_eq!(classify("numeric"), TypeClass::Number);
        assert_eq!(classify("BIGINT"), TypeClass::Number);
        assert_eq!(classify("bool"), TypeClass::Bool);
        assert_eq!(classify("timestamptz"), TypeClass::Temporal);
        assert_eq!(classify("jsonb"), TypeClass::Json);
        assert_eq!(classify("bytea"), TypeClass::Binary);
        assert_eq!(classify("uuid"), TypeClass::Uuid);
        assert_eq!(classify("varchar"), TypeClass::Text);

        // Arrays win over their element type: `_int4` must not right-align.
        assert_eq!(classify("_int4"), TypeClass::Array);
        assert_eq!(classify("text[]"), TypeClass::Array);

        // Unknown user-defined types must degrade, not panic.
        assert_eq!(classify("my_custom_enum"), TypeClass::Other);
        assert_eq!(classify(""), TypeClass::Other);
    }
}
