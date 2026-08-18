import { Pager } from "@/components/table/Pager";
import { VIEW_LABEL } from "@/lib/constants/ui";
import { hasRows, viewsFor } from "@/lib/utils/tabs";
import type { QueryTab } from "@/lib/types";
import { useApp } from "@/store/app";

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
  const showsPager = tab.view === "data" && hasRows(tab.object);

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

      {showsPager && (
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
