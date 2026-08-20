/**
 * The shape of a BullMQ queue, as a constant.
 *
 * The lifecycle is the same for every queue BullMQ has ever created, so the
 * diagram's layout is a table rather than an algorithm: no dagre pass, no
 * stored node positions, no "reset layout" button, and no drag to persist.
 * That is most of what `lib/erd.ts` exists to do, and none of it is needed
 * here — the ERD lays out a graph nobody knew in advance, this draws one that
 * cannot change.
 */

import type { ColumnMeta } from "@/lib/types";

/** What BullMQ prefixes its keys with unless the application says otherwise. */
export const DEFAULT_PREFIX = "bull";

/**
 * How many queues one discovery walk brings back.
 *
 * A ceiling rather than a page size: an application with more than this many
 * queues is not one anybody browses in a sidebar, and the walk reports what it
 * scanned either way so a truncated list is visible as one.
 */
export const QUEUE_LIMIT = 200;

/** How often a live queue tab re-reads counts and events. */
export const POLL_MS = 1_000;

/**
 * How much of the event stream one poll takes.
 *
 * Also the ceiling on what a rate can measure: at more than this many events
 * per poll the tail falls behind and the number under-reports. Said here rather
 * than hidden, since a bound that was hit has to be reportable as a bound —
 * though a queue sustaining two thousand transitions a second is past what a
 * one-second poll was ever going to describe, and the stream trimming past the
 * resume point is what eventually says so out loud.
 */
export const EVENT_PAGE = 2_000;

/**
 * How many events the tab keeps.
 *
 * Sized from the rate window, not picked: `RATE_WINDOW_MS` is five seconds and
 * a poll is one, so anything under five times `EVENT_PAGE` would divide a
 * partial window by a whole one and under-report the rate on a busy queue. The
 * headroom past that is what a job's timeline is read from.
 */
export const EVENT_MEMORY = 12_000;

/**
 * One node of the lifecycle.
 *
 * `blurb` is not decoration and not a tooltip. Someone opening this for the
 * first time should not have to know what BullMQ calls things, and a legend
 * off to one side is a thing nobody reads. One quiet line under the name
 * states the fact and then stays out of the way.
 */
export interface QueueStateSpec {
  /** The key BullMQ holds this state in, and what the backend is asked for. */
  id: string;
  label: string;
  blurb: string;
  x: number;
  y: number;
  /**
   * Whether the node is drawn when nothing is in it.
   *
   * `prioritized` and `waiting-children` only exist for applications that use
   * priorities or flows. Drawing them empty on every other queue is three
   * boxes of noise in the surface that is supposed to be scannable.
   */
  always: boolean;
}

/**
 * `added` is a source, not a state: nothing is ever "in" it. It is here so the
 * diagram can show work arriving, which is half of what someone opens a queue
 * monitor to find out — a queue where nothing goes in and a queue where
 * everything goes straight through look identical without it.
 */
export const QUEUE_STATES: QueueStateSpec[] = [
  {
    id: "added",
    label: "added",
    blurb: "arriving from your app",
    x: 0,
    y: 150,
    always: true,
  },
  {
    id: "delayed",
    label: "delayed",
    blurb: "scheduled for later",
    x: 250,
    y: 0,
    always: true,
  },
  {
    id: "waiting-children",
    label: "waiting on children",
    blurb: "held until its child jobs finish",
    x: 250,
    y: 300,
    always: false,
  },
  {
    id: "wait",
    label: "waiting",
    blurb: "queued, nothing has picked it up",
    x: 250,
    y: 150,
    always: true,
  },
  {
    id: "prioritized",
    label: "prioritized",
    blurb: "queued, jumps ahead of waiting",
    x: 500,
    y: 0,
    always: false,
  },
  {
    id: "active",
    label: "active",
    blurb: "a worker is running it now",
    x: 500,
    y: 150,
    always: true,
  },
  {
    id: "completed",
    label: "completed",
    blurb: "finished without throwing",
    x: 750,
    y: 60,
    always: true,
  },
  {
    id: "failed",
    label: "failed",
    blurb: "threw, and has no attempts left",
    x: 750,
    y: 240,
    always: true,
  },
];

/** The states a job can actually be sitting in, in sidebar order. */
export const COUNTED_STATES = QUEUE_STATES.filter((s) => s.id !== "added").map((s) => s.id);

/** The two a finished job can be retried out of. Nothing else has a set to
 *  move out of, so nothing else offers the action. */
export const RETRYABLE_STATES = ["failed", "completed"];

export interface QueueEdgeSpec {
  id: string;
  source: string;
  target: string;
  /**
   * Drawn below the nodes rather than between them.
   *
   * The two retry edges, which run right to left against every other edge on
   * the canvas. Routed through the bottom handles so they read as loops
   * returning work rather than as lines crossing the middle of the diagram.
   */
  feedback?: boolean;
}

export const QUEUE_EDGES: QueueEdgeSpec[] = [
  { id: "added->wait", source: "added", target: "wait" },
  { id: "delayed->wait", source: "delayed", target: "wait" },
  { id: "waiting-children->wait", source: "waiting-children", target: "wait" },
  { id: "wait->active", source: "wait", target: "active" },
  { id: "prioritized->active", source: "prioritized", target: "active" },
  { id: "active->completed", source: "active", target: "completed" },
  { id: "active->failed", source: "active", target: "failed" },
  { id: "failed->wait", source: "failed", target: "wait", feedback: true },
  // Retrying a completed job is a re-run, and it is a different edge from a
  // retry of a failure. Folding the two together would light the failure loop
  // when nothing failed — and this app offers the operation, so it has to draw
  // where the work actually went.
  { id: "completed->wait", source: "completed", target: "wait", feedback: true },
];

/**
 * Which edge an event off the stream is evidence of.
 *
 * BullMQ names the event after the state the job *arrived* in and carries the
 * one it left in as `prev`, so the pair is the edge. Where `prev` is absent the
 * job came from outside the diagram, which is what `added->wait` is.
 *
 * Returning null rather than guessing is deliberate: `progress`, `stalled`,
 * `removed` and `duplicated` are real events that are not transitions, and
 * folding them into the nearest edge would inflate a rate the beam is supposed
 * to be a measurement of.
 */
export function edgeForEvent(event: string, prev: string | undefined): string | null {
  switch (event) {
    case "added":
      return "added->wait";
    case "waiting":
      // A retry is the one that matters most, and it is only distinguishable
      // by `prev`. Without it a retried job looks like a newly added one.
      if (prev === "failed") return "failed->wait";
      if (prev === "completed") return "completed->wait";
      if (prev === "delayed") return "delayed->wait";
      if (prev === "waiting-children") return "waiting-children->wait";
      // `waiting` with no `prev` follows the `added` event for the same job.
      // Counting both would double the intake rate.
      return null;
    case "active":
      return prev === "prioritized" ? "prioritized->active" : "wait->active";
    case "completed":
      return "active->completed";
    case "failed":
      return "active->failed";
    default:
      return null;
  }
}

/**
 * The columns a job page draws, in order.
 *
 * The scannable facts first and narrow, the payload last and wide — the same
 * order and for the same reason as `KEY_COLUMNS`. `state` is not a column: the
 * whole page is one state, and repeating it down every row would be a column
 * that never changes.
 */
export const JOB_COLUMNS: ColumnMeta[] = [
  { name: "id", typeName: "job id", typeClass: "text" },
  { name: "name", typeName: "job name", typeClass: "bool" },
  { name: "attempts", typeName: "made/allowed", typeClass: "number" },
  { name: "progress", typeName: "as reported", typeClass: "number" },
  { name: "created", typeName: "timestamp", typeClass: "temporal" },
  { name: "took", typeName: "duration", typeClass: "number" },
  // `json` so the row panel offers its tree. A payload that is not JSON parses
  // as nothing and falls back to text, which is correct.
  { name: "data", typeName: "payload", typeClass: "json" },
  { name: "reason", typeName: "failedReason", typeClass: "text" },
  { name: "returned", typeName: "returnvalue", typeClass: "json" },
];

/** Column positions, named once so nothing indexes this grid by number. */
export const JOB_COL = {
  id: 0,
  name: 1,
  attempts: 2,
  progress: 3,
  created: 4,
  took: 5,
  data: 6,
  reason: 7,
  returned: 8,
} as const;
