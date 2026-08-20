//! Temporary: reads the hand-seeded queue and prints what the UI receives.
use rashbase_studio_lib::drivers::{ConnectionConfig, DbState, SslMode};

#[tokio::test]
async fn dump() {
    let Ok(host) = std::env::var("RASHBASE_REDIS_HOST") else { return };
    let config = ConnectionConfig {
        id: "scratch".into(), driver: "redis".into(), name: "scratch".into(),
        host, port: 6379, user: "".into(), database: "11".into(),
        ssl_mode: SslMode::Disable, environment: Some("local".into()),
        parent_id: None, ssh: None,
    };
    let db = DbState::default();
    db.connect(&config, None, None).await.unwrap();

    let page = db.list_queues("scratch", "bull", 0, 200).await.unwrap();
    println!("scanned={} exhausted={}", page.scanned, page.exhausted);
    for q in &page.queues {
        println!("  {} paused={} legacy={} {:?}", q.name, q.paused, q.legacy_paused, q.counts);
    }

    for state in ["wait", "failed", "delayed", "completed"] {
        let jobs = db.list_jobs("scratch", "bull", "orders", state, 0, 3).await.unwrap();
        println!("[{state}] total={} order={}", jobs.total, jobs.order);
        for j in &jobs.jobs {
            println!("   id={} score={:?} name={:?} reason={:?} atm={:?}",
                j.id, j.score, j.fields.get("name"), j.fields.get("failedReason"),
                j.fields.get("atm"));
        }
    }

    let ev = db.queue_events("scratch", "bull", "orders", None, 12).await.unwrap();
    println!("events={} lastId={} trimmed={} serverNow={}",
             ev.events.len(), ev.last_id, ev.trimmed, ev.server_now);
    for e in ev.events.iter().take(5) {
        println!("   {} {:?}", e.id, e.fields);
    }
    db.disconnect("scratch").await.unwrap();
}
