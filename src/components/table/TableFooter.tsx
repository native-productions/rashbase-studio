import { Pager } from "@/components/table/Pager";
import { PageSizeMenu } from "@/components/table/PageSizeMenu";
import { VIEW_LABEL } from "@/lib/constants/ui";
import { hasRows, isKeyspace, viewsFor } from "@/lib/utils/tabs";
import type { QueryTab } from "@/lib/types";
import { useApp } from "@/store/app";

/**
 * The keyspace footer.
 *
 * Not the ordinary pager, because a cursor walk has no offsets: there is no
 * "row 400 of 38,000" to show, only how far the walk has gone and whether it
 * has come round. What it shows instead is what the page actually cost —
 * a value filter is answered by reading, so a page of 12 keys can be a walk of
 * 50,000, and a footer that only said "12 keys" would be claiming a
 * completeness the scan never had.
 */
function KeyspaceFooter({ tab }: { tab: QueryTab }) {
  const goKeyPage = useApp((s) => s.goKeyPage);
  const setPageLimit = useApp((s) => s.setPageLimit);

  const rows = tab.results[tab.activeResultIndex]?.rows.length ?? 0;
  const scanned = tab.scan?.scanned ?? 0;
  const exhausted = tab.scan?.exhausted ?? false;
  const atStart = tab.cursors.length <= 1;
  // The walk read more than it kept, which only happens under a value filter.
  // Worth saying, because it is the difference between "12 keys exist" and
  // "12 of the 50,000 I looked at matched".
  const filtered = scanned > rows;

  return (
    <>
      <div className="mx-auto flex items-center gap-1">
        <button
          onClick={() => void goKeyPage(tab.id, -1)}
          disabled={atStart || tab.running}
          aria-label="Previous page"
          title="Previous page"
          className="rounded px-1.5 py-0.5 text-ink-faint hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-30"
        >
          ‹
        </button>
        <PageSizeMenu limit={tab.page.limit} onChange={(n) => setPageLimit(tab.id, n)} />
        <button
          onClick={() => void goKeyPage(tab.id, 1)}
          disabled={exhausted || tab.running}
          aria-label="Next page"
          // The walk is what ends, not the list: saying so beats a dead button
          // that looks like the app stopped working.
          title={exhausted ? "The scan has come full circle" : "Next page"}
          className="rounded px-1.5 py-0.5 text-ink-faint hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-30"
        >
          ›
        </button>
      </div>

      <div
        className={[
          "shrink-0 font-mono tabular-nums",
          tab.running ? "text-ink-faint/50" : "text-ink-faint",
        ].join(" ")}
      >
        <span className="text-ink-muted">{rows.toLocaleString()}</span> keys
        {filtered && (
          <span title="A value filter is answered by reading, so this page cost a walk of this many keys.">
            {" "}
            · scanned {scanned.toLocaleString()}
          </span>
        )}
        {tab.rowCount && (
          // Exact, from DBSIZE. No tilde, because nothing here was estimated.
          <span> · {tab.rowCount.value.toLocaleString()} in db</span>
        )}
      </div>
    </>
  );
}

/**
 * The bar under a table tab: which view you are in, where you are in the rows,
 * and how many there are.
 *
 * No motion anywhere in here. Switching views is something a person does dozens
 * of times in a sitting, and an entrance transition reads as the app being slow.
 */
export function TableFooter({ tab }: { tab: QueryTab }) {
  const goPage = useApp((s) => s.goPage);
  const setPageLimit = useApp((s) => s.setPageLimit);
  const setTabView = useApp((s) => s.setTabView);
  const countExactRows = useApp((s) => s.countExactRows);

  const { limit, offset } = tab.page;
  const rows = tab.results[tab.activeResultIndex]?.rows.length ?? 0;
  // The pager belongs to the rows, so it is absent anywhere the rows are not.
  const showsPager = tab.view === "data" && hasRows(tab.object) && !isKeyspace(tab.object);

  const first = rows === 0 ? 0 : offset + 1;
  const last = offset + rows;

  return (
    <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-line-soft bg-raised px-2 text-[11px]">
      <div className="flex shrink-0 gap-px">
        {viewsFor(tab.object).map((v) => (
          <button
            key={v}
            onClick={() => void setTabView(tab.id, v)}
            className={[
              "rounded px-2 py-0.5",
              tab.view === v ? "bg-hover text-ink" : "text-ink-faint hover:text-ink-muted",
            ].join(" ")}
          >
            {VIEW_LABEL[v]}
          </button>
        ))}
      </div>

      {tab.view === "data" && isKeyspace(tab.object) && <KeyspaceFooter tab={tab} />}

      {showsPager && !isKeyspace(tab.object) && (
        <>
          <div className="mx-auto">
            <Pager
              limit={limit}
              offset={offset}
              rows={rows}
              running={tab.running}
              onPage={(d) => goPage(tab.id, d)}
              onLimit={(n) => setPageLimit(tab.id, n)}
            />
          </div>

          <div
            className={[
              "shrink-0 font-mono tabular-nums",
              tab.running ? "text-ink-faint/50" : "text-ink-faint",
            ].join(" ")}
          >
            {first.toLocaleString()}–{last.toLocaleString()} of{" "}
            {tab.rowCount === null ? (
              // A filtered page has no estimate: the planner's statistics
              // describe the whole table. Counting is the only honest answer,
              // and it is the user's to ask for.
              tab.filters.length > 0 ? (
                <button
                  onClick={() => void countExactRows(tab.id)}
                  title="No estimate exists for a filtered set. Click to count exactly."
                  className="text-ink-faint underline decoration-dotted underline-offset-2 hover:text-ink-muted"
                >
                  count
                </button>
              ) : (
                "…"
              )
            ) : tab.rowCount.exact ? (
              <span className="text-ink-muted">{tab.rowCount.value.toLocaleString()}</span>
            ) : (
              // The tilde is the whole point: this number came from the
              // planner's statistics, not from counting.
              <button
                onClick={() => void countExactRows(tab.id)}
                title="Estimated from table statistics. Click to count exactly."
                className="text-ink-faint underline decoration-dotted underline-offset-2 hover:text-ink-muted"
              >
                ~{tab.rowCount.value.toLocaleString()}
              </button>
            )}
          </div>
        </>
      )}
    </footer>
  );
}
