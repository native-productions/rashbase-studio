import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { useApp } from "@/store/app";

const appWindow = getCurrentWindow();

/**
 * macOS `titleBarStyle: "Overlay"` keeps the native traffic lights and hands us
 * the rest of the bar. `pl-traffic` reserves the space they occupy.
 */
export function Titlebar() {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const open = useApp((s) => s.open);
  const connections = useApp((s) => s.connections);
  const setActiveTab = useApp((s) => s.setActiveTab);
  const closeTab = useApp((s) => s.closeTab);
  const closeOtherTabs = useApp((s) => s.closeOtherTabs);
  const togglePinTab = useApp((s) => s.togglePinTab);
  const openTab = useApp((s) => s.openTab);

  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const menuTab = menu ? tabs.find((t) => t.id === menu.tabId) : undefined;

  function choose(id: string) {
    const tabId = menu?.tabId;
    setMenu(null);
    if (!tabId) return;
    if (id === "close") closeTab(tabId);
    if (id === "close.others") closeOtherTabs(tabId);
    if (id === "pin") togglePinTab(tabId);
  }

  return (
    <header
      data-tauri-drag-region
      onDoubleClick={() => void appWindow.toggleMaximize()}
      className="flex h-11 shrink-0 items-stretch gap-1 border-b border-line-soft bg-raised pl-traffic pr-2"
    >
      {/* The strip itself is the drag surface. Tauri only starts a drag when
          the attribute is on the event target, so the tabs and the new-tab
          button stay clickable while the empty space beside them moves the
          window, which is how every other titlebar on the platform behaves. */}
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-end gap-px overflow-x-auto pl-1"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const conn = connections.find((c) => c.id === tab.connectionId);
          // A table tab is named for its table; a query tab borrows the
          // connection name, which is the only thing distinguishing it.
          const title = tab.object?.name ?? conn?.name ?? tab.title;
          return (
            <div
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
              }}
              className={[
                "group flex h-8 max-w-52 min-w-32 shrink-0 cursor-default items-center gap-2 rounded-t-md border-t border-r border-l px-3 text-[12px]",
                active
                  ? "border-line-soft bg-base text-ink"
                  : "border-transparent text-ink-faint hover:text-ink-muted",
              ].join(" ")}
            >
              {/* No connection dot here. The status bar already states which
                  server the active tab is on, and a lit dot on every tab was
                  just a row of yellow specks in the corner of the eye. */}
              {tab.pinned && (
                <span
                  aria-label="Pinned"
                  title="Pinned"
                  className="shrink-0 text-[9px] text-accent"
                >
                  ◆
                </span>
              )}
              <span className="truncate">{title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                aria-label={`Close ${title}`}
                className="-mr-1 ml-auto shrink-0 rounded p-0.5 text-ink-faint opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path
                    d="M1 1l8 8M9 1l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          );
        })}

        {/* Hidden until something is connected: a query tab with no server
            behind it is a dead end during onboarding. */}
        <button
          onClick={() => openTab()}
          aria-label="New query tab"
          title="New query tab  ⌘T"
          hidden={Object.keys(open).length === 0}
          className="pressable mb-0.5 ml-1 flex size-7 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-hover hover:text-ink"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M6 1v10M1 6h10"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {menu && menuTab && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { kind: "item", id: "close", label: "Close tab", hint: "⌘W" },
            // Absent rather than disabled when there is nothing else to close:
            // a permanently greyed row is noise on a three-item menu.
            ...(tabs.some((t) => t.id !== menuTab.id && !t.pinned)
              ? ([{ kind: "item", id: "close.others", label: "Close other tabs" }] as const)
              : []),
            { kind: "separator" },
            { kind: "item", id: "pin", label: menuTab.pinned ? "Unpin tab" : "Pin tab" },
          ]}
          onSelect={choose}
          onClose={() => setMenu(null)}
        />
      )}
    </header>
  );
}
