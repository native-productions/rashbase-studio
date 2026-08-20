//! BullMQ, read as a lens over the keyspace.
//!
//! BullMQ is not a database. It is a key layout one library writes into Redis,
//! so this is a module beside `keyspace.rs` rather than a driver beside
//! `redis/`: the connection, the credentials, the tunnel and the session are
//! already open, and asking the user for a second connection to the same server
//! in order to look at the same keys through a different lens would be a tax
//! rather than a feature.
//!
//! Everything here is read-only except `retry_jobs`, which runs BullMQ's own
//! Lua script verbatim. See `lua/reprocess_job.lua` for why it is vendored
//! rather than written as a pair of commands.
//!
//! # The layout, as of BullMQ v5
//!
//! ```text
//! <prefix>:<queue>:meta              hash   queue options, and `paused` as a field
//! <prefix>:<queue>:id                string counter
//! <prefix>:<queue>:wait              list   LPUSHed, popped from the right
//! <prefix>:<queue>:active            list
//! <prefix>:<queue>:delayed           zset   score packs the ready-at timestamp
//! <prefix>:<queue>:prioritized       zset   score packs the priority
//! <prefix>:<queue>:waiting-children  zset
//! <prefix>:<queue>:completed         zset   score is finishedOn
//! <prefix>:<queue>:failed            zset   score is finishedOn
//! <prefix>:<queue>:<jobId>           hash   the job itself
//! <prefix>:<queue>:events            stream every transition, with the job id
//! <prefix>:<queue>:marker            zset   what a blocked worker waits on
//! <prefix>:<queue>:paused            list   v4 and earlier only. See `retry_jobs`.
//! ```

use std::collections::BTreeMap;

use redis::aio::MultiplexedConnection;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// What BullMQ prefixes its keys with unless the application says otherwise.
pub const DEFAULT_PREFIX: &str = "bull";

/// Keys asked of the server per SCAN while looking for queues.
const SCAN_BATCH: usize = 512;

/// How many keys one discovery page may walk before reporting what it cost.
///
/// The same bargain `keyspace::list_keys` makes, for the same reason: a
/// `<prefix>:*:meta` match on a keyspace holding ten million session keys is a
/// long walk, and a page that comes back saying what it spent beats a call that
/// blocks the window until it finishes.
const SCAN_BUDGET: u64 = 200_000;

/// Every state a job can be found in, as the key that holds it.
///
/// `wait` rather than `waiting`: these are key names, and the frontend does the
/// renaming. Two of them are lists and five are sorted sets, which is why
/// nothing here loops over the whole array with one command.
pub const STATES: [&str; 7] = [
    "wait",
    "active",
    "delayed",
    "prioritized",
    "waiting-children",
    "completed",
    "failed",
];

/// Whether a state is held in a list rather than a sorted set.
fn is_list(state: &str) -> bool {
    matches!(state, "wait" | "active" | "paused")
}

/// Which end of a state a page is read from.
///
/// Not a property of the Redis type: `wait` is a list read from its tail and
/// `delayed` is a sorted set read from its head, and both of those are the job
/// that happens *next*. What separates the two groups is whether the score or
/// the position is about the future or the past — `completed` and `failed` hold
/// a finish time, everything else holds a place in a queue that has not run yet.
///
/// Reported rather than assumed, because it is not guessable from the screen: a
/// page of `delayed` labelled "most recent first" would have the reader believe
/// the top row is the last one scheduled when it is the next one to fire.
fn order_of(state: &str) -> &'static str {
    match state {
        "completed" | "failed" | "active" => "recent-first",
        _ => "next-first",
    }
}

/// One queue and what is sitting in it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub name: String,
    /// Keyed by the names in `STATES`. Exact rather than estimated: `LLEN` and
    /// `ZCARD` are O(1) and there is no planner statistic to prefer over them.
    pub counts: BTreeMap<String, u64>,
    /// `paused` on the meta hash. A queue-level fact since v5, not a state a
    /// job is in, so it is not one of `counts`.
    pub paused: bool,
    /// Whether `<prefix>:<queue>:paused` holds anything.
    ///
    /// Only true against BullMQ v4 and earlier, where pausing moved jobs into a
    /// separate list. Carried so `retry_jobs` can refuse rather than push a job
    /// into `wait` on a queue the application believes is paused.
    pub legacy_paused: u64,
}

/// One page of the walk for queues.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuePage {
    pub queues: Vec<QueueEntry>,
    /// Where to resume. `0` means the walk came round.
    pub cursor: u64,
    /// Keys the walk actually touched, which is what the discovery cost.
    pub scanned: u64,
    pub exhausted: bool,
}

/// One job, as its hash holds it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEntry {
    pub id: String,
    /// The hash verbatim. Not narrowed to a struct here because the field set
    /// moves between BullMQ versions — `atm` became `attemptsMade`, `ats` and
    /// `deid` arrived later — and a struct would silently drop whatever it did
    /// not know about. The frontend picks the columns it draws.
    pub fields: BTreeMap<String, String>,
    /// The sorted-set score this job carried, for the states that have one.
    ///
    /// Meaning is per state and the frontend decodes it: `delayed` packs the
    /// ready-at millisecond timestamp in the high bits, `prioritized` packs the
    /// priority, `completed` and `failed` hold `finishedOn` outright.
    pub score: Option<f64>,
}

/// One page of jobs in one state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobPage {
    pub jobs: Vec<JobEntry>,
    /// Everything in the state, not just this page.
    pub total: u64,
    /// How the page is ordered, in the frontend's own vocabulary, so the footer
    /// can say which end of the queue is on screen instead of leaving the user
    /// to guess. One of `next-first` or `recent-first`.
    pub order: &'static str,
}

/// One entry off the queue's event stream.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEvent {
    /// The stream id, `<ms>-<seq>`. Doubles as the resume point and as the
    /// event's own timestamp, which is why no separate time field is carried.
    pub id: String,
    pub fields: BTreeMap<String, String>,
}

/// A tail of the event stream, and whether any of it was missed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub events: Vec<QueueEvent>,
    /// Where the next poll resumes. Empty when the stream held nothing.
    pub last_id: String,
    /// The server's own clock, in milliseconds, at the moment of this read.
    ///
    /// Stream ids are stamped by the server, and a rate is events divided by
    /// how long ago they were. Dividing by a *client* clock makes the rate
    /// wrong by however far the two machines have drifted — and a laptop
    /// talking to a production replica is exactly where that drift is real.
    /// One `TIME` per poll removes the question rather than modelling it.
    pub server_now: u64,
    /// Set when the stream was trimmed past the caller's resume point, so
    /// transitions happened that this page cannot account for.
    ///
    /// The whole reason it exists: rates derived from a gapped window are
    /// wrong, and reporting them as a number would be the app inventing
    /// throughput it did not measure.
    pub trimmed: bool,
}

/// What one job's retry did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryOutcome {
    pub job_id: String,
    /// BullMQ's own return codes, passed through rather than collapsed:
    /// `1` moved it, `-1` the job hash is gone, `-3` it was not in the state
    /// the caller named. The last is what a second retry of the same job
    /// returns, and it is not an error worth failing the batch over.
    pub code: i64,
}

/// What the caller asked to be retried.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryRequest {
    #[serde(default = "default_prefix")]
    pub prefix: String,
    pub queue: String,
    /// `failed` or `completed`. Nothing else has a finished set to move out of.
    pub state: String,
    pub job_ids: Vec<String>,
    /// Whether `attemptsMade` is cleared, giving the job its full allowance
    /// again. Off by default, matching `job.retry()` with no options.
    #[serde(default)]
    pub reset_attempts_made: bool,
}

fn default_prefix() -> String {
    DEFAULT_PREFIX.to_string()
}

/// BullMQ's `reprocessJob`, flattened. See the file's own header.
const REPROCESS_JOB: &str = include_str!("lua/reprocess_job.lua");

fn key(prefix: &str, queue: &str, part: &str) -> String {
    format!("{prefix}:{queue}:{part}")
}

/// Walks one page of queues under `prefix`.
///
/// SCAN and never KEYS, for the reason `keyspace.rs` spells out: this app is
/// built to be pointed at production, and `KEYS <prefix>:*:meta` stalls the
/// server for every other client while it runs.
pub async fn list_queues(
    conn: &mut MultiplexedConnection,
    prefix: &str,
    cursor: u64,
    limit: usize,
) -> Result<QueuePage> {
    let pattern = format!("{prefix}:*:meta");
    let head = format!("{prefix}:");

    let mut names: Vec<String> = Vec::new();
    let mut cursor = cursor;
    let mut scanned: u64 = 0;

    loop {
        let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(&pattern)
            .arg("COUNT")
            .arg(SCAN_BATCH)
            .query_async(&mut *conn)
            .await?;

        scanned += batch.len() as u64;
        for k in batch {
            // Strip both ends rather than splitting on ':': a queue may be
            // named `orders:eu`, and splitting would cut it in half.
            if let Some(name) = k.strip_prefix(&head).and_then(|r| r.strip_suffix(":meta")) {
                if !name.is_empty() {
                    names.push(name.to_string());
                }
            }
        }

        cursor = next;
        if cursor == 0 || names.len() >= limit || scanned >= SCAN_BUDGET {
            break;
        }
    }

    // Sorted here rather than in the sidebar, because a page is a slice of a
    // walk and the sidebar only ever sees one page at a time.
    names.sort();
    names.truncate(limit);

    let queues = counts_for(conn, prefix, &names).await?;

    Ok(QueuePage {
        queues,
        cursor,
        scanned,
        exhausted: cursor == 0,
    })
}

/// One named queue's counts, without the discovery walk.
///
/// Its own entry point because it is the hot path: a live tab asks for this
/// every second, and `list_queues` would SCAN the whole keyspace to answer a
/// question that is nine O(1) commands once the name is known.
pub async fn queue_counts(
    conn: &mut MultiplexedConnection,
    prefix: &str,
    queue: &str,
) -> Result<QueueEntry> {
    let names = [queue.to_string()];
    counts_for(conn, prefix, &names)
        .await?
        .pop()
        .ok_or_else(|| Error::other(format!("no queue named {queue}")))
}

/// Counts every state of every named queue in one round trip.
///
/// Nine commands per queue, pipelined. Asking per queue instead would be nine
/// round trips each, which on a link with any latency is the difference between
/// a sidebar that opens and one that hangs.
async fn counts_for(
    conn: &mut MultiplexedConnection,
    prefix: &str,
    names: &[String],
) -> Result<Vec<QueueEntry>> {
    if names.is_empty() {
        return Ok(Vec::new());
    }

    let mut pipe = redis::pipe();
    for name in names {
        for state in STATES {
            let k = key(prefix, name, state);
            if is_list(state) {
                pipe.cmd("LLEN").arg(k);
            } else {
                pipe.cmd("ZCARD").arg(k);
            }
        }
        pipe.cmd("HGET").arg(key(prefix, name, "meta")).arg("paused");
        pipe.cmd("LLEN").arg(key(prefix, name, "paused"));
    }

    let values: Vec<redis::Value> = pipe.query_async(&mut *conn).await?;
    let stride = STATES.len() + 2;

    Ok(names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let base = i * stride;
            let counts = STATES
                .iter()
                .enumerate()
                .map(|(j, state)| {
                    let n = values.get(base + j).and_then(as_u64).unwrap_or(0);
                    (state.to_string(), n)
                })
                .collect();
            QueueEntry {
                name: name.clone(),
                counts,
                // Any value at all means paused: BullMQ writes "1" but has
                // written other truthy markers, and the Lua only checks that
                // the field is present.
                paused: values
                    .get(base + STATES.len())
                    .is_some_and(|v| !matches!(v, redis::Value::Nil)),
                legacy_paused: values
                    .get(base + STATES.len() + 1)
                    .and_then(as_u64)
                    .unwrap_or(0),
            }
        })
        .collect())
}

fn as_u64(value: &redis::Value) -> Option<u64> {
    match value {
        redis::Value::Int(n) => u64::try_from(*n).ok(),
        _ => None,
    }
}

/// One page of jobs in one state.
///
/// # Which end of the queue a page starts from
///
/// `wait` is LPUSHed and popped from the right, so the job that runs next is at
/// the *tail* of the list, not the head. A page read with `LRANGE 0 n` would be
/// the most recently added jobs, which on a backed-up queue is the opposite of
/// what someone opening a monitor wants to see. So `wait` is read from the tail
/// and reversed, and every other state is ordered newest or soonest first.
/// `JobPage::order` carries which of the two happened.
pub async fn list_jobs(
    conn: &mut MultiplexedConnection,
    prefix: &str,
    queue: &str,
    state: &str,
    offset: usize,
    limit: usize,
) -> Result<JobPage> {
    if !STATES.contains(&state) {
        return Err(Error::other(format!("{state} is not a job state")));
    }
    let state_key = key(prefix, queue, state);

    let (total, ids, scores) = if is_list(state) {
        let total: u64 = redis::cmd("LLEN")
            .arg(&state_key)
            .query_async(&mut *conn)
            .await?;

        let mut ids: Vec<String> = if state == "wait" {
            // Negative indices count from the tail, and Redis clamps a start
            // that runs off the front, so a window wider than the list still
            // comes back as the whole list rather than as nothing.
            let start = -((offset + limit) as isize);
            let stop = -((offset + 1) as isize);
            redis::cmd("LRANGE")
                .arg(&state_key)
                .arg(start)
                .arg(stop)
                .query_async(&mut *conn)
                .await?
        } else {
            redis::cmd("LRANGE")
                .arg(&state_key)
                .arg(offset)
                .arg(offset + limit - 1)
                .query_async(&mut *conn)
                .await?
        };
        if state == "wait" {
            ids.reverse();
        }
        (total, ids, Vec::new())
    } else {
        let total: u64 = redis::cmd("ZCARD")
            .arg(&state_key)
            .query_async(&mut *conn)
            .await?;

        // Ascending for the states whose score is a time or a priority still
        // ahead of the job, descending for the two that hold a finish time.
        // The two branches are the same split `order_of` reports, and a change
        // to one without the other makes the footer lie about the page.
        let newest_first = order_of(state) == "recent-first";
        let mut cmd = redis::cmd(if newest_first { "ZREVRANGE" } else { "ZRANGE" });
        let pairs: Vec<(String, f64)> = cmd
            .arg(&state_key)
            .arg(offset)
            .arg(offset + limit - 1)
            .arg("WITHSCORES")
            .query_async(&mut *conn)
            .await?;

        let (ids, scores): (Vec<String>, Vec<f64>) = pairs.into_iter().unzip();
        (total, ids, scores)
    };

    let mut jobs = hydrate(conn, prefix, queue, &ids).await?;
    for (job, score) in jobs.iter_mut().zip(scores) {
        job.score = Some(score);
    }

    Ok(JobPage {
        jobs,
        total,
        order: order_of(state),
    })
}

/// Reads the hash behind every id in one round trip.
///
/// The N+1 is real — one HGETALL per job — but it goes out as a single pipeline,
/// so it costs one round trip for the page rather than one per row.
async fn hydrate(
    conn: &mut MultiplexedConnection,
    prefix: &str,
    queue: &str,
    ids: &[String],
) -> Result<Vec<JobEntry>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut pipe = redis::pipe();
    for id in ids {
        pipe.cmd("HGETALL").arg(key(prefix, queue, id));
    }
    let hashes: Vec<BTreeMap<String, String>> = pipe.query_async(&mut *conn).await?;

    Ok(ids
        .iter()
        .zip(hashes)
        .map(|(id, fields)| JobEntry {
            id: id.clone(),
            fields,
            score: None,
        })
        .collect())
}

/// The tail of a queue's event stream since `after`.
///
/// This is the only honest source of a per-transition rate. Counting the
/// difference between two polls of `counts` cannot tell a queue where fifty
/// jobs went in and fifty came out from a queue where nothing moved, and a
/// monitor that draws those two the same way is worse than one that draws
/// nothing.
pub async fn queue_events(
    conn: &mut MultiplexedConnection,
    prefix: &str,
    queue: &str,
    after: Option<&str>,
    limit: usize,
) -> Result<EventPage> {
    let stream = key(prefix, queue, "events");

    let raw: Vec<(String, Vec<String>)> = match after {
        // Exclusive ranges take a `(` prefix, so the resume point is not
        // replayed on every poll.
        Some(id) if !id.is_empty() => {
            redis::cmd("XRANGE")
                .arg(&stream)
                .arg(format!("({id}"))
                .arg("+")
                .arg("COUNT")
                .arg(limit)
                .query_async(&mut *conn)
                .await?
        }
        // The first poll wants the recent past, not ten thousand entries of it,
        // so it reads backwards from the end and puts them back in order.
        _ => {
            let mut back: Vec<(String, Vec<String>)> = redis::cmd("XREVRANGE")
                .arg(&stream)
                .arg("+")
                .arg("-")
                .arg("COUNT")
                .arg(limit)
                .query_async(&mut *conn)
                .await?;
            back.reverse();
            back
        }
    };

    // Whether anything happened between the caller's resume point and what the
    // stream still holds. One extra command, and the only way to know that a
    // rate computed from this page would be missing transitions.
    let trimmed = match after {
        Some(id) if !id.is_empty() => {
            let oldest: Vec<(String, Vec<String>)> = redis::cmd("XRANGE")
                .arg(&stream)
                .arg("-")
                .arg("+")
                .arg("COUNT")
                .arg(1)
                .query_async(&mut *conn)
                .await?;
            oldest
                .first()
                .is_some_and(|(first, _)| stream_id_after(first, id))
        }
        _ => false,
    };

    let (secs, micros): (u64, u64) = redis::cmd("TIME").query_async(&mut *conn).await?;

    let last_id = raw
        .last()
        .map(|(id, _)| id.clone())
        .or_else(|| after.map(str::to_string))
        .unwrap_or_default();

    Ok(EventPage {
        server_now: secs * 1_000 + micros / 1_000,
        events: raw
            .into_iter()
            .map(|(id, flat)| QueueEvent {
                id,
                fields: flat
                    .chunks_exact(2)
                    .map(|pair| (pair[0].clone(), pair[1].clone()))
                    .collect(),
            })
            .collect(),
        last_id,
        trimmed,
    })
}

/// Whether stream id `a` is strictly later than `b`.
///
/// Compared as the two numbers a stream id actually is, not as text: `10-0`
/// sorts before `9-0` as a string, which would report a gap on every stream
/// that lived long enough to cross a power of ten.
fn stream_id_after(a: &str, b: &str) -> bool {
    fn parts(id: &str) -> (u64, u64) {
        let (ms, seq) = id.split_once('-').unwrap_or((id, "0"));
        (ms.parse().unwrap_or(0), seq.parse().unwrap_or(0))
    }
    parts(a) > parts(b)
}

/// Moves finished jobs back into `wait`, one BullMQ `reprocessJob` each.
///
/// Every job is reported on individually. A batch where two ids have already
/// been retried by someone else is not a failed batch: those two come back
/// `-3`, the rest move, and the caller says so.
pub async fn retry_jobs(
    conn: &mut MultiplexedConnection,
    req: &RetryRequest,
) -> Result<Vec<RetryOutcome>> {
    if req.state != "failed" && req.state != "completed" {
        return Err(Error::other(format!(
            "Only failed and completed jobs can be retried. {} has no finished set to move out of.",
            req.state
        )));
    }
    if req.job_ids.is_empty() {
        return Ok(Vec::new());
    }

    // The one place BullMQ v4 and v5 diverge dangerously. Before v5 a paused
    // queue held its jobs in a separate `paused` list; `reprocessJob` pushes to
    // `wait` and decides about the marker from the meta hash, so on a v4 queue
    // it would put a job somewhere a paused application is about to start
    // running. Refuse rather than guess which version wrote these keys.
    let legacy: u64 = redis::cmd("LLEN")
        .arg(key(&req.prefix, &req.queue, "paused"))
        .query_async(&mut *conn)
        .await?;
    if legacy > 0 {
        return Err(Error::other(format!(
            "{} holds {legacy} jobs in a `paused` list, which is how BullMQ v4 and earlier \
             paused a queue. Retrying here would move a job into `wait` on a queue the \
             application believes is paused. Upgrade to BullMQ v5 or resume the queue first.",
            req.queue
        )));
    }

    // Loaded once for the batch rather than sent with every job: the script is
    // a few kilobytes and a hundred retries would otherwise put it on the wire
    // a hundred times.
    let sha: String = redis::cmd("SCRIPT")
        .arg("LOAD")
        .arg(REPROCESS_JOB)
        .query_async(&mut *conn)
        .await?;

    // `job.opts.lifo` decides which end of `wait` the job goes back on, and it
    // is per job rather than per queue. Read for the whole batch in one trip.
    let mut opts_pipe = redis::pipe();
    for id in &req.job_ids {
        opts_pipe
            .cmd("HGET")
            .arg(key(&req.prefix, &req.queue, id))
            .arg("opts");
    }
    let opts: Vec<Option<String>> = opts_pipe.query_async(&mut *conn).await?;

    let prop = if req.state == "failed" {
        "failedReason"
    } else {
        "returnvalue"
    };
    let reset = if req.reset_attempts_made { "1" } else { "0" };

    let mut pipe = redis::pipe();
    for (id, raw_opts) in req.job_ids.iter().zip(&opts) {
        let lifo = raw_opts
            .as_deref()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
            .is_some_and(|v| v.get("lifo").and_then(serde_json::Value::as_bool) == Some(true));

        pipe.cmd("EVALSHA")
            .arg(&sha)
            .arg(8)
            .arg(key(&req.prefix, &req.queue, id))
            .arg(key(&req.prefix, &req.queue, "events"))
            .arg(key(&req.prefix, &req.queue, &req.state))
            .arg(key(&req.prefix, &req.queue, "wait"))
            .arg(key(&req.prefix, &req.queue, "meta"))
            .arg(key(&req.prefix, &req.queue, "paused"))
            .arg(key(&req.prefix, &req.queue, "active"))
            .arg(key(&req.prefix, &req.queue, "marker"))
            .arg(id)
            .arg(if lifo { "RPUSH" } else { "LPUSH" })
            .arg(prop)
            .arg(&req.state)
            .arg(reset)
            // attemptsStarted is left alone. It is the counter the worker uses
            // to place the current run, and resetting it without resetting
            // attemptsMade would make the two disagree.
            .arg("0");
    }

    let codes: Vec<i64> = pipe.query_async(&mut *conn).await?;

    Ok(req
        .job_ids
        .iter()
        .zip(codes)
        .map(|(job_id, code)| RetryOutcome {
            job_id: job_id.clone(),
            code,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A queue named `orders:eu` produces the key `bull:orders:eu:meta`.
    /// Splitting that on ':' would discover a queue called `orders`, and every
    /// command against it would then run on keys that do not exist.
    #[test]
    fn keeps_a_colon_inside_a_queue_name() {
        let head = "bull:";
        let name = "bull:orders:eu:meta"
            .strip_prefix(head)
            .and_then(|r| r.strip_suffix(":meta"));
        assert_eq!(name, Some("orders:eu"));
    }

    /// Stream ids compared as text report a gap the moment the millisecond
    /// component crosses a power of ten, which would make the trace claim
    /// events were lost on every long-lived queue.
    #[test]
    fn compares_stream_ids_as_numbers() {
        assert!(stream_id_after("10-0", "9-0"));
        assert!(!stream_id_after("9-0", "10-0"));
        assert!(stream_id_after("100-1", "100-0"));
        assert!(!stream_id_after("100-0", "100-0"));
    }

    /// Two lists and five sorted sets. Reading a list with ZCARD returns an
    /// error rather than a count, so this decides whether the sidebar shows a
    /// number or nothing at all.
    #[test]
    fn knows_which_states_are_lists() {
        assert!(is_list("wait"));
        assert!(is_list("active"));
        assert!(!is_list("delayed"));
        assert!(!is_list("prioritized"));
        assert!(!is_list("completed"));
        assert!(!is_list("failed"));
        assert!(!is_list("waiting-children"));
    }
}
