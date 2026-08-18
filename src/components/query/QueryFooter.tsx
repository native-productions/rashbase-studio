import { Pager } from "@/components/table/Pager";
import { PageSizeMenu } from "@/components/table/PageSizeMenu";
import type { QueryTab } from "@/lib/types";
import { useApp } from "@/store/app";

/**
 * The bar under a query tab: how much of the answer you are looking at.
 *
 * A query tab has two shapes, and the difference is worth showing rather than
 * hiding, because it changes what the numbers on screen mean.
 *
 * When the statement could be wrapped, this is a pager and works exactly like a
 * table tab's. When it could not — a script, a write, a statement that limits
 * itself — there is no page to move to, so the bar reports the cap instead and
 * says why, using the row count the server itself reported.
 */
export function QueryFooter({ tab }: { tab: QueryTab }) {
  const goPage = useApp((s) => s.goPage);
  const setPageLimit = useApp((s) => s.setPageLimit);

  const { limit, offset } = tab.page;
  const result = tab.results[tab.activeResultIndex];
  if (!result) return null;

  const rows = result.rows.length;
  const dim = tab.running ? "text-ink-faint/50" : "text-ink-faint";

  if (tab.paged) {
    const first = rows === 0 ? 0 : offset + 1;
    return (
      <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-line-soft bg-raised px-2 text-[11px]">
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
        {/* No total: counting an arbitrary query costs a second full scan, and
            the pager does not need one to work. */}
        <div className={`shrink-0 font-mono tabular-nums ${dim}`}>
          {first.toLocaleString()}–{(offset + rows).toLocaleString()}
        </div>
      </footer>
    );
  }

  return (
    <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-line-soft bg-raised px-2 text-[11px]">
      <div className={`min-w-0 truncate font-mono tabular-nums ${dim}`}>
        {result.truncated ? (
          <>
            <span className="text-warn">{rows.toLocaleString()}</span> of{" "}
            <span className="text-ink-muted">{result.rowsAffected.toLocaleString()}</span> rows
          </>
        ) : (
          <>{rows.toLocaleString()} rows</>
        )}
      </div>

      {/* The reason there is no pager. Without it, a statement that silently
          refuses to page looks like a missing feature rather than a decision. */}
      {tab.pageNote && (
        <span className="min-w-0 truncate text-ink-faint" title={tab.pageNote}>
          · not paged: {tab.pageNote}
        </span>
      )}

      <div className="ml-auto shrink-0">
        <PageSizeMenu limit={limit} onChange={(n) => setPageLimit(tab.id, n)} />
      </div>
    </footer>
  );
}
