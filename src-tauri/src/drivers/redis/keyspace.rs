//! Walking the keyspace.
//!
//! # Why SCAN and never KEYS
//!
//! `KEYS *` is one command that blocks the server for as long as it takes to
//! walk every key. On a production instance that is a stall every other client
//! shares. `SCAN` walks in bounded batches and lets the server serve between
//! them, which is the only version of this feature that is safe to point at
//! something real — and this app is built to be pointed at something real.
//!
//! # Why one pipeline per batch
//!
//! A key name on its own is not a row: the grid wants the type, the TTL, the
//! size, and enough of the value to read. Asking for those one key at a time is
//! four round trips per key, so 200 keys is 800 round trips and a page that
//! takes seconds on a link with any latency at all. Every batch's enrichment
//! goes out as a single pipeline instead: one round trip, whatever the batch
//! size.

use redis::aio::MultiplexedConnection;

use crate::drivers::redis::command::from_bytes;
use crate::drivers::types::{KeyEntry, KeyFilter, KeyPage};
use crate::error::Result;

/// Keys asked of the server per SCAN. A hint, not a promise: Redis returns
/// roughly this many and the walk copes with any count.
///
/// Larger than the default 10 because each batch costs a round trip and the
/// enrichment pipeline behind it; smaller than the page size so a filter that
/// matches nothing still yields control regularly instead of arriving in one
/// long stall.
const SCAN_BATCH: usize = 512;

/// How many keys a single page may walk before it gives up and reports what it
/// cost.
///
/// This is what stops a `contains` filter that matches nothing from walking ten
/// million keys inside one IPC call. Hitting it is not an error: the page comes
/// back with its cursor, `scanned` says what was spent, and pressing Next
/// resumes exactly where it stopped. That is the honest version of "still
/// looking" and it keeps the window responsive.
const SCAN_BUDGET: u64 = 50_000;

/// Bytes of a string value kept for the preview column.
///
/// Read server-side with GETRANGE, so a 5MB blob costs this many bytes on the
/// wire rather than five megabytes that get thrown away after the first 300px.
const PREVIEW_BYTES: isize = 2_048;

/// Members of a collection kept for the preview.
const PREVIEW_MEMBERS: isize = 64;

/// Walks one page.
///
/// `cursor` of 0 starts; the returned cursor resumes. A page can come back
/// empty and still not be the end — that is normal for a cursor walk and the
/// reason `exhausted` is reported separately rather than inferred from the row
/// count.
pub async fn list_keys(
    conn: &mut MultiplexedConnection,
    filter: &KeyFilter,
    cursor: u64,
    limit: usize,
) -> Result<KeyPage> {
    let pattern = filter.pattern.as_deref().unwrap_or("*");
    let needle = filter.contains.as_deref().filter(|n| !n.is_empty());
    // Folded once here rather than per key: a case-insensitive scan over 50,000
    // values should not lowercase the needle 50,000 times.
    let folded = needle.map(|n| match filter.case_sensitive {
        true => n.to_string(),
        false => n.to_lowercase(),
    });

    let mut out: Vec<KeyEntry> = Vec::new();
    let mut cursor = cursor;
    let mut scanned: u64 = 0;
    let mut exhausted = false;

    while out.len() < limit && scanned < SCAN_BUDGET {
        let (next, names): (u64, Vec<Vec<u8>>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(SCAN_BATCH)
            .query_async(&mut *conn)
            .await?;

        cursor = next;
        scanned += names.len() as u64;

        if !names.is_empty() {
            let names: Vec<String> = names.into_iter().map(from_bytes).collect();
            for entry in enrich(conn, &names).await? {
                // The value filter is applied here because no Redis command can
                // answer it. That cost is exactly what `scanned` reports.
                if let Some(needle) = folded.as_deref() {
                    let hay = entry.preview.as_deref().unwrap_or("");
                    let matched = match filter.case_sensitive {
                        true => hay.contains(needle),
                        false => hay.to_lowercase().contains(needle),
                    };
                    if !matched {
                        continue;
                    }
                }
                out.push(entry);
            }
        }

        // A cursor back at 0 means the walk came all the way round. Checked
        // after the batch is consumed, since the last batch still carries keys.
        if cursor == 0 {
            exhausted = true;
            break;
        }
    }

    // Cheap and exact: Redis keeps this count, so the footer never needs the
    // `~` the Postgres pager shows for a planner estimate.
    let total: Option<i64> = redis::cmd("DBSIZE").query_async(&mut *conn).await.ok();

    Ok(KeyPage {
        keys: out,
        cursor,
        scanned,
        exhausted,
        total,
    })
}

/// Turns a batch of key names into rows, in one round trip.
///
/// Two pipelines rather than one: the value command for a key depends on its
/// type, and the type is not known until the first pipeline answers. Two round
/// trips per batch is the floor for that, and it is a floor per *batch*, not
/// per key.
async fn enrich(conn: &mut MultiplexedConnection, names: &[String]) -> Result<Vec<KeyEntry>> {
    let mut probe = redis::pipe();
    for name in names {
        probe.cmd("TYPE").arg(name);
        probe.cmd("TTL").arg(name);
    }
    let probed: Vec<redis::Value> = probe.query_async(&mut *conn).await?;

    let mut kinds: Vec<String> = Vec::with_capacity(names.len());
    let mut ttls: Vec<Option<i64>> = Vec::with_capacity(names.len());
    for pair in probed.chunks(2) {
        kinds.push(match pair.first() {
            Some(redis::Value::SimpleString(s)) => s.clone(),
            Some(redis::Value::BulkString(b)) => from_bytes(b.clone()),
            _ => "none".to_string(),
        });
        ttls.push(match pair.get(1) {
            Some(redis::Value::Int(n)) => Some(*n),
            _ => None,
        });
    }

    let mut read = redis::pipe();
    for (name, kind) in names.iter().zip(&kinds) {
        match kind.as_str() {
            "string" => {
                read.cmd("STRLEN").arg(name);
                // Server-side truncation. The whole point: a huge value never
                // crosses the wire to be cut here.
                read.cmd("GETRANGE").arg(name).arg(0).arg(PREVIEW_BYTES - 1);
            }
            "hash" => {
                read.cmd("HLEN").arg(name);
                read.cmd("HGETALL").arg(name);
            }
            "list" => {
                read.cmd("LLEN").arg(name);
                read.cmd("LRANGE").arg(name).arg(0).arg(PREVIEW_MEMBERS - 1);
            }
            "set" => {
                read.cmd("SCARD").arg(name);
                read.cmd("SRANDMEMBER").arg(name).arg(PREVIEW_MEMBERS);
            }
            "zset" => {
                read.cmd("ZCARD").arg(name);
                read.cmd("ZRANGE")
                    .arg(name)
                    .arg(0)
                    .arg(PREVIEW_MEMBERS - 1)
                    .arg("WITHSCORES");
            }
            "stream" => {
                read.cmd("XLEN").arg(name);
                read.cmd("XRANGE").arg(name).arg("-").arg("+").arg("COUNT").arg(8);
            }
            // A type this build does not know, or a key that expired between
            // the two pipelines. Both are asked for nothing rather than guessed
            // at, so the row still draws with its name and type.
            _ => {
                read.cmd("EXISTS").arg(name);
                read.cmd("EXISTS").arg(name);
            }
        }
    }
    let values: Vec<redis::Value> = read.query_async(&mut *conn).await?;

    Ok(names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let kind = kinds[i].clone();
            let size = match values.get(i * 2) {
                Some(redis::Value::Int(n)) => Some(*n),
                _ => None,
            };
            let preview = values.get(i * 2 + 1).map(|v| preview_of(v, &kind));
            KeyEntry {
                key: name.clone(),
                kind,
                ttl: ttls[i],
                size,
                preview,
            }
        })
        .collect())
}

/// Renders a value for the preview column, and for the row panel's JSON tree.
///
/// Collections become JSON — an object for a hash, an array for the rest —
/// because that is what makes the existing JSON viewer draw them without
/// knowing anything about Redis. A string stays a string: wrapping it in quotes
/// would show the quotes as part of the value.
pub fn preview_of(value: &redis::Value, kind: &str) -> String {
    match kind {
        "string" => text_of(value),
        "hash" => {
            let mut map = serde_json::Map::new();
            match value {
                // RESP3 answers HGETALL as a map, RESP2 as a flat array.
                redis::Value::Map(pairs) => {
                    for (k, v) in pairs {
                        map.insert(text_of(k), serde_json::Value::String(text_of(v)));
                    }
                }
                redis::Value::Array(items) => {
                    for pair in items.chunks(2) {
                        if let [k, v] = pair {
                            map.insert(text_of(k), serde_json::Value::String(text_of(v)));
                        }
                    }
                }
                _ => {}
            }
            serde_json::Value::Object(map).to_string()
        }
        "zset" => match value {
            // Flattened member/score pairs become an array of two-key objects,
            // which is the only rendering where the score stays attached to the
            // member it belongs to.
            redis::Value::Array(items) => serde_json::Value::Array(
                items
                    .chunks(2)
                    .map(|pair| match pair {
                        [m, s] => serde_json::json!({ "member": text_of(m), "score": text_of(s) }),
                        [m] => serde_json::json!({ "member": text_of(m) }),
                        _ => serde_json::Value::Null,
                    })
                    .collect(),
            )
            .to_string(),
            other => text_of(other),
        },
        _ => match value {
            redis::Value::Array(items) | redis::Value::Set(items) => serde_json::Value::Array(
                items
                    .iter()
                    .map(|item| serde_json::Value::String(text_of(item)))
                    .collect(),
            )
            .to_string(),
            other => text_of(other),
        },
    }
}

/// One reply value as plain text, with no NULL distinction.
///
/// Separate from `command::scalar` on purpose: inside a preview there is no
/// grid cell to draw NULL in, so nil is the empty string. Keeping the two apart
/// is what lets the console show a real NULL while a hash field holding nothing
/// shows as nothing.
fn text_of(value: &redis::Value) -> String {
    match value {
        redis::Value::Nil => String::new(),
        redis::Value::Int(n) => n.to_string(),
        redis::Value::Double(f) => f.to_string(),
        redis::Value::Boolean(b) => b.to_string(),
        redis::Value::SimpleString(s) => s.clone(),
        redis::Value::BulkString(b) => from_bytes(b.clone()),
        redis::Value::VerbatimString { text, .. } => text.clone(),
        other => format!("{other:?}"),
    }
}

/// Removes keys, reporting how many existed.
///
/// `UNLINK` rather than `DEL`: it frees memory on a background thread, so
/// deleting a key holding a million members does not stall the server the way
/// `DEL` does. Redis 4 and later; older servers get `DEL`, which is the same
/// operation with a worse pause.
pub async fn delete_keys(conn: &mut MultiplexedConnection, keys: &[String]) -> Result<u64> {
    if keys.is_empty() {
        return Ok(0);
    }
    let mut cmd = redis::cmd("UNLINK");
    for key in keys {
        cmd.arg(key);
    }
    match cmd.query_async::<i64>(&mut *conn).await {
        Ok(n) => Ok(n as u64),
        Err(_) => {
            let mut cmd = redis::cmd("DEL");
            for key in keys {
                cmd.arg(key);
            }
            Ok(cmd.query_async::<i64>(&mut *conn).await? as u64)
        }
    }
}
