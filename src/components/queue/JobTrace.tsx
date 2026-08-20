import { formatDuration, jobTimeline } from "@/lib/utils/bullmq";
import type { JobEntry, QueueEvent } from "@/lib/types";

/**
 * One job's history, as it happened.
 *
 * The answer to "what happened to this job", which is the question a queue
 * monitor exists for and the one a table of rows cannot answer: a row shows the
 * state a job is in now, and the interesting jobs are the ones that have been
 * in several.
 *
 * Two kinds of step, drawn differently on purpose. A filled marker is a
 * transition the event stream witnessed. A hollow one is something observed
 * along the way — a progress report — which is not a move between states and
 * must not read as one. And when the stream has been trimmed past this job
 * entirely, the panel says so rather than showing three steps that look like
 * the whole story.
 */

const TRANSITIONS = new Set(["added", "waiting", "active", "completed", "failed", "delayed"]);

export function JobTrace({
  job,
  events,
  onClose,
}: {
  job: JobEntry;
  events: QueueEvent[];
  onClose: () => void;
}) {
  const steps = jobTimeline(job, events);
  const inferred = steps.length > 0 && steps.every((s) => s.source === "job");
  const start = steps[0]?.at ?? 0;

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-raised">
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-line-soft px-2.5">
        <span className="eyebrow">Trace</span>
        <span className="truncate font-mono text-[11px] text-ink-muted">{job.id}</span>
        <button
          onClick={onClose}
          aria-label="Close trace"
          className="ml-auto rounded px-1 text-ink-faint hover:bg-hover hover:text-ink"
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-2.5 py-2">
        {steps.length === 0 ? (
          <p className="text-[11px] text-ink-faint">
            Nothing recorded. The event stream has been trimmed past this job and its hash carries
            no timestamps.
          </p>
        ) : (
          <>
            {inferred && (
              // Stated, not hidden. Three steps read as a complete history, and
              // this is the difference between "these are the transitions" and
              // "these are the three the job itself remembers".
              <p className="mb-2 border-b border-line-soft pb-2 text-[10px] text-ink-faint">
                The event stream no longer reaches this job. These times are from its own
                timestamps, so anything between them is not recorded.
              </p>
            )}

            <ol className="relative">
              {steps.map((step, i) => {
                const transition = TRANSITIONS.has(step.event);
                const failed = step.event === "failed";
                const since = i === 0 ? null : step.at - (steps[i - 1]?.at ?? step.at);

                return (
                  <li key={`${step.at}-${step.event}-${i}`} className="flex gap-2 pb-2 last:pb-0">
                    <div className="flex shrink-0 flex-col items-center">
                      <span
                        aria-hidden="true"
                        className={[
                          "mt-1 h-[7px] w-[7px] shrink-0 rounded-full border",
                          failed
                            ? "border-danger bg-danger"
                            : transition
                              ? "border-ink-muted bg-ink-muted"
                              : "border-ink-faint bg-transparent",
                        ].join(" ")}
                      />
                      {i < steps.length - 1 && (
                        <span aria-hidden="true" className="w-px flex-1 bg-line" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span
                          className={[
                            "text-[11px]",
                            failed ? "text-danger" : "text-ink",
                          ].join(" ")}
                        >
                          {step.event}
                        </span>
                        {step.prev && (
                          <span className="text-[10px] text-ink-faint">from {step.prev}</span>
                        )}
                        {since !== null && (
                          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">
                            +{formatDuration(since)}
                          </span>
                        )}
                      </div>

                      {step.detail && (
                        <div className="truncate font-mono text-[10px] text-ink-muted">
                          {step.detail}
                        </div>
                      )}

                      <div className="font-mono text-[10px] tabular-nums text-ink-faint">
                        {new Date(step.at).toLocaleTimeString(undefined, { hour12: false })}
                        {i === 0 && steps.length > 1 && (
                          <span> · {formatDuration((steps[steps.length - 1]?.at ?? 0) - start)} total</span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>

            {job.fields.stacktrace && (
              <details className="mt-2 border-t border-line-soft pt-2">
                <summary className="cursor-default text-[10px] text-ink-faint">stack trace</summary>
                <pre className="mt-1 overflow-auto font-mono text-[10px] whitespace-pre-wrap text-ink-muted select-text">
                  {formatStack(job.fields.stacktrace)}
                </pre>
              </details>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * BullMQ stores the stack trace as a JSON array of strings, one per attempt.
 *
 * Printed as the frames they are rather than as the JSON they arrived in. A
 * value that does not parse is shown exactly as stored: it is the server's own
 * words either way, and reformatting what we cannot read would be inventing a
 * shape for it.
 */
function formatStack(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.join("\n\n");
  } catch {
    /* Shown as stored. */
  }
  return raw;
}
