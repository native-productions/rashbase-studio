import { ResultGrid } from "@/components/grid/ResultGrid";
import { JobTrace } from "@/components/queue/JobTrace";
import { Spinner } from "@/components/ui/Spinner";
import { RETRYABLE_STATES } from "@/lib/constants/bullmq";
import { changedSince, stateLabel } from "@/lib/utils/bullmq";
import type { QueryTab } from "@/lib/types";
import { busyKey, useApp } from "@/store/app";

/**
 * The jobs of whichever state is open, in the grid the rest of the app uses.
 *
 * Under the diagram rather than beside it: a job row is nine columns wide and a
 * side panel is not, and a second narrower table built for this surface alone
 * would be one more grid to keep in step with the first. `jobsToResult` turns
 * the page into the same `QueryResult` a table produces, so the virtualizer,
 * the cell selection, the JSON tree and the row panel all work here without
 * knowing BullMQ exists.
 */
export function QueueJobs({ tab }: { tab: QueryTab }) {
  const queue = tab.queue!;
  const state = queue.state!;
  const result = tab.results[tab.activeResultIndex] ?? null;
  const selectQueueState = useApp((s) => s.selectQueueState);
  const clearStaged = useApp((s) => s.clearStaged);
  const goJobPage = useApp((s) => s.goJobPage);
  const refreshQueue = useApp((s) => s.refreshQueue);
  const refreshing = useApp((s) => !!s.busy[busyKey.queue(tab.id)]);

  const retryable = RETRYABLE_STATES.includes(state);
  /**
   * How much has moved through this state since the page was read.
   *
   * Counted off the event stream, not by subtracting the live count from the
   * page's own total: three jobs failing while three others are retried leaves
   * the count identical and the page entirely out of date.
   *
   * Shown, never acted on. Pulling rows out from under a selection while
   * someone is staging a retry is the one thing this surface must not do, so
   * the page stays put and says it is behind.
   */
  const behind = changedSince(queue.events, state, queue.readAtEventId);
  const selected = tab.selection?.row ?? null;
  const job = selected === null ? null : (queue.jobs[selected] ?? null);

  return (
    <div className="flex min-h-0 flex-col border-t border-line">
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-line-soft bg-raised px-2.5 text-[11px]">
        <span className="text-ink">{stateLabel(state)}</span>
        <span className="font-mono tabular-nums text-ink-faint">
          {queue.jobs.length === 0
            ? "0"
            : `${(tab.page.offset + 1).toLocaleString()}–${(
                tab.page.offset + queue.jobs.length
              ).toLocaleString()}`}{" "}
          of {queue.total.toLocaleString()}
        </span>
        {/* Which end of the queue is on screen. `wait` is popped from its tail,
            so its page is not in list order, and a footer that said nothing
            would leave the reader to assume the wrong one. */}
        <span className="text-ink-faint">
          {queue.order === "next-first" ? "next to run first" : "most recent first"}
        </span>

        {/* Offset paging, unlike the keyspace: a list and a sorted set both
            take an index range, so there is a real "of" to count against. */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => void goJobPage(tab.id, -1)}
            disabled={tab.page.offset === 0 || tab.running}
            aria-label="Previous page"
            className="rounded px-1.5 text-ink-faint hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-30"
          >
            ‹
          </button>
          <button
            onClick={() => void goJobPage(tab.id, 1)}
            disabled={tab.page.offset + queue.jobs.length >= queue.total || tab.running}
            aria-label="Next page"
            className="rounded px-1.5 text-ink-faint hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-30"
          >
            ›
          </button>
        </div>

        <button
          onClick={() => void refreshQueue(tab.id)}
          disabled={refreshing}
          title="Read this page again  ⌘R"
          aria-label="Refresh jobs"
          className="flex shrink-0 items-center gap-1 rounded px-1 text-ink-faint hover:bg-hover hover:text-ink disabled:pointer-events-none"
        >
          {refreshing ? (
            <Spinner size={9} className="text-accent" label="Refreshing" />
          ) : (
            <span aria-hidden="true">⟳</span>
          )}
          {behind > 0 && (
            // Stated as the count it is, with no claim about which jobs: the
            // stream says how many crossed this state, not which rows on
            // screen are now wrong.
            <span className="tabular-nums">
              {behind} {behind === 1 ? "job" : "jobs"} moved since this was read
            </span>
          )}
        </button>

        {retryable && (
          <span className="ml-auto shrink-0 text-ink-faint">
            <span className="font-mono text-ink-muted">R</span> stage retry
          </span>
        )}

        <button
          onClick={() => {
            clearStaged(tab.id);
            void selectQueueState(tab.id, null);
          }}
          aria-label="Close jobs"
          className={[
            "shrink-0 rounded px-1 text-ink-faint hover:bg-hover hover:text-ink",
            retryable ? "" : "ml-auto",
          ].join(" ")}
        >
          ✕
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {result && result.rows.length > 0 ? (
            <ResultGrid tabId={tab.id} result={result} />
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-[12px] text-ink-faint">
              {tab.running ? (
                <>
                  <Spinner size={11} className="text-accent" label="Reading jobs" />
                  Reading jobs…
                </>
              ) : (
                `Nothing is ${stateLabel(state)}.`
              )}
            </div>
          )}
        </div>

        {job && (
          <JobTrace
            job={job}
            events={queue.events}
            onClose={() => useApp.getState().setSelection(tab.id, null)}
          />
        )}
      </div>
    </div>
  );
}
