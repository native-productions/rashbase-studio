import { useCallback, useRef, useState } from "react";
import { SqlEditor } from "@/components/editor/SqlEditor";
import { focusErrorPosition } from "@/lib/activeEditor";
import { ResultGrid } from "@/components/grid/ResultGrid";
import { Spinner } from "@/components/ui/Spinner";
import { RowPanel } from "@/components/grid/RowPanel";
import { FilterBar } from "@/components/table/FilterBar";
import { TableFooter } from "@/components/table/TableFooter";
import { QueryFooter } from "@/components/query/QueryFooter";
import { StructureView } from "@/components/table/StructureView";
import { ErdView } from "@/components/erd/ErdView";
import { QueueView } from "@/components/queue/QueueView";
import { DefinitionView } from "@/components/table/DefinitionView";
import { hasRows } from "@/lib/utils/tabs";
import { useApp } from "@/store/app";
import type { QueryTab } from "@/lib/types";

const MIN_PANE = 80;

/**
 * One tab, drawn whole: editor, rows, and the footer that describes them.
 *
 * A component rather than markup inside `App` because a split is two of these
 * side by side. Everything it holds is about the one tab it was handed — the
 * editor's height included, which is why that is local state: two panes with
 * one shared height would move the splitter the user is not touching.
 */
export function TabPane({ tab, focused }: { tab: QueryTab; focused: boolean }) {
  const rowPanel = useApp((s) => s.rowPanel);
  const setActiveResult = useApp((s) => s.setActiveResult);
  const toggleSort = useApp((s) => s.toggleSort);

  const [editorH, setEditorH] = useState(200);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  const onSplitMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    const host = hostRef.current;
    if (!d || !host) return;
    const max = host.clientHeight - MIN_PANE;
    setEditorH(Math.min(max, Math.max(MIN_PANE, d.startH + (e.clientY - d.startY))));
  }, []);

  const onSplitUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onSplitMove);
    window.removeEventListener("pointerup", onSplitUp);
  }, [onSplitMove]);

  const onSplitDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startH: editorH };
      window.addEventListener("pointermove", onSplitMove);
      window.addEventListener("pointerup", onSplitUp);
    },
    [editorH, onSplitMove, onSplitUp],
  );

  const result = tab.results[tab.activeResultIndex];

  return (
    <div ref={hostRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Table tabs are a view of rows, not a script. The SQL still exists on
          the tab so ⌘R re-runs it; there is just nothing to edit, so no editor
          and no splitter. */}
      {!tab.object && (
        <>
          <div style={{ height: editorH }} className="shrink-0 overflow-hidden">
            <SqlEditor tabId={tab.id} value={tab.sql} />
          </div>

          <div
            onPointerDown={onSplitDown}
            className="group relative h-px shrink-0 cursor-row-resize bg-line-soft"
          >
            <div className="absolute -top-1 h-2 w-full group-hover:bg-accent/30" />
          </div>
        </>
      )}

      {tab.error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-danger/30 bg-danger/10 px-3 py-2 text-[12px]">
          <span className="mt-px shrink-0 font-mono text-[11px] text-danger">
            {tab.error.code ?? "ERR"}
          </span>
          <div className="min-w-0">
            <p className="text-ink">{tab.error.message}</p>
            {tab.error.hint && <p className="mt-0.5 text-[11px] text-ink-muted">{tab.error.hint}</p>}
          </div>
          {tab.error.position != null && (
            <button
              onClick={() => focusErrorPosition(tab.error!.position!)}
              className="ml-auto shrink-0 text-[11px] text-accent hover:underline"
            >
              Jump to position {tab.error.position}
            </button>
          )}
        </div>
      )}

      {tab.results.length > 1 && (
        <div className="flex shrink-0 gap-px border-b border-line-soft bg-raised px-2">
          {tab.results.map((r, i) => (
            <button
              key={i}
              onClick={() => setActiveResult(tab.id, i)}
              className={[
                "px-2.5 py-1 text-[11px]",
                i === tab.activeResultIndex
                  ? "border-b-2 border-accent text-ink"
                  : "border-b-2 border-transparent text-ink-faint hover:text-ink-muted",
              ].join(" ")}
            >
              Result {i + 1}
              <span className="ml-1.5 text-ink-faint">{r.rows.length.toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}

      {/* Filtering is the same shape as sorting: it belongs to the rows, so it
          appears exactly where the rows are. */}
      {tab.object && tab.view === "data" && hasRows(tab.object) && <FilterBar tab={tab} />}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {tab.object?.kind === "diagram" ? (
            <ErdView tab={tab} />
          ) : tab.object?.kind === "queue" ? (
            <QueueView tab={tab} />
          ) : tab.object && tab.view === "structure" ? (
            <StructureView tab={tab} />
          ) : tab.object && tab.view === "definition" ? (
            <DefinitionView tab={tab} />
          ) : result ? (
            <ResultGrid
              tabId={tab.id}
              result={result}
              sort={tab.sort}
              // Only table tabs can sort. A query tab runs whatever SQL the
              // user wrote, so sorting the fetched page would claim an ordering
              // the rest of the result does not have.
              onSort={tab.object ? (column) => toggleSort(tab.id, column) : undefined}
            />
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-[12px] text-ink-faint">
              {tab.running ? (
                <>
                  <Spinner size={11} className="text-accent" label="Running" />
                  Running…
                </>
              ) : tab.object ? (
                "No rows"
              ) : (
                "⌘⏎ to run"
              )}
            </div>
          )}
        </div>

        {/* Only alongside rows. There is no row to show next to a structure
            listing or a view definition. */}
        {/* A queue draws its own row detail: a job's history is what you open
            one for, and the field list the row panel shows is already the
            grid's own columns. */}
        {/* And only in the pane being worked in. `rowPanel` is one switch for
            the window, so a split would otherwise answer it twice — once with
            the row, and once with "no row selected" in the half nobody
            clicked. */}
        {rowPanel && focused && result && tab.object?.kind !== "queue" &&
          (!tab.object || tab.view === "data") && <RowPanel tab={tab} />}
      </div>

      {/* A queue has one view and pages its jobs from the header over the grid,
          so the footer would be a single button labelled "Data" and nothing
          else. */}
      {tab.object?.kind === "queue" ? null : tab.object ? (
        <TableFooter tab={tab} />
      ) : (
        <QueryFooter tab={tab} />
      )}
    </div>
  );
}
