import { useCallback, useEffect, useRef, useState } from "react";
import { Titlebar } from "@/components/shell/Titlebar";
import { Sidebar } from "@/components/shell/Sidebar";
import { StatusBar } from "@/components/shell/StatusBar";
import { TabPane } from "@/components/shell/TabPane";
import { CellModal } from "@/components/grid/CellModal";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { ConnectionSheet } from "@/components/connection/ConnectionSheet";
import { ExportDialog } from "@/components/export/ExportDialog";
import { ErrorDialog } from "@/components/ui/ErrorDialog";
import { Logo } from "@/components/Logo";
import { useHotkeys } from "@/lib/hotkeys";
import { useAppMenu } from "@/lib/appMenu";
import { savePinnedTabs } from "@/lib/pinnedTabs";
import { useApp } from "@/store/app";

/**
 * How the width is shared between two panes, kept across launches.
 *
 * A fraction rather than pixels: a split the user set on a wide window should
 * stay the same split when the window is narrowed, not collapse one side.
 * `localStorage` for the same reason as the sidebar's width — window layout,
 * not data.
 */
const SPLIT_KEY = "rashbase.splitRatio.v1";
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

function clampRatio(r: number) {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

function loadRatio(): number {
  try {
    const r = Number(localStorage.getItem(SPLIT_KEY));
    if (Number.isFinite(r) && r > 0) return clampRatio(r);
  } catch {
    /* A disabled store costs the user the preference, nothing more. */
  }
  return 0.5;
}

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
  useAppMenu();

  const loadConnections = useApp((s) => s.loadConnections);
  const sidebarVisible = useApp((s) => s.sidebarVisible);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const splitTabId = useApp((s) => s.splitTabId);
  const focusedPane = useApp((s) => s.focusedPane);
  const focusPane = useApp((s) => s.focusPane);
  const toast = useApp((s) => s.toast);
  const setToast = useApp((s) => s.setToast);

  // Looked up rather than trusted: a tab can be closed out from under a pane by
  // dropping its object or deleting its connection, and a pane pointed at
  // nothing is one pane, not an empty half.
  const mainTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const splitTab = tabs.find((t) => t.id === splitTabId) ?? null;

  const [ratio, setRatio] = useState(loadRatio);
  const dragRef = useRef<{ startX: number; startRatio: number } | null>(null);
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

  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_KEY, String(ratio));
    } catch {
      /* Same: the split is still where the user put it for this session. */
    }
  }, [ratio]);

  const onSplitMove = useCallback((e: PointerEvent) => {
    const host = mainRef.current;
    if (!dragRef.current || !host) return;
    const box = host.getBoundingClientRect();
    if (box.width === 0) return;
    setRatio(clampRatio((e.clientX - box.left) / box.width));
  }, []);

  const onSplitUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onSplitMove);
    window.removeEventListener("pointerup", onSplitUp);
  }, [onSplitMove]);

  const onSplitDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startRatio: ratio };
      window.addEventListener("pointermove", onSplitMove);
      window.addEventListener("pointerup", onSplitUp);
    },
    [ratio, onSplitMove, onSplitUp],
  );

  /**
   * Which half the keyboard is talking to.
   *
   * Marked only while there are two of them: a lone pane is the focused pane by
   * definition, and a line across the top of it would say nothing.
   */
  const paneTone = (pane: "main" | "split") =>
    splitTab && focusedPane === pane ? "shadow-[inset_0_1px_0_var(--color-accent)]" : "";

  return (
    <div className="flex h-full flex-col bg-base">
      <Titlebar />

      <div className="flex min-h-0 flex-1">
        {sidebarVisible && <Sidebar />}

        {/* `canvas`, not `base`: the chrome around this is translucent when
            window effects are on, and the grid is the one surface whose
            legibility may not depend on the desktop behind the window. */}
        <main ref={mainRef} className="flex min-w-0 flex-1 bg-canvas">
          {!mainTab && !splitTab ? (
            // `flex-1`, because `main` is a row now: without it the empty state
            // is sized to its own content and sits against the sidebar instead
            // of in the middle of the window.
            <div className="min-w-0 flex-1">
              <EmptyState />
            </div>
          ) : (
            <>
              <div
                onPointerDownCapture={() => focusPane("main")}
                style={splitTab ? { width: `${ratio * 100}%` } : undefined}
                className={`flex min-w-0 flex-col ${splitTab ? "shrink-0" : "flex-1"} ${paneTone("main")}`}
              >
                {mainTab ? (
                  <TabPane tab={mainTab} focused={!splitTab || focusedPane === "main"} />
                ) : (
                  <EmptyState />
                )}
              </div>

              {splitTab && (
                <>
                  <div
                    onPointerDown={onSplitDown}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize split"
                    className="group relative w-px shrink-0 cursor-col-resize bg-line-soft"
                  >
                    <div className="absolute -left-1 h-full w-2 group-hover:bg-accent/30" />
                  </div>

                  <div
                    onPointerDownCapture={() => focusPane("split")}
                    className={`flex min-w-0 flex-1 flex-col ${paneTone("split")}`}
                  >
                    <TabPane tab={splitTab} focused={focusedPane === "split"} />
                  </div>
                </>
              )}
            </>
          )}
        </main>
      </div>

      <StatusBar />
      <CommandPalette />
      <CellModal />
      <ConnectionSheet />
      <ExportDialog />
      <ErrorDialog />

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
