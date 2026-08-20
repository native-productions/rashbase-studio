import { useCallback, useEffect, useRef, useState } from "react";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { useAnchoredPanel } from "@/components/ui/menu";
import { INPUT_COMPACT_CLS, MENU_ITEM, MENU_PANEL } from "@/lib/constants/ui";
import { defaultName, type SavedQuery } from "@/lib/savedQueries";
import type { QueryTab } from "@/lib/types";
import { useApp } from "@/store/app";

/**
 * The shelf of kept statements, between the editor and its results.
 *
 * Chips rather than a sidebar panel: a saved query is recognised by its first
 * few words, so the list wants to be one line the eye crosses on the way down
 * to the rows, not a column competing with the schema tree for the left edge.
 *
 * Five, then a door. Past five the row starts to scroll, and a horizontal
 * scroller is a place things get lost; the sixth chip opens the whole list
 * where it can be searched instead.
 */
const VISIBLE = 5;

export function SavedQueryBar({ tab, connectionId }: { tab: QueryTab; connectionId: string }) {
  const queries = useApp((s) => s.savedQueries);
  const renamingId = useApp((s) => s.renamingQueryId);
  const openSavedQuery = useApp((s) => s.openSavedQuery);
  const renameSavedQuery = useApp((s) => s.renameSavedQuery);
  const deleteSavedQuery = useApp((s) => s.deleteSavedQuery);
  const setRenamingQuery = useApp((s) => s.setRenamingQuery);

  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [listOpen, setListOpen] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const dismissList = useCallback(() => setListOpen(false), []);
  const flip = useAnchoredPanel({
    open: listOpen,
    onDismiss: dismissList,
    rootRef,
    anchorRef: moreRef,
    panelRef,
  });

  // Newest first: the chip you just made is where the hand already is.
  const mine = queries.filter((q) => q.connectionId === connectionId).reverse();
  if (mine.length === 0) return null;

  const shown = mine.slice(0, VISIBLE);
  const rest = mine.length - shown.length;

  return (
    <div
      ref={rootRef}
      className="relative flex h-7 shrink-0 items-center gap-1.5 border-b border-line-soft bg-raised px-2"
    >
      <span className="label-eyebrow shrink-0">Saved</span>

      {shown.map((query) => (
        <Chip
          key={query.id}
          query={query}
          loaded={query.id === tab.savedQueryId}
          edited={query.id === tab.savedQueryId && query.sql !== tab.sql}
          renaming={renamingId === query.id}
          onOpen={() => openSavedQuery(query.id)}
          onRename={(name) => renameSavedQuery(query.id, name)}
          onMenu={(x, y) => setMenu({ id: query.id, x, y })}
        />
      ))}

      {rest > 0 && (
        <button
          ref={moreRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={listOpen}
          onClick={() => setListOpen((o) => !o)}
          className={[
            "pressable shrink-0 rounded-full border px-2 py-0.5 text-[11px]",
            listOpen
              ? "border-line bg-hover text-ink"
              : "border-line-soft text-ink-faint hover:border-line hover:text-ink",
          ].join(" ")}
        >
          View all <span className="tabular-nums text-ink-faint">{mine.length}</span>
        </button>
      )}

      {listOpen && (
        <AllQueries
          panelRef={panelRef}
          flip={flip}
          queries={mine}
          currentId={tab.savedQueryId}
          onOpen={(id) => {
            setListOpen(false);
            openSavedQuery(id);
          }}
          onDelete={deleteSavedQuery}
          onRename={(id) => {
            setListOpen(false);
            setRenamingQuery(id);
          }}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={ITEMS}
          onClose={() => setMenu(null)}
          onSelect={(id) => {
            if (id === "rename") setRenamingQuery(menu.id);
            if (id === "delete") deleteSavedQuery(menu.id);
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

const ITEMS: ContextMenuItem[] = [
  { kind: "item", id: "rename", label: "Rename" },
  { kind: "separator" },
  { kind: "item", id: "delete", label: "Delete", danger: true },
];

/**
 * One saved statement.
 *
 * No accent on the loaded one. The yellow already means five things in this
 * app and "the chip whose SQL is in the editor" is not one of them, so it is
 * said with the same hover film every other selected row uses.
 */
function Chip({
  query,
  loaded,
  edited,
  renaming,
  onOpen,
  onRename,
  onMenu,
}: {
  query: SavedQuery;
  loaded: boolean;
  edited: boolean;
  renaming: boolean;
  onOpen: () => void;
  onRename: (name: string) => void;
  onMenu: (x: number, y: number) => void;
}) {
  if (renaming) return <NameField name={query.name} onCommit={onRename} />;

  return (
    <button
      type="button"
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      title={edited ? `${query.sql}\n\nEdited. ⌘S updates it.` : query.sql}
      className={[
        "pressable flex min-w-0 shrink items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
        loaded
          ? "border-line bg-hover text-ink"
          : "border-line-soft text-ink-muted hover:border-line hover:text-ink",
      ].join(" ")}
    >
      {/* The editor's statement no longer matches the saved one. A dot rather
          than a word: this appears and disappears while typing, and a label
          that resizes the chip under the pointer is a chip that moves away. */}
      {edited && <span aria-hidden className="size-1 shrink-0 rounded-full bg-ink-muted" />}
      <span className="min-w-0 max-w-40 truncate">{query.name}</span>
      {edited && <span className="sr-only">, edited</span>}
    </button>
  );
}

/**
 * The name field, opened by ⌘S and by Rename.
 *
 * The text arrives selected, so typing replaces the default and Enter alone
 * keeps it. Escape commits too rather than reverting: there is nothing to
 * revert to, the query is already saved, and the only question on screen is
 * what to call it.
 *
 * `data-hotkeys-off` because ⌘S while naming would otherwise save a second
 * copy of the statement being named.
 */
function NameField({ name, onCommit }: { name: string; onCommit: (name: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(name);

  useEffect(() => {
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      autoFocus
      data-hotkeys-off
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== "Escape") return;
        e.stopPropagation();
        onCommit(e.key === "Enter" ? draft : name);
      }}
      className={`${INPUT_COMPACT_CLS} h-5 w-40 shrink-0 rounded-full px-2 text-center`}
      aria-label="Query name"
    />
  );
}

/**
 * Every saved statement, with the SQL under each name.
 *
 * The filter appears only once the list is long enough to need one. Below that
 * it is a field asking to be typed into when reading the six rows underneath
 * is faster.
 */
function AllQueries({
  panelRef,
  flip,
  queries,
  currentId,
  onOpen,
  onRename,
  onDelete,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  flip: boolean;
  queries: SavedQuery[];
  currentId: string | null;
  onOpen: (id: string) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const matched = needle
    ? queries.filter(
        (q) => q.name.toLowerCase().includes(needle) || q.sql.toLowerCase().includes(needle),
      )
    : queries;

  return (
    <div
      ref={panelRef}
      role="menu"
      data-hotkeys-off
      className={[
        MENU_PANEL,
        "absolute right-2 z-20 max-h-72 w-80",
        flip ? "bottom-full mb-1.5" : "top-full mt-1.5",
      ].join(" ")}
    >
      {queries.length > 8 && (
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter"
          aria-label="Filter saved queries"
          className={`${INPUT_COMPACT_CLS} mb-1 font-sans`}
        />
      )}

      {matched.length === 0 && (
        <p className="px-1.5 py-2 text-[11px] text-ink-faint">Nothing matches “{filter}”.</p>
      )}

      {matched.map((query) => (
        <div
          key={query.id}
          className={[
            MENU_ITEM,
            "group items-start gap-2",
            query.id === currentId ? "bg-hover text-ink" : "text-ink-muted hover:bg-hover",
          ].join(" ")}
        >
          <button
            type="button"
            onClick={() => onOpen(query.id)}
            className="min-w-0 flex-1 text-left"
          >
            {/* A query nobody named is already showing its statement as its
                name, and printing that string twice at two widths reads as two
                different queries that happen to start the same way. */}
            {query.name === defaultName(query.sql) ? (
              <span className="block truncate font-mono text-[11px] text-ink">
                {query.sql.replace(/\s+/g, " ").trim()}
              </span>
            ) : (
              <>
                <span className="block truncate text-ink">{query.name}</span>
                <span className="block truncate font-mono text-[10px] text-ink-faint">
                  {query.sql.replace(/\s+/g, " ").trim()}
                </span>
              </>
            )}
          </button>

          {/* Only on the row under the pointer. Two glyphs on every row would
              make the list read as a table of controls rather than of
              statements. */}
          <span className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100">
            <button
              type="button"
              onClick={() => onRename(query.id)}
              aria-label={`Rename ${query.name}`}
              className="pressable rounded px-1 text-[10px] text-ink-faint hover:text-ink"
            >
              Rename
            </button>
            <button
              type="button"
              onClick={() => onDelete(query.id)}
              aria-label={`Delete ${query.name}`}
              className="pressable rounded px-1 text-[10px] text-ink-faint hover:text-danger"
            >
              Delete
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
