//! Turning a typed line into a command, and a reply into a grid.
//!
//! The console pane is the same tab the SQL editor uses, so what arrives here
//! is a block of text a person typed. Splitting it correctly is the whole job:
//! `HSET user:1 name "Dwi Putra"` is four arguments, and a splitter that used
//! whitespace alone would make it five and write the wrong value.

use crate::drivers::types::{ColumnMeta, QueryResult, TypeClass};
use crate::error::{Error, Result};

/// Commands that never return, and would take the session with them.
///
/// The session is one connection and there is no `cancel` on this driver, so a
/// command that blocks leaves the tab, and every other tab on the connection,
/// waiting forever with nothing to press. Refused by name with the reason,
/// which is a better answer than a hang.
const BLOCKING: [&str; 10] = [
    "SUBSCRIBE",
    "PSUBSCRIBE",
    "SSUBSCRIBE",
    "MONITOR",
    "BLPOP",
    "BRPOP",
    "BLMOVE",
    "BRPOPLPUSH",
    "BLMPOP",
    "BZPOPMIN",
];

/// Splits one line into arguments, honouring quotes the way a shell does.
///
/// Both quote styles, because people paste from both. Inside double quotes a
/// backslash escapes the next character; inside single quotes it does not,
/// which is the rule `redis-cli` itself follows and therefore the rule anyone
/// pasting a command from a terminal already expects.
///
/// An unterminated quote is an error rather than a silent close: the difference
/// between `SET k "a` and `SET k "a"` is a value the user did not mean to send.
pub fn tokenize(line: &str) -> Result<Vec<String>> {
    let mut args: Vec<String> = Vec::new();
    let mut current = String::new();
    // `None` outside a quoted run, otherwise the quote character that opened it.
    let mut quote: Option<char> = None;
    // Distinguishes `SET k ""` — an empty argument the user typed — from the
    // gap between two arguments, which produces nothing.
    let mut quoted_here = false;
    let mut chars = line.chars();

    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some('"'), '\\') => match chars.next() {
                Some(escaped) => current.push(escaped),
                None => return Err(Error::other("command ends in a backslash")),
            },
            (Some(open), c) if c == open => {
                quote = None;
            }
            (Some(_), c) => current.push(c),
            (None, '"') | (None, '\'') => {
                quote = Some(c);
                quoted_here = true;
            }
            (None, c) if c.is_whitespace() => {
                if !current.is_empty() || quoted_here {
                    args.push(std::mem::take(&mut current));
                    quoted_here = false;
                }
            }
            (None, c) => current.push(c),
        }
    }

    if quote.is_some() {
        return Err(Error::other("command has an unclosed quote"));
    }
    if !current.is_empty() || quoted_here {
        args.push(current);
    }
    Ok(args)
}

/// Refuses a command that would never return. Case-insensitive, because a
/// lowercase `monitor` blocks exactly as hard as an uppercase one.
pub fn reject_if_blocking(name: &str) -> Result<()> {
    let upper = name.to_ascii_uppercase();
    match BLOCKING.contains(&upper.as_str()) {
        false => Ok(()),
        true => Err(Error::other(format!(
            "{upper} never returns, and this connection has no way to interrupt it. \
             Run it in redis-cli instead."
        ))),
    }
}

/// Renders a reply as a result set.
///
/// Three shapes, because that is how many a Redis reply actually has once you
/// stop pretending it is a table: one value, a list of values, or a list of
/// pairs. Everything renders as text for the same reason the Postgres driver
/// reads text off the simple query protocol — the grid draws strings, and a
/// per-type decode table would be a second place for types to be wrong.
pub fn to_result(value: redis::Value, command: &str, duration_ms: u64) -> QueryResult {
    let (columns, rows) = shape(value, command);
    let rows_affected = rows.len() as u64;
    QueryResult {
        columns,
        rows,
        rows_affected,
        truncated: false,
        duration_ms,
    }
}

fn shape(value: redis::Value, command: &str) -> (Vec<ColumnMeta>, Vec<Vec<Option<String>>>) {
    match value {
        // A map reply (HGETALL on RESP3, CONFIG GET) is already field/value.
        redis::Value::Map(pairs) => (
            vec![column("field", TypeClass::Text), column("value", TypeClass::Text)],
            pairs
                .into_iter()
                .map(|(k, v)| vec![scalar(k), scalar(v)])
                .collect(),
        ),

        // An array of scalars is a column. An array of arrays is a table whose
        // width is the widest row, which is what XRANGE and friends produce.
        redis::Value::Array(items) | redis::Value::Set(items) => {
            let width = items
                .iter()
                .map(|item| match item {
                    redis::Value::Array(inner) | redis::Value::Set(inner) => inner.len(),
                    _ => 1,
                })
                .max()
                .unwrap_or(1);

            if width <= 1 {
                return (
                    vec![column(command, TypeClass::Text)],
                    items.into_iter().map(|item| vec![scalar(item)]).collect(),
                );
            }

            let columns = (0..width)
                .map(|i| column(&format!("{}", i + 1), TypeClass::Text))
                .collect();
            let rows = items
                .into_iter()
                .map(|item| match item {
                    redis::Value::Array(inner) | redis::Value::Set(inner) => {
                        let mut cells: Vec<Option<String>> =
                            inner.into_iter().map(scalar).collect();
                        // Ragged replies are normal. Padding keeps every row the
                        // same width so the grid does not read a missing cell as
                        // a shifted one.
                        cells.resize(width, None);
                        cells
                    }
                    other => {
                        let mut cells = vec![scalar(other)];
                        cells.resize(width, None);
                        cells
                    }
                })
                .collect();
            (columns, rows)
        }

        // Everything else is one value, named for the command that produced it.
        other => (
            vec![column(command, class_of(&other))],
            vec![vec![scalar(other)]],
        ),
    }
}

fn column(name: &str, type_class: TypeClass) -> ColumnMeta {
    ColumnMeta {
        name: name.to_string(),
        type_name: match type_class {
            TypeClass::Number => "integer".into(),
            _ => "string".into(),
        },
        type_class,
    }
}

fn class_of(value: &redis::Value) -> TypeClass {
    match value {
        redis::Value::Int(_) => TypeClass::Number,
        redis::Value::Double(_) => TypeClass::Number,
        redis::Value::Boolean(_) => TypeClass::Bool,
        _ => TypeClass::Text,
    }
}

/// One reply value as text.
///
/// `Nil` becomes `None`, which is the grid's NULL and is drawn differently from
/// the literal string "nil". That distinction is the same one the Postgres path
/// keeps, and it is the one most clients get wrong.
pub fn scalar(value: redis::Value) -> Option<String> {
    match value {
        redis::Value::Nil => None,
        redis::Value::Int(n) => Some(n.to_string()),
        redis::Value::Double(f) => Some(f.to_string()),
        redis::Value::Boolean(b) => Some(b.to_string()),
        redis::Value::SimpleString(s) => Some(s),
        redis::Value::Okay => Some("OK".into()),
        redis::Value::BulkString(bytes) => Some(from_bytes(bytes)),
        redis::Value::VerbatimString { text, .. } => Some(text),
        // Arrives as decimal digits rather than a number type unless the
        // `num-bigint` feature is on, which it is not: an integer too large for
        // i64 is something to display, not something to do arithmetic on.
        redis::Value::BigNumber(digits) => Some(from_bytes(digits)),
        redis::Value::ServerError(e) => Some(match e.details() {
            Some(detail) => format!("{} {detail}", e.code()),
            None => e.code().to_string(),
        }),
        // An attributed reply is its data plus metadata nothing here reads.
        redis::Value::Attribute { data, .. } => scalar(*data),
        // A container where a scalar was expected. Rendering it as its own
        // JSON-ish line beats dropping it: the console is where people go to
        // see exactly what came back.
        other => Some(format!("{other:?}")),
    }
}

/// Redis strings are bytes, not text. Anything that is not UTF-8 is a blob and
/// is described rather than mangled through a lossy decode, which would show a
/// row of replacement characters and call it the value.
pub fn from_bytes(bytes: Vec<u8>) -> String {
    match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(e) => format!("<{} bytes, not UTF-8>", e.as_bytes().len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        tokenize(line).unwrap()
    }

    /// The case the whole tokenizer exists for. Split on whitespace alone and
    /// this writes "Dwi" into the field, silently.
    #[test]
    fn keeps_a_quoted_argument_whole() {
        assert_eq!(
            args(r#"HSET user:1 name "Dwi Putra""#),
            ["HSET", "user:1", "name", "Dwi Putra"]
        );
        // Single quotes too: people paste from shells that prefer them.
        assert_eq!(args("SET k 'a b'"), ["SET", "k", "a b"]);
    }

    /// A backslash escapes inside double quotes and is literal inside single
    /// ones, which is the rule redis-cli follows and therefore the rule anyone
    /// pasting from a terminal is already relying on.
    #[test]
    fn escapes_only_inside_double_quotes() {
        assert_eq!(args(r#"SET k "say \"hi\"""#), ["SET", "k", r#"say "hi""#]);
        assert_eq!(args(r"SET k 'a\b'"), ["SET", "k", r"a\b"]);
    }

    /// An empty argument the user typed is an argument. Without the distinction
    /// `SET k ""` would arrive as a two-argument SET and be rejected by the
    /// server for the wrong reason.
    #[test]
    fn tells_an_empty_argument_from_no_argument() {
        assert_eq!(args(r#"SET k """#), ["SET", "k", ""]);
        assert_eq!(args("SET    k    v"), ["SET", "k", "v"]);
        assert!(args("   ").is_empty());
    }

    /// Closing the quote silently would send a value the user did not write.
    #[test]
    fn refuses_an_unclosed_quote() {
        assert!(tokenize(r#"SET k "a"#).is_err());
        // A backslash with nothing left to escape, inside quotes, is the same
        // truncation wearing a different shape.
        assert!(tokenize("SET k \"a\\").is_err());
    }

    /// Outside quotes a backslash is a character like any other. Redis keys are
    /// arbitrary bytes and Windows paths get stored as values, so treating it
    /// as an escape here would quietly eat part of both.
    #[test]
    fn keeps_a_backslash_that_is_not_escaping_anything() {
        assert_eq!(args(r"SET k a\"), ["SET", "k", r"a\"]);
        assert_eq!(args(r"SET path C:\tmp"), ["SET", "path", r"C:\tmp"]);
    }

    /// A blocking command would wedge the session, and this driver has no
    /// cancel to recover it with.
    #[test]
    fn refuses_commands_that_never_return() {
        assert!(reject_if_blocking("SUBSCRIBE").is_err());
        // Case is not a defence.
        assert!(reject_if_blocking("monitor").is_err());
        assert!(reject_if_blocking("GET").is_ok());
    }

    /// Nil has to stay distinct from the text "nil" all the way to the grid,
    /// which draws NULL differently from a string that says so.
    #[test]
    fn renders_nil_as_null_and_not_as_text() {
        assert_eq!(scalar(redis::Value::Nil), None);
        assert_eq!(scalar(redis::Value::Int(7)), Some("7".into()));
        assert_eq!(scalar(redis::Value::Okay), Some("OK".into()));
    }

    /// A flat array is one column; an array of arrays is a table, padded so a
    /// short row cannot shift its cells left under the wrong headers.
    #[test]
    fn shapes_arrays_by_their_widest_row() {
        let flat = redis::Value::Array(vec![
            redis::Value::BulkString(b"a".to_vec()),
            redis::Value::BulkString(b"b".to_vec()),
        ]);
        let result = to_result(flat, "KEYS", 0);
        assert_eq!(result.columns.len(), 1);
        assert_eq!(result.rows.len(), 2);

        let nested = redis::Value::Array(vec![
            redis::Value::Array(vec![
                redis::Value::BulkString(b"a".to_vec()),
                redis::Value::BulkString(b"1".to_vec()),
            ]),
            redis::Value::Array(vec![redis::Value::BulkString(b"b".to_vec())]),
        ]);
        let result = to_result(nested, "XRANGE", 0);
        assert_eq!(result.columns.len(), 2);
        assert_eq!(result.rows[1], vec![Some("b".to_string()), None]);
    }

    /// A value that is not text is a blob. Decoding it lossily would fill the
    /// cell with replacement characters and present that as the stored value.
    #[test]
    fn describes_bytes_that_are_not_text() {
        assert_eq!(from_bytes(vec![0xff, 0xfe]), "<2 bytes, not UTF-8>");
        assert_eq!(from_bytes(b"hello".to_vec()), "hello");
    }
}
