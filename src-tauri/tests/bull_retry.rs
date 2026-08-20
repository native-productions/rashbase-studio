//! Retrying BullMQ jobs against a real server.
//!
//! Retry is the one BullMQ command in this app that writes, and every failure
//! mode it has is silent. Nothing here can be reached by a unit test, because
//! all of it is about what BullMQ's own Lua script does to keys we did not
//! write:
//!
//! 1. **The parent link is restored.** A job produced by a Flow lives in its
//!    parent's dependency set. A retry that moves the job but forgets the
//!    parent leaves the parent waiting forever on a dependency that is now
//!    running — days later, with nothing tying it back to the retry.
//! 2. **The marker is set.** It is what a blocked worker waits on. Without it
//!    the job sits in `wait` until the next drain poll and the retry reads as
//!    having silently done nothing.
//! 3. **A second retry is refused, not duplicated.** `-3` rather than a second
//!    copy of the job in `wait`, which would run it twice.
//! 4. **`attemptsMade` survives by default.** Clearing it quietly would hand a
//!    job that has exhausted its allowance a fresh one nobody asked for.
//! 5. **`lifo` picks the end of the list.** Reading it off the wrong end puts
//!    an urgent job behind every other job in the queue.
//! 6. **A v4 `paused` list is refused.** There, retry would push into `wait` on
//!    a queue the application believes is paused.
//!
//! Skipped unless `RASHBASE_REDIS_HOST` is set, so a normal `cargo test` on a
//! machine with no Redis still passes. Nothing here flushes: every key it
//! writes is under `PREFIX` and it deletes exactly those, so it is safe to
//! point at a database that already holds something.
//!
//! ```sh
//! docker run -d -p 6379:6379 redis:7
//! RASHBASE_REDIS_HOST=127.0.0.1 cargo test --test bull_retry -- --nocapture
//! ```

use rashbase_studio_lib::drivers::redis::bull::RetryRequest;
use rashbase_studio_lib::drivers::{ConnectionConfig, DbState, KeyFilter, SslMode};

/// The prefix this test writes under. Not `bull`, so it can never collide with
/// a real queue in a database someone points it at by accident.
const PREFIX: &str = "rashbasetest";
const QUEUE: &str = "orders:eu";

fn var(name: &str, fallback: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| fallback.to_string())
}

fn env_config() -> Option<ConnectionConfig> {
    Some(ConnectionConfig {
        id: "bull-retry".into(),
        driver: "redis".into(),
        name: "bull retry".into(),
        host: std::env::var("RASHBASE_REDIS_HOST").ok()?,
        port: var("RASHBASE_REDIS_PORT", "6379").parse().unwrap_or(6379),
        user: var("RASHBASE_REDIS_USER", ""),
        // Its own database, and its own variable, because `redis_keyspace.rs`
        // begins with FLUSHDB and cargo runs the two test binaries at the same
        // time. Sharing `RASHBASE_REDIS_DB` would let that flush land in the
        // middle of this test, which fails as something that looks like a bug
        // in the retry rather than as two suites standing on each other.
        database: var("RASHBASE_REDIS_BULL_DB", "10"),
        ssl_mode: SslMode::Disable,
        environment: Some("local".into()),
        parent_id: None,
        ssh: None,
    })
}

/// Deletes everything this test wrote, and nothing else.
///
/// No FLUSHDB anywhere in this file, unlike `redis_keyspace.rs`. Everything
/// here lives under `PREFIX`, so the test can clean up precisely — which means
/// it neither needs a guard against an occupied database nor collides with the
/// other Redis suite when cargo runs the two binaries at the same time.
async fn clear(db: &DbState, id: &str) {
    let page = db
        .list_keys(
            id,
            &KeyFilter {
                pattern: Some(format!("{PREFIX}:*")),
                contains: None,
                case_sensitive: false,
            },
            0,
            100_000,
        )
        .await
        .expect("list");
    let keys: Vec<String> = page.keys.into_iter().map(|k| k.key).collect();
    if !keys.is_empty() {
        db.delete_keys(id, &keys).await.expect("clear");
    }
}

/// A queue laid out the way BullMQ v5 lays one out, with `failed` jobs in it.
///
/// Written by hand rather than by running BullMQ, because the point of the
/// test is that this app reads and writes the layout correctly — a fixture
/// produced by the library under test would hide a disagreement about it.
async fn seed(db: &DbState, id: &str) {
    let q = format!("{PREFIX}:{QUEUE}");
    let mut script = String::new();

    script.push_str(&format!("HSET {q}:meta opts.maxLenEvents 10000\n"));
    script.push_str(&format!("SET {q}:id 3\n"));

    // Three failed jobs, scored by when they finished.
    for i in 1..=3 {
        script.push_str(&format!("ZADD {q}:failed {} {i}\n", 1_700_000_000_000i64 + i));
        script.push_str(&format!(
            "HSET {q}:{i} name send-invoice data '{{\"orderId\":{i}}}' opts '{{\"attempts\":3}}' \
             timestamp 1700000000000 processedOn 1700000000100 finishedOn 1700000000200 \
             atm 3 ats 3 failedReason 'connect ECONNREFUSED'\n"
        ));
    }

    // Job 4 is LIFO, so a retry has to put it on the other end of `wait`.
    script.push_str(&format!("ZADD {q}:failed 1700000000004 4\n"));
    script.push_str(&format!(
        "HSET {q}:4 name urgent data '{{}}' opts '{{\"lifo\":true}}' \
         timestamp 1700000000000 failedReason 'boom'\n"
    ));

    // Job 5 belongs to a flow. Its parent holds it as an unsuccessful child,
    // and a retry has to put it back among the dependencies.
    let parent = format!("{PREFIX}:invoices:99");
    script.push_str(&format!("ZADD {q}:failed 1700000000005 5\n"));
    script.push_str(&format!(
        "HSET {q}:5 name child data '{{}}' opts '{{}}' parentKey {parent} failedReason 'boom'\n"
    ));
    script.push_str(&format!("HSET {parent} name parent data '{{}}'\n"));
    script.push_str(&format!("ZADD {parent}:unsuccessful 1700000000005 {q}:5\n"));

    // Something in every other state, so the counts have more than zeroes.
    script.push_str(&format!("RPUSH {q}:wait 10 11\n"));
    script.push_str(&format!("RPUSH {q}:active 12\n"));
    script.push_str(&format!("ZADD {q}:delayed 1700000000000 13\n"));
    script.push_str(&format!("ZADD {q}:completed 1700000000000 14\n"));

    db.execute(id, &script, None).await.expect("seed");
}

async fn field(db: &DbState, id: &str, key: &str, field: &str) -> Option<String> {
    let results = db
        .execute(id, &format!("HGET {key} {field}"), None)
        .await
        .ok()?;
    results.first()?.rows.first()?.first()?.clone()
}

async fn members(db: &DbState, id: &str, cmd: &str) -> Vec<String> {
    db.execute(id, cmd, None)
        .await
        .expect("read")
        .first()
        .map(|r| r.rows.iter().filter_map(|row| row[0].clone()).collect())
        .unwrap_or_default()
}

fn retry(ids: &[&str]) -> RetryRequest {
    RetryRequest {
        prefix: PREFIX.into(),
        queue: QUEUE.into(),
        state: "failed".into(),
        job_ids: ids.iter().map(|s| s.to_string()).collect(),
        reset_attempts_made: false,
    }
}

#[tokio::test]
async fn retries_failed_jobs_the_way_bullmq_does() {
    let Some(config) = env_config() else {
        eprintln!("RASHBASE_REDIS_HOST not set; skipping");
        return;
    };

    let db = DbState::default();
    let id = config.id.clone();
    db.connect(&config, None, None).await.expect("connect");
    clear(&db, &id).await;
    seed(&db, &id).await;

    let q = format!("{PREFIX}:{QUEUE}");

    // -- Discovery ----------------------------------------------------------
    //
    // The queue is named `orders:eu`. A discovery that splits the key on ':'
    // finds a queue called `orders`, and every command after that runs against
    // keys nothing wrote.
    let page = db.list_queues(&id, PREFIX, 0, 50).await.expect("queues");
    let queue = page
        .queues
        .iter()
        .find(|q| q.name == QUEUE)
        .expect("the queue is discovered under its full name");
    assert_eq!(queue.counts["failed"], 5);
    assert_eq!(queue.counts["wait"], 2);
    assert_eq!(queue.counts["active"], 1);
    assert_eq!(queue.counts["delayed"], 1);
    assert_eq!(queue.counts["completed"], 1);
    assert!(!queue.paused);

    // -- wait is read from the end that runs next ---------------------------
    //
    // `wait` is LPUSHed and popped from the right, so `10` — pushed first by
    // RPUSH, therefore sitting at the head — is *not* what runs next. `11` is.
    let jobs = db
        .list_jobs(&id, PREFIX, QUEUE, "wait", 0, 10)
        .await
        .expect("wait page");
    assert_eq!(jobs.order, "next-first");
    assert_eq!(
        jobs.jobs.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
        ["11", "10"],
        "the tail of the list is the job that runs next"
    );

    // `delayed` is a sorted set read from its head and `wait` is a list read
    // from its tail, and both of those are the job that runs next. Labelling
    // the delayed page "most recent first" would tell the reader the top row is
    // the last thing scheduled when it is the next thing to fire.
    let delayed = db
        .list_jobs(&id, PREFIX, QUEUE, "delayed", 0, 10)
        .await
        .expect("delayed page");
    assert_eq!(delayed.order, "next-first");
    let completed = db
        .list_jobs(&id, PREFIX, QUEUE, "completed", 0, 10)
        .await
        .expect("completed page");
    assert_eq!(completed.order, "recent-first");

    // -- The retry itself ---------------------------------------------------
    let out = db.retry_jobs(&id, &retry(&["1", "2"])).await.expect("retry");
    assert_eq!(out.iter().map(|o| o.code).collect::<Vec<_>>(), [1, 1]);

    assert_eq!(
        field(&db, &id, &format!("{q}:1"), "failedReason").await,
        None,
        "failedReason is cleared, or the job still reads as failed"
    );
    assert_eq!(field(&db, &id, &format!("{q}:1"), "finishedOn").await, None);
    assert_eq!(field(&db, &id, &format!("{q}:1"), "processedOn").await, None);
    assert_eq!(
        field(&db, &id, &format!("{q}:1"), "atm").await.as_deref(),
        Some("3"),
        "attemptsMade survives a retry that did not ask to reset it"
    );

    // Both are back in `wait`, at the end that runs next, and the failed set no
    // longer holds them.
    let waiting = members(&db, &id, &format!("LRANGE {q}:wait 0 -1")).await;
    assert!(waiting.contains(&"1".to_string()) && waiting.contains(&"2".to_string()));
    let failed = members(&db, &id, &format!("ZRANGE {q}:failed 0 -1")).await;
    assert!(!failed.contains(&"1".to_string()));

    // The marker is what wakes a blocked worker. Without it the job is in the
    // list and nothing picks it up until the next drain poll.
    let marker = members(&db, &id, &format!("ZRANGE {q}:marker 0 -1")).await;
    assert_eq!(marker, ["0"], "the marker wakes a blocked worker");

    // And the retry is on the event stream, which is what the trace reads.
    let events = db
        .queue_events(&id, PREFIX, QUEUE, None, 100)
        .await
        .expect("events");
    assert!(
        events
            .events
            .iter()
            .any(|e| e.fields.get("event").map(String::as_str) == Some("waiting")
                && e.fields.get("jobId").map(String::as_str) == Some("1")),
        "a retry emits the waiting event listeners and the trace both read"
    );
    assert!(!events.trimmed);

    // The clock a rate is divided by. Stream ids are stamped by the server, so
    // dividing by the *client* clock makes every rate wrong by however far the
    // two machines have drifted — which is the normal case for a laptop talking
    // to a production replica, and invisible when it happens.
    let newest = events
        .events
        .last()
        .map(|e| e.id.split('-').next().unwrap_or("0").parse::<u64>().unwrap_or(0))
        .expect("the retry put an event on the stream");
    assert!(
        events.server_now >= newest && events.server_now - newest < 60_000,
        "server_now ({}) has to be the server's own clock, beside the ids it stamped ({newest})",
        events.server_now
    );

    // -- Retrying the same job twice ---------------------------------------
    let out = db.retry_jobs(&id, &retry(&["1"])).await.expect("retry");
    assert_eq!(
        out[0].code, -3,
        "a job already retried is reported, not moved a second time"
    );
    let waiting = members(&db, &id, &format!("LRANGE {q}:wait 0 -1")).await;
    assert_eq!(
        waiting.iter().filter(|j| *j == "1").count(),
        1,
        "and it is not queued twice, which would run it twice"
    );

    // A job whose hash is gone comes back -1 rather than failing the batch.
    let out = db
        .retry_jobs(&id, &retry(&["3", "nosuchjob"]))
        .await
        .expect("retry");
    assert_eq!(out[0].code, 1);
    assert_eq!(out[1].code, -1);

    // -- Resetting attempts is opt-in --------------------------------------
    let mut req = retry(&[]);
    req.job_ids = vec!["4".into()];
    req.reset_attempts_made = true;
    let out = db.retry_jobs(&id, &req).await.expect("retry");
    assert_eq!(out[0].code, 1);
    assert_eq!(
        field(&db, &id, &format!("{q}:4"), "atm").await,
        None,
        "resetAttemptsMade clears the counter"
    );

    // Job 4 is `lifo`, so it goes on the opposite end from a normal retry.
    // Everything else was LPUSHed to the head; this one is RPUSHed to the tail,
    // which is the end that runs next.
    let waiting = members(&db, &id, &format!("LRANGE {q}:wait 0 -1")).await;
    assert_eq!(
        waiting.last().map(String::as_str),
        Some("4"),
        "a lifo job is put where it runs next, not behind the whole queue"
    );

    // -- The flow parent ----------------------------------------------------
    let out = db.retry_jobs(&id, &retry(&["5"])).await.expect("retry");
    assert_eq!(out[0].code, 1);
    let parent = format!("{PREFIX}:invoices:99");
    let deps = members(&db, &id, &format!("SMEMBERS {parent}:dependencies")).await;
    assert_eq!(
        deps,
        [format!("{q}:5")],
        "a retried child is put back among its parent's dependencies, or the \
         parent waits forever on a job that is now running"
    );
    let unsuccessful = members(&db, &id, &format!("ZRANGE {parent}:unsuccessful 0 -1")).await;
    assert!(unsuccessful.is_empty());

    // -- A v4 paused list is refused ---------------------------------------
    //
    // Before v5, pausing moved jobs into their own list. `reprocessJob` pushes
    // to `wait` and reads `paused` off the meta hash, so on a v4 queue it would
    // start a job on a queue the application believes is stopped.
    db.execute(&id, &format!("RPUSH {q}:paused 99"), None)
        .await
        .expect("legacy paused");
    let err = db
        .retry_jobs(&id, &retry(&["2"]))
        .await
        .expect_err("a v4 paused list is refused");
    assert!(
        err.to_string().contains("BullMQ v4"),
        "the refusal says which version wrote these keys: {err}"
    );

    clear(&db, &id).await;
    db.disconnect(&id).await.expect("disconnect");
}
