/**
 * The queue layer: everything that turns a BullMQ key layout into rows,
 * measured rates, and one job's history.
 *
 * Pure and dependency-free, for the reason `utils/redis.ts` is: this decides
 * what a cell holds, what the beam on an edge is claiming, and which steps a
 * trace says happened. All three are worth reading and testing as one thing,
 * and none of them should need a component mounted to exercise.
 *
 * Nothing downstream of `jobsToResult` learns that BullMQ exists — the grid,
 * the row panel, the JSON tree and the virtualizer draw a job page the same
 * way they draw a table.
 */

import {
  JOB_COL,
  JOB_COLUMNS,
  edgeForEvent,
  QUEUE_STATES,
} from "@/lib/constants/bullmq";
import type { JobEntry, JobPage, QueryResult, QueueEvent, RetryOutcome, RowKey } from "@/lib/types";

/**
 * How far back a rate is measured.
 *
 * Short enough that a queue going quiet shows it within a few seconds, long
 * enough that one slow job does not read as a dead queue. Rates are drawn as
 * motion, and motion that flickers between two values every poll is worse than
 * no motion at all.
 */
export const RATE_WINDOW_MS = 5_000;

/**
 * Reads a field under whichever name this BullMQ version wrote it.
 *
 * `attemptsMade` was shortened to `atm` and `attemptsStarted` to `ats`, and a
 * queue can hold jobs written by both — an application upgraded mid-flight has
 * old jobs in `failed` and new ones in `wait`. Reading one name only puts an
 * empty column next to a job that plainly has attempts.
 */
export function jobField(job: JobEntry, ...names: string[]): string | null {
  for (const name of names) {
    const value = job.fields[name];
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

/** The millisecond timestamp inside a stream id. */
export const eventTime = (id: string): number => Number(id.split("-")[0] ?? 0);

/**
 * Whether stream id `a` is strictly later than `b`.
 *
 * Compared as the two numbers a stream id is, never as text: `10-0` sorts
 * before `9-0` as a string, which would report a gap on every stream that lived
 * long enough to cross a power of ten. The backend compares them the same way,
 * and the two have to agree or a page reads as stale the moment it is opened.
 */
export function streamIdAfter(a: string, b: string): boolean {
  const parts = (id: string): [number, number] => {
    const [ms, seq] = id.split("-");
    return [Number(ms) || 0, Number(seq) || 0];
  };
  const [am, as] = parts(a);
  const [bm, bs] = parts(b);
  return am !== bm ? am > bm : as > bs;
}

/**
 * How many jobs have moved into or out of `state` since the page was read.
 *
 * Counted off the event stream rather than by subtracting the live count from
 * the page's own total, and that is the whole point: three jobs failing while
 * three others are retried leaves the count identical and the page completely
 * out of date. A net difference of zero is not evidence that nothing happened.
 *
 * Under-reports when the stream was trimmed past `afterId`, which is the same
 * window the rates go `null` on and is already said out loud there.
 */
export function changedSince(events: QueueEvent[], state: string, afterId: string): number {
  if (!afterId) return 0;
  return events.filter((e) => {
    if (!streamIdAfter(e.id, afterId)) return false;
    const edge = edgeForEvent(e.fields.event ?? "", e.fields.prev);
    // An edge is `from->to`, so the state is touched when it is either end.
    return edge !== null && edge.split("->").includes(state);
  }).length;
}

/**
 * What a `delayed` job's score means.
 *
 * BullMQ packs the ready-at timestamp into the high bits and part of the job id
 * into the low twelve, so two jobs due at the same millisecond still order
 * deterministically. Read as a plain timestamp the value is off by up to four
 * thousand and lands in 1970.
 */
export const delayedRunsAt = (score: number): number => Math.floor(score / 0x1000);

/**
 * How long a job took, from the two timestamps its hash carries.
 *
 * Null rather than zero when either is missing: a job that has not started has
 * no duration, and printing `0ms` would say it finished instantly.
 */
export function jobDuration(job: JobEntry): number | null {
  const from = Number(jobField(job, "processedOn"));
  const to = Number(jobField(job, "finishedOn"));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0 || to === 0) return null;
  return Math.max(0, to - from);
}

/** A duration as a person reads one. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

/** A millisecond timestamp as a local clock time, or null for a missing one. */
export function formatWhen(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** `2/3`, or just the count when the job's options named no limit. */
function attemptsCell(job: JobEntry): string | null {
  const made = jobField(job, "attemptsMade", "atm");
  if (made === null) return null;
  let allowed: number | null = null;
  try {
    const opts = JSON.parse(jobField(job, "opts") ?? "{}");
    if (typeof opts?.attempts === "number") allowed = opts.attempts;
  } catch {
    // An unparseable `opts` is not worth failing a page over. The made count
    // is the half that matters and it is right there.
  }
  return allowed === null ? made : `${made}/${allowed}`;
}

/**
 * A page of jobs as a result set.
 *
 * The one function the whole feature rests on: after this a queue is something
 * the existing grid already knows how to draw, select in, and page.
 */
export function jobsToResult(page: JobPage, durationMs = 0): QueryResult {
  return {
    columns: JOB_COLUMNS,
    rows: page.jobs.map((job) => {
      const took = jobDuration(job);
      const created = Number(jobField(job, "timestamp"));
      return [
        job.id,
        jobField(job, "name"),
        attemptsCell(job),
        jobField(job, "progress"),
        formatWhen(Number.isFinite(created) ? created : null),
        took === null ? null : formatDuration(took),
        jobField(job, "data"),
        jobField(job, "failedReason"),
        jobField(job, "returnvalue"),
      ];
    }),
    // What the state actually holds, not what this page carries. That gap is
    // what lets the footer say "50 of 12,904" honestly.
    rowsAffected: page.total,
    truncated: page.jobs.length < page.total,
    durationMs,
  };
}

/** The identity of a job row: its id, which is its identity in Redis too. */
export function jobRowIdentity(result: QueryResult, row: number): RowKey[] | null {
  const id = result.rows[row]?.[JOB_COL.id];
  return id === null || id === undefined ? null : [{ column: "id", value: id }];
}

/** Every staged job id, in the order they appear on screen. */
export function stagedJobsIn(result: QueryResult, staged: Set<string>): string[] {
  return result.rows
    .map((row) => row[JOB_COL.id])
    .filter((id): id is string => id !== null && id !== undefined && staged.has(id));
}

/**
 * Transitions per second on each edge, over the last `RATE_WINDOW_MS`.
 *
 * This is the whole reason the event stream is read at all. The difference
 * between two polls of the counts cannot tell a queue where fifty jobs went in
 * and fifty came out from a queue where nothing happened, and a monitor that
 * animates those two the same way is worse than one that animates neither.
 *
 * `now` is passed in rather than read, so this stays pure and a test can put
 * the window wherever it needs it.
 */
export function edgeRates(
  events: QueueEvent[],
  now: number,
  windowMs = RATE_WINDOW_MS,
): Record<string, number> {
  const since = now - windowMs;
  const counts: Record<string, number> = {};

  for (const event of events) {
    if (eventTime(event.id) < since) continue;
    const edge = edgeForEvent(event.fields.event ?? "", event.fields.prev);
    if (edge === null) continue;
    counts[edge] = (counts[edge] ?? 0) + 1;
  }

  const seconds = windowMs / 1_000;
  return Object.fromEntries(Object.entries(counts).map(([edge, n]) => [edge, n / seconds]));
}

/** One step of a job's history. */
export interface TraceStep {
  /** Millisecond timestamp. */
  at: number;
  /** The BullMQ event name, or the transition a hash timestamp implies. */
  event: string;
  /** Where the job came from, when the stream said. */
  prev?: string;
  /** The progress value, for a `progress` step. */
  detail?: string;
  /**
   * Whether this step was witnessed on the event stream or inferred from the
   * job's own timestamps.
   *
   * The distinction is shown rather than smoothed over: the stream is trimmed,
   * so an old job has only the three anchors its hash carries, and a trace that
   * looked identical either way would be claiming to have seen transitions it
   * never did.
   */
  source: "stream" | "job";
}

/**
 * One job's history, newest last.
 *
 * Built from the event stream where it still reaches, and from the job's own
 * `timestamp` / `processedOn` / `finishedOn` where it does not. An anchor is
 * dropped when the stream already witnessed that transition, so a job the
 * stream still covers is not listed as having gone active twice.
 */
export function jobTimeline(job: JobEntry, events: QueueEvent[]): TraceStep[] {
  const mine = events.filter((e) => e.fields.jobId === job.id);
  const witnessed = new Set(mine.map((e) => e.fields.event));

  const steps: TraceStep[] = mine.map((e) => ({
    at: eventTime(e.id),
    event: e.fields.event ?? "?",
    ...(e.fields.prev ? { prev: e.fields.prev } : {}),
    ...(e.fields.data ? { detail: e.fields.data } : {}),
    source: "stream" as const,
  }));

  const anchor = (field: string, event: string) => {
    if (witnessed.has(event)) return;
    const at = Number(jobField(job, field));
    if (!Number.isFinite(at) || at <= 0) return;
    steps.push({ at, event, source: "job" });
  };

  anchor("timestamp", "added");
  anchor("processedOn", "active");
  // Which of the two a finish was is not in the timestamp; it is in whether the
  // job carries a reason for having thrown.
  anchor("finishedOn", jobField(job, "failedReason") === null ? "completed" : "failed");

  return steps.sort((a, b) => a.at - b.at);
}

/**
 * The retry a commit is about to run, for the status bar to print.
 *
 * The same bargain the staged deletion makes: what is shown is what will
 * happen, before it happens. Long lists are elided in the middle rather than
 * the end, because the first and last id are what say which range was marked.
 */
export function retryPreview(jobIds: string[], state: string, reset: boolean): string {
  const shown = 3;
  const body =
    jobIds.length <= shown + 1
      ? jobIds.join(" ")
      : `${jobIds.slice(0, shown).join(" ")} … ${jobIds[jobIds.length - 1]}`;
  return `RETRY ${body} · ${state} → waiting${reset ? " · reset attempts" : ""}`;
}

/**
 * What a batch of retries actually did.
 *
 * Every code is reported. A batch where two ids had already been retried by
 * someone else is a partial result, and rounding that up to "15 retried" would
 * be the app claiming work it did not do.
 */
export function retryOutcome(outcomes: RetryOutcome[]): string {
  const moved = outcomes.filter((o) => o.code === 1).length;
  const gone = outcomes.filter((o) => o.code === -1).length;
  const elsewhere = outcomes.filter((o) => o.code === -3).length;

  const parts = [`${moved} retried`];
  if (gone > 0) parts.push(`${gone} gone`);
  if (elsewhere > 0) parts.push(`${elsewhere} no longer in that state`);
  return parts.join(" · ");
}

/** The plain-language line under a state's name, for anything outside the
 *  diagram that has to name a state. */
export const stateLabel = (id: string): string =>
  QUEUE_STATES.find((s) => s.id === id)?.label ?? id;
