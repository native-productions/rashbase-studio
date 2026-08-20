/**
 * The rules that decide what a job row holds, what a beam is claiming, and
 * which steps a trace says happened.
 *
 * Every case here fails silently if it regresses. A rate computed from a gapped
 * event window is a number that looks like a measurement. A timeline that
 * merges two attempts into one is a story that reads fine and is wrong. A
 * column that shifts by one puts a failure reason under the payload header. The
 * diagram and the grid draw whatever this layer produces without checking it,
 * which is why it is checked here.
 */
import { expect, test } from "bun:test";
import { JOB_COL, edgeForEvent, QUEUE_EDGES, QUEUE_STATES } from "@/lib/constants/bullmq";
import {
  changedSince,
  delayedRunsAt,
  edgeRates,
  formatDuration,
  jobDuration,
  jobField,
  jobTimeline,
  jobsToResult,
  retryOutcome,
  retryPreview,
  stagedJobsIn,
  streamIdAfter,
} from "@/lib/utils/bullmq";
import type { JobEntry, JobPage, QueueEvent } from "@/lib/types";

const job = (id: string, fields: Record<string, string>): JobEntry => ({
  id,
  fields,
  score: null,
});

const page = (jobs: JobEntry[], total = jobs.length): JobPage => ({
  jobs,
  total,
  order: "recent-first",
});

const event = (ms: number, name: string, jobId: string, rest: Record<string, string> = {}):
  QueueEvent => ({
  id: `${ms}-0`,
  fields: { event: name, jobId, ...rest },
});

// -- Fields ------------------------------------------------------------------

/**
 * `attemptsMade` was shortened to `atm`, and a queue upgraded mid-flight holds
 * jobs written under both names. Reading one only puts an empty column beside a
 * job that plainly has attempts.
 */
test("reads a field under whichever name this BullMQ version wrote it", () => {
  expect(jobField(job("1", { attemptsMade: "2" }), "attemptsMade", "atm")).toBe("2");
  expect(jobField(job("1", { atm: "3" }), "attemptsMade", "atm")).toBe("3");
  // An empty string is not a value. BullMQ writes one for a field it cleared,
  // and treating it as present would print a blank where the fallback should
  // have answered.
  expect(jobField(job("1", { attemptsMade: "", atm: "3" }), "attemptsMade", "atm")).toBe("3");
  expect(jobField(job("1", {}), "attemptsMade", "atm")).toBeNull();
});

/**
 * A delayed job's score packs part of the job id into the low twelve bits.
 * Read as a plain timestamp it is off by up to four thousand — and, for a
 * queue whose scores were written as seconds, lands in 1970.
 */
test("decodes a delayed score to the moment the job becomes ready", () => {
  const runsAt = 1_700_000_000_000;
  expect(delayedRunsAt(runsAt * 0x1000 + 41)).toBe(runsAt);
});

/**
 * A job that has not started has no duration. Printing `0ms` would say it
 * finished instantly, which is the opposite of what is happening.
 */
test("has no duration until a job has both timestamps", () => {
  expect(jobDuration(job("1", { processedOn: "1000", finishedOn: "2500" }))).toBe(1500);
  expect(jobDuration(job("1", { processedOn: "1000" }))).toBeNull();
  expect(jobDuration(job("1", { processedOn: "0", finishedOn: "2500" }))).toBeNull();
  expect(jobDuration(job("1", {}))).toBeNull();
});

test("prints a duration the way a person reads one", () => {
  expect(formatDuration(340)).toBe("340ms");
  expect(formatDuration(1_500)).toBe("1.50s");
  expect(formatDuration(42_000)).toBe("42.0s");
  expect(formatDuration(125_000)).toBe("2m 5s");
});

// -- The grid ----------------------------------------------------------------

test("puts every job field in the column its header names", () => {
  const result = jobsToResult(
    page([
      job("42", {
        name: "send-invoice",
        attemptsMade: "2",
        opts: '{"attempts":3}',
        progress: "60",
        timestamp: "1700000000000",
        processedOn: "1700000000000",
        finishedOn: "1700000001500",
        data: '{"orderId":7}',
        failedReason: "connect ECONNREFUSED",
      }),
    ]),
  );

  const row = result.rows[0]!;
  expect(row[JOB_COL.id]).toBe("42");
  expect(row[JOB_COL.name]).toBe("send-invoice");
  expect(row[JOB_COL.attempts]).toBe("2/3");
  expect(row[JOB_COL.progress]).toBe("60");
  expect(row[JOB_COL.took]).toBe("1.50s");
  expect(row[JOB_COL.data]).toBe('{"orderId":7}');
  expect(row[JOB_COL.reason]).toBe("connect ECONNREFUSED");
  expect(result.columns.length).toBe(row.length);
});

/**
 * `opts` is JSON written by someone else's application. A job whose options do
 * not parse still has an attempts count worth showing, and a page that threw
 * here would show nothing at all.
 */
test("survives a job whose options are not JSON", () => {
  const result = jobsToResult(page([job("1", { attemptsMade: "2", opts: "not json" })]));
  expect(result.rows[0]![JOB_COL.attempts]).toBe("2");
});

/**
 * `rowsAffected` is the whole state, not the page. That gap is what lets the
 * footer say "50 of 12,904" rather than claiming the state holds fifty.
 */
test("reports the size of the state rather than the size of the page", () => {
  const result = jobsToResult(page([job("1", {}), job("2", {})], 12_904));
  expect(result.rowsAffected).toBe(12_904);
  expect(result.truncated).toBe(true);
});

test("stages only the jobs still on screen, in screen order", () => {
  const result = jobsToResult(page([job("7", {}), job("8", {}), job("9", {})]));
  expect(stagedJobsIn(result, new Set(["9", "7", "404"]))).toEqual(["7", "9"]);
});

// -- Rates -------------------------------------------------------------------

/**
 * The reason the event stream is read at all. `prev` is the only thing that
 * separates a retried job from a newly added one, and a monitor that draws a
 * retry storm as ordinary intake is hiding the thing it was opened to find.
 */
test("tells a retry apart from an arrival by what the job came from", () => {
  expect(edgeForEvent("waiting", "failed")).toBe("failed->wait");
  // A re-run of something that succeeded is not a failure loop. Folding the
  // two together lights the failed edge when nothing failed — and this app
  // offers retry from `completed`, so it is a path someone will actually take.
  expect(edgeForEvent("waiting", "completed")).toBe("completed->wait");
  expect(edgeForEvent("waiting", "delayed")).toBe("delayed->wait");
  expect(edgeForEvent("added", undefined)).toBe("added->wait");
  expect(edgeForEvent("active", undefined)).toBe("wait->active");
  expect(edgeForEvent("active", "prioritized")).toBe("prioritized->active");
  expect(edgeForEvent("completed", undefined)).toBe("active->completed");
  expect(edgeForEvent("failed", undefined)).toBe("active->failed");
});

/**
 * BullMQ emits `added` and then `waiting` for the same arrival. Counting both
 * would report exactly twice the intake the queue is actually taking.
 */
test("does not count one arrival twice", () => {
  expect(edgeForEvent("waiting", undefined)).toBeNull();
});

/**
 * `progress`, `stalled` and `removed` are real events that are not transitions.
 * Folding them into the nearest edge would inflate a number the beam is
 * supposed to be a measurement of.
 */
test("counts no rate for an event that is not a transition", () => {
  expect(edgeForEvent("progress", undefined)).toBeNull();
  expect(edgeForEvent("stalled", undefined)).toBeNull();
  expect(edgeForEvent("removed", undefined)).toBeNull();
});

test("measures a rate per second over the window, not over everything held", () => {
  const now = 100_000;
  const events = [
    // Inside a 5s window: four completions.
    event(now - 4_000, "completed", "1"),
    event(now - 3_000, "completed", "2"),
    event(now - 2_000, "completed", "3"),
    event(now - 1_000, "completed", "4"),
    // Older than the window. A queue that was busy a minute ago and is idle
    // now has to read as idle.
    event(now - 60_000, "completed", "5"),
    event(now - 61_000, "completed", "6"),
  ];
  const rates = edgeRates(events, now, 5_000);
  expect(rates["active->completed"]).toBeCloseTo(0.8);
  expect(rates["active->failed"]).toBeUndefined();
});

/**
 * A queue where nothing has moved reports no rate at all, not a rate of zero
 * on every edge. The diagram draws an absent rate as no beam, and a present
 * zero would be a beam configured to stand still.
 */
test("reports nothing on an edge that saw nothing", () => {
  expect(edgeRates([], 1_000)).toEqual({});
});

// -- The trace ---------------------------------------------------------------

test("builds a timeline from the stream where it reaches", () => {
  const j = job("42", { timestamp: "1000", processedOn: "1100", finishedOn: "1400" });
  const steps = jobTimeline(j, [
    event(1_000, "added", "42"),
    event(1_100, "active", "42", { prev: "waiting" }),
    event(1_250, "progress", "42", { data: "60" }),
    event(1_400, "completed", "42"),
    // Another job's history must not appear in this one.
    event(1_300, "failed", "99"),
  ]);

  expect(steps.map((s) => s.event)).toEqual(["added", "active", "progress", "completed"]);
  expect(steps.every((s) => s.source === "stream")).toBe(true);
  expect(steps[2]!.detail).toBe("60");
  expect(steps[1]!.prev).toBe("waiting");
});

/**
 * The stream is trimmed at ten thousand entries by default, so any job older
 * than that has nothing on it. Falling back to the three timestamps the hash
 * carries is what keeps an old failure traceable at all — and the steps say
 * they were inferred, because a trace that looked identical either way would
 * claim to have witnessed transitions it never saw.
 */
test("falls back to the job's own timestamps when the stream has been trimmed", () => {
  const j = job("42", {
    timestamp: "1000",
    processedOn: "1100",
    finishedOn: "1400",
    failedReason: "boom",
  });
  const steps = jobTimeline(j, []);

  expect(steps.map((s) => s.event)).toEqual(["added", "active", "failed"]);
  expect(steps.every((s) => s.source === "job")).toBe(true);
});

/**
 * The anchors and the stream describe the same transitions. Adding both would
 * show a job going active twice, which reads as a stall-and-recover that never
 * happened.
 */
test("does not repeat a transition the stream already witnessed", () => {
  const j = job("42", { timestamp: "1000", processedOn: "1100", finishedOn: "1400" });
  const steps = jobTimeline(j, [event(1_100, "active", "42")]);

  expect(steps.map((s) => s.event)).toEqual(["added", "active", "completed"]);
  expect(steps.filter((s) => s.event === "active").length).toBe(1);
});

/**
 * A retried job goes through `active` more than once, and the stream says so.
 * Collapsing the two would hide exactly the thing someone opens a trace for:
 * that attempt one failed and attempt two is running.
 */
test("keeps each attempt of a retried job as its own pass", () => {
  const j = job("42", { timestamp: "1000", processedOn: "1600", attemptsMade: "1" });
  const steps = jobTimeline(j, [
    event(1_000, "added", "42"),
    event(1_100, "active", "42"),
    event(1_300, "failed", "42"),
    event(1_500, "waiting", "42", { prev: "failed" }),
    event(1_600, "active", "42"),
  ]);

  expect(steps.map((s) => s.event)).toEqual([
    "added",
    "active",
    "failed",
    "waiting",
    "active",
  ]);
  expect(steps[3]!.prev).toBe("failed");
});

// -- The write ---------------------------------------------------------------

test("prints the retry before it runs, eliding the middle of a long list", () => {
  expect(retryPreview(["1", "2"], "failed", false)).toBe("RETRY 1 2 · failed → waiting");
  expect(retryPreview(["1", "2", "3", "4", "5"], "failed", false)).toBe(
    "RETRY 1 2 3 … 5 · failed → waiting",
  );
  // Resetting attempts is the other binding, and the preview has to say which
  // one is about to run: it is the difference between a job that gets one more
  // try and one that gets its whole allowance back.
  expect(retryPreview(["1"], "failed", true)).toBe(
    "RETRY 1 · failed → waiting · reset attempts",
  );
});

/**
 * The batch is partial whenever someone else got there first. Rounding a
 * mixed result up to "15 retried" would be the app claiming work it did not do.
 */
test("reports every code a batch came back with", () => {
  expect(
    retryOutcome([
      { jobId: "1", code: 1 },
      { jobId: "2", code: 1 },
      { jobId: "3", code: -1 },
      { jobId: "4", code: -3 },
    ]),
  ).toBe("2 retried · 1 gone · 1 no longer in that state");

  expect(retryOutcome([{ jobId: "1", code: 1 }])).toBe("1 retried");
});

// -- The diagram is a constant ----------------------------------------------

/**
 * The layout is a table rather than an algorithm, so an edge naming a node that
 * is not there is not a compile error — it is an edge React Flow silently drops
 * and a transition that stops being drawn.
 */
test("every edge joins two nodes that exist", () => {
  const nodes = new Set(QUEUE_STATES.map((s) => s.id));
  for (const edge of QUEUE_EDGES) {
    expect(nodes.has(edge.source)).toBe(true);
    expect(nodes.has(edge.target)).toBe(true);
  }
});

/**
 * Every edge `edgeForEvent` can name has to be one the diagram draws, or a
 * measured rate lands on an edge nothing renders and the movement is invisible.
 */
test("every edge a rate can land on is one the diagram draws", () => {
  const drawn = new Set(QUEUE_EDGES.map((e) => e.id));
  const reachable = [
    edgeForEvent("added", undefined),
    edgeForEvent("waiting", "failed"),
    edgeForEvent("waiting", "completed"),
    edgeForEvent("waiting", "delayed"),
    edgeForEvent("waiting", "waiting-children"),
    edgeForEvent("active", undefined),
    edgeForEvent("active", "prioritized"),
    edgeForEvent("completed", undefined),
    edgeForEvent("failed", undefined),
  ];
  for (const edge of reachable) {
    expect(edge).not.toBeNull();
    expect(drawn.has(edge!)).toBe(true);
  }
});

// -- Staleness ---------------------------------------------------------------

/**
 * The reason this is counted off the stream instead of by subtracting the live
 * count from the page's own total: three jobs failing while three others are
 * retried leaves the count identical and the page completely out of date. A net
 * difference of zero is not evidence that nothing happened.
 */
test("sees churn that leaves the count unchanged", () => {
  const events = [
    event(2_000, "failed", "1"),
    event(2_100, "failed", "2"),
    event(2_200, "failed", "3"),
    event(2_300, "waiting", "4", { prev: "failed" }),
    event(2_400, "waiting", "5", { prev: "failed" }),
    event(2_500, "waiting", "6", { prev: "failed" }),
  ];
  expect(changedSince(events, "failed", "1000-0")).toBe(6);
});

test("counts only what happened after the page was read", () => {
  const events = [
    event(1_000, "failed", "1"),
    event(2_000, "failed", "2"),
    event(3_000, "failed", "3"),
  ];
  expect(changedSince(events, "failed", "2000-0")).toBe(1);
  // The resume point itself is not a change: the page that recorded it already
  // accounts for everything up to and including it.
  expect(changedSince(events, "failed", "3000-0")).toBe(0);
});

test("ignores what did not touch this state", () => {
  const events = [
    event(2_000, "completed", "1"),
    event(2_100, "progress", "2", { data: "50" }),
    event(2_200, "added", "3"),
  ];
  expect(changedSince(events, "failed", "1000-0")).toBe(0);
  expect(changedSince(events, "completed", "1000-0")).toBe(1);
  expect(changedSince(events, "wait", "1000-0")).toBe(1);
});

/** A page that was never read has nothing to be behind. */
test("reports nothing behind before a page has been read", () => {
  expect(changedSince([event(2_000, "failed", "1")], "failed", "")).toBe(0);
});

/**
 * Stream ids compared as text report every id as stale the moment the
 * millisecond component crosses a power of ten. The backend compares them as
 * numbers and the two have to agree.
 */
test("compares stream ids as numbers, not as text", () => {
  expect(streamIdAfter("10-0", "9-0")).toBe(true);
  expect(streamIdAfter("9-0", "10-0")).toBe(false);
  expect(streamIdAfter("100-1", "100-0")).toBe(true);
  expect(streamIdAfter("100-0", "100-0")).toBe(false);
  expect(changedSince([event(10_000, "failed", "1")], "failed", "9000-0")).toBe(1);
});
