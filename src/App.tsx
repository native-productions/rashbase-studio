import { useCallback, useEffect, useRef, useState } from "react";
import { Titlebar } from "@/components/shell/Titlebar";
import { Sidebar } from "@/components/shell/Sidebar";
import { StatusBar } from "@/components/shell/StatusBar";
import { SqlEditor } from "@/components/editor/SqlEditor";
import { focusErrorPosition } from "@/lib/activeEditor";
import { ResultGrid } from "@/components/grid/ResultGrid";
import { CellModal } from "@/components/grid/CellModal";
import { Spinner } from "@/components/ui/Spinner";
import { RowPanel } from "@/components/grid/RowPanel";
import { FilterBar } from "@/components/table/FilterBar";
import { TableFooter } from "@/components/table/TableFooter";
import { QueryFooter } from "@/components/query/QueryFooter";
import { StructureView } from "@/components/table/StructureView";
import { DefinitionView } from "@/components/table/DefinitionView";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { ConnectionSheet } from "@/components/connection/ConnectionSheet";
import { Logo } from "@/components/Logo";
import { useHotkeys } from "@/lib/hotkeys";
import { hasRows } from "@/lib/utils/tabs";
import { savePinnedTabs } from "@/lib/pinnedTabs";
import { activeTab, useApp } from "@/store/app";

const MIN_PANE = 80;

function EmptyState() {
  const setSheet = useApp((s) => s.setSheet);
  const connections = useApp((s) => s.connections);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-8">
      <Logo size={44} className="text-accent" />
      <div className="text-center">
        <h1 className="text-[15px] font-semibold text-ink">Rashbase Studio</h1>
        <p className="mt-1 text-[12px] text-ink-muted">
          {connections.length === 0
            ? "Connect to a Postgres server to begin."
            : "Open a connection from the sidebar to begin."}
        </p>
      </div>
      {/* Connecting is the only thing to do from here. A "new query" button
          only ever produced a tab with nothing to run against. */}
      <button
        onClick={() => setSheet(true, null)}
        className="pressable rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-canvas"
      >
        New connection
      </button>
      <dl className="mt-2 grid grid-cols-[auto_auto] gap-x-4 gap-y-1 font-mono text-[11px] text-ink-faint">
        <dt>⌘K</dt><dd className="font-sans">Command palette</dd>
        <dt>⌘⇧N</dt><dd className="font-sans">New connection</dd>
        <dt>⌘⇧K</dt><dd className="font-sans">Switch database</dd>
        <dt>⌘B</dt><dd className="font-sans">Toggle sidebar</dd>
      </dl>
    </div>
  );
}

export default function App() {
  useHotkeys();

  const loadConnections = useApp((s) => s.loadConnections);
  const sidebarVisible = useApp((s) => s.sidebarVisible);
  const rowPanel = useApp((s) => s.rowPanel);
  const tab = useApp(activeTab);
  const setActiveResult = useApp((s) => s.setActiveResult);
  const toggleSort = useApp((s) => s.toggleSort);
  const toast = useApp((s) => s.toast);
  const setToast = useApp((s) => s.setToast);

  const [editorH, setEditorH] = useState(200);
  const splitRef = useRef<{ startY: number; startH: number } | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  // Pinning writes the pin immediately; this catches what the tab has become
  // since — the statement typed into a pinned query tab — without a storage
  // write on every keystroke.
  useEffect(() => {
    const save = () => savePinnedTabs(useApp.getState().tabs);
    window.addEventListener("beforeunload", save);
    return () => window.removeEventListener("beforeunload", save);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast, setToast]);

  const onSplitMove = useCallback((e: PointerEvent) => {
    const s = splitRef.current;
    const host = mainRef.current;
    if (!s || !host) return;
    const max = host.clientHeight - MIN_PANE;
    setEditorH(Math.min(max, Math.max(MIN_PANE, s.startH + (e.clientY - s.startY))));
  }, []);

  const onSplitUp = useCallback(() => {
    splitRef.current = null;
    window.removeEventListener("pointermove", onSplitMove);
    window.removeEventListener("pointerup", onSplitUp);
  }, [onSplitMove]);

  const onSplitDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      splitRef.current = { startY: e.clientY, startH: editorH };
      window.addEventListener("pointermove", onSplitMove);
      window.addEventListener("pointerup", onSplitUp);
    },
    [editorH, onSplitMove, onSplitUp],
  );

  const result = tab?.results[tab.activeResultIndex];

  return (
    <div className="flex h-full flex-col bg-base">
      <Titlebar />

      <div className="flex min-h-0 flex-1">
        {sidebarVisible && <Sidebar />}

        {/* `canvas`, not `base`: the chrome around this is translucent when
            window effects are on, and the grid is the one surface whose
            legibility may not depend on the desktop behind the window. */}
        <main ref={mainRef} className="flex min-w-0 flex-1 flex-col bg-canvas">
          {!tab ? (
            <EmptyState />
          ) : (
            <>
              {/* Table tabs are a view of rows, not a script. The SQL still
                  exists on the tab so ⌘R re-runs it; there is just nothing to
                  edit, so no editor and no splitter. */}
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
                    {tab.error.hint && (
                      <p className="mt-0.5 text-[11px] text-ink-muted">{tab.error.hint}</p>
                    )}
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

              {/* Filtering is the same shape as sorting: it belongs to the
                  rows, so it appears exactly where the rows are. */}
              {tab.object && tab.view === "data" && hasRows(tab.object) && (
                <FilterBar tab={tab} />
              )}

              <div className="flex min-h-0 flex-1">
                <div className="min-w-0 flex-1">
                  {tab.object && tab.view === "structure" ? (
                    <StructureView tab={tab} />
                  ) : tab.object && tab.view === "definition" ? (
                    <DefinitionView tab={tab} />
                  ) : result ? (
                    <ResultGrid
                      tabId={tab.id}
                      result={result}
                      sort={tab.sort}
                      // Only table tabs can sort. A query tab runs whatever SQL
                      // the user wrote, so sorting the fetched page would claim
                      // an ordering the rest of the result does not have.
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

                {/* Only alongside rows. There is no row to show next to a
                    structure listing or a view definition. */}
                {rowPanel && result && (!tab.object || tab.view === "data") && (
                  <RowPanel tab={tab} />
                )}
              </div>

              {tab.object ? <TableFooter tab={tab} /> : <QueryFooter tab={tab} />}
            </>
          )}
        </main>
      </div>

      <StatusBar />
      <CommandPalette />
      <CellModal />
      <ConnectionSheet />

      {toast && (
        <div className="fixed right-4 bottom-9 max-w-96 rounded-md border border-line bg-overlay px-3 py-2 text-[12px] text-ink shadow-lg shadow-black/40">
          <span className={toast.kind === "error" ? "text-danger" : "text-accent"}>
            {toast.kind === "error" ? "Error" : "Note"}
          </span>
          <p className="mt-0.5 text-ink-muted">{toast.text}</p>
        </div>
      )}
    </div>
  );
}
