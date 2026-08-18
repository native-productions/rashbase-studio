import { useEffect, useMemo, useRef } from "react";
import { FilterEditor } from "@/components/table/FilterEditor";
import { newFilter, newKeyFilter, summarizeFilter } from "@/lib/utils/filters";
import { isKeyspace } from "@/lib/utils/tabs";
import { KEY_FILTER_COLUMNS } from "@/lib/constants/filters";
import type { Filter, QueryTab } from "@/lib/types";
import { useApp } from "@/store/app";

/**
 * The filter row above the grid.
 *
 * Active conditions are chips rather than a count behind a button: what the
 * page is narrowed by is the one thing you need to know before reading a
 * filtered result, so it is never a click away.
 *
 * No motion on the chips. Filtering is something you do dozens of times in a
 * sitting, and an entrance transition on a repeated action reads as the app
 * being slow at the moment the user is watching most closely.
 */
function Funnel() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" className="shrink-0">
      <path
        d="M1.5 2h9L7 6.2V10L5 8.8V6.2L1.5 2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FilterBar({ tab }: { tab: QueryTab }) {
  const setFilters = useApp((s) => s.setFilters);
  const editor = useApp((s) => s.filterEditor);
  const setFilterEditor = useApp((s) => s.setFilterEditor);

  const anchorRef = useRef<HTMLDivElement>(null);

  // Leaving the tab or the view closes the editor. Doing it here covers tab
  // switching, view switching and closing the tab in one place.
  useEffect(() => () => setFilterEditor(null), [setFilterEditor]);

  /** `null` = editing a filter that is not on the bar yet, `undefined` = closed. */
  const openIndex = editor?.tabId === tab.id ? editor.index : undefined;

  const keyspace = isKeyspace(tab.object);

  // A fresh id per opening, so React remounts the editor with a clean draft.
  const draft = useMemo(
    () => (keyspace ? newKeyFilter() : newFilter()),
    [openIndex, tab.id, keyspace],
  );

  /**
   * What the editor offers to filter on.
   *
   * A keyspace has two, and neither is a grid column: the key, which the server
   * matches with a glob, and the value, which only a read can answer. Offering
   * `ttl` or `size` here would be three more conditions the store cannot push
   * anywhere.
   */
  const columns = keyspace
    ? KEY_FILTER_COLUMNS.map((c) => ({ name: c.value, typeName: c.label, typeClass: "text" as const }))
    : (tab.results[0]?.columns ?? []);
  const close = () => setFilterEditor(null);
  const open = (index: number | null) =>
    setFilterEditor(openIndex === index ? null : { tabId: tab.id, index });

  const replace = (index: number, f: Filter) => {
    setFilters(
      tab.id,
      tab.filters.map((existing, i) => (i === index ? f : existing)),
    );
    close();
  };

  const remove = (index: number) => {
    setFilters(
      tab.id,
      tab.filters.filter((_, i) => i !== index),
    );
    close();
  };

  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line-soft bg-raised px-2 text-ink-faint">
      <Funnel />

      {tab.filters.map((f, i) => {
        const { column, op, value } = summarizeFilter(f);
        return (
          <div key={f.id} ref={openIndex === i ? anchorRef : null} className="relative min-w-0">
            <div
              className={[
                "flex min-w-0 items-center rounded text-[11px]",
                openIndex === i ? "bg-accent-wash" : "bg-hover",
              ].join(" ")}
            >
              <button
                onClick={() => open(i)}
                title={`${column} ${op} ${value}`.trim()}
                className="flex min-w-0 items-center gap-1 py-0.5 pl-1.5 font-mono"
              >
                <span className="truncate text-ink">{column}</span>
                <span className="shrink-0 text-ink-faint">{op}</span>
                {value && <span className="truncate text-ink-muted">{value}</span>}
              </button>
              <button
                onClick={() => remove(i)}
                aria-label={`Remove filter on ${column}`}
                title="Remove filter"
                className="shrink-0 rounded-r px-1.5 py-0.5 text-ink-faint hover:text-ink"
              >
                ×
              </button>
            </div>

            {openIndex === i && (
              <FilterEditor
                columns={columns}
                keyspace={keyspace}
                filter={f}
                anchorRef={anchorRef}
                onCommit={(next) => replace(i, next)}
                onRemove={() => remove(i)}
                onClose={close}
              />
            )}
          </div>
        );
      })}

      <div ref={openIndex === null ? anchorRef : null} className="relative shrink-0">
        <button
          onClick={() => open(null)}
          title="Add filter"
          className={[
            "rounded px-1.5 py-0.5 text-[11px]",
            openIndex === null ? "bg-hover text-ink" : "hover:bg-hover hover:text-ink",
          ].join(" ")}
        >
          {tab.filters.length === 0 ? "Add filter" : "+"}
        </button>

        {openIndex === null && (
          <FilterEditor
            columns={columns}
            keyspace={keyspace}
            filter={draft}
            anchorRef={anchorRef}
            onCommit={(next) => {
              setFilters(tab.id, [...tab.filters, next]);
              close();
            }}
            onRemove={null}
            onClose={close}
          />
        )}
      </div>

      {tab.filters.length > 1 && (
        <button
          onClick={() => {
            setFilters(tab.id, []);
            close();
          }}
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] hover:text-ink"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
