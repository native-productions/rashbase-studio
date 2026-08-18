import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { EnumPicker } from "@/components/grid/EnumPicker";
import { JsonTree } from "@/components/grid/JsonTree";
import { parseJson } from "@/lib/utils/json";
import { editableReason, enumValuesFor, nullableColumn } from "@/lib/utils/tabs";
import type { QueryTab } from "@/lib/types";
import { useApp } from "@/store/app";

/**
 * One row, read down the page instead of across the grid.
 *
 * A jsonb payload or a long text column in a 120px cell is a horizontal scroll,
 * not information. Here every field gets the full width and as much height as
 * it needs, which also makes this the sane place to edit one.
 *
 * It shrinks the grid rather than floating over it: an overlay would cover the
 * rows the user is comparing against.
 */
const MIN_W = 220;
const MAX_W = 640;

export function RowPanel({ tab }: { tab: QueryTab }) {
  const closeRowPanel = useApp((s) => s.closeRowPanel);
  const cellEdit = useApp((s) =>
    s.cellEdit?.tabId === tab.id && s.cellEdit.where === "panel" ? s.cellEdit : null,
  );
  const beginEdit = useApp((s) => s.beginEdit);
  const setEditDraft = useApp((s) => s.setEditDraft);
  const setEditNull = useApp((s) => s.setEditNull);
  const cancelEdit = useApp((s) => s.cancelEdit);
  const commitEdit = useApp((s) => s.commitEdit);
  const openCellView = useApp((s) => s.openCellView);

  const [width, setWidth] = useState(320);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const onDragMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // Dragging left widens: the handle is on the panel's leading edge.
    setWidth(Math.min(MAX_W, Math.max(MIN_W, d.startW + (d.startX - e.clientX))));
  }, []);

  const onDragUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragUp);
  }, [onDragMove]);

  const onDragDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startW: width };
      window.addEventListener("pointermove", onDragMove);
      window.addEventListener("pointerup", onDragUp);
    },
    [width, onDragMove, onDragUp],
  );

  const result = tab.results[tab.activeResultIndex];
  const selection = tab.selection;
  const row = selection ? result?.rows[selection.row] : undefined;
  const reason = editableReason(tab);
  const keyed = new Set((tab.columns ?? []).filter((c) => c.primaryKey).map((c) => c.name));

  return (
    <aside
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-line bg-raised"
    >
      <div
        onPointerDown={onDragDown}
        className="group absolute top-0 -left-px z-10 h-full w-px cursor-col-resize bg-line"
      >
        <div className="absolute -left-1 h-full w-2 group-hover:bg-accent/30" />
      </div>

      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-line-soft px-2.5">
        <span className="text-[11px] font-semibold text-ink">
          {selection && row ? `Row ${selection.row + 1}` : "No row selected"}
        </span>
        {reason && (
          <span className="min-w-0 truncate text-[10px] text-ink-faint" title={reason}>
            {reason}
          </span>
        )}
        <button
          onClick={closeRowPanel}
          aria-label="Close row panel"
          title="Close row panel"
          className="ml-auto shrink-0 rounded px-1 text-[12px] text-ink-faint hover:text-ink"
        >
          ×
        </button>
      </header>

      {!row || !result ? (
        <p className="px-2.5 py-3 text-[11px] text-ink-faint">
          Click a cell to read its row here.
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {result.columns.map((col, i) => {
            const value = row[i];
            const editing = cellEdit?.row === selection!.row && cellEdit.col === i;
            const enumValues = enumValuesFor(tab.columns, col.name);
            // A document is drawn as one whatever the column's declared type
            // says: a text column holding JSON is still JSON to the person
            // reading it.
            const doc = parseJson(value);
            return (
              <div key={`${col.name}-${i}`} className="border-b border-line-soft px-2.5 py-1.5">
                <div className="flex items-baseline gap-1.5">
                  {/* Same key marker as the Structure view, in the gutter of
                      the name where the eye already is. */}
                  <span
                    aria-hidden="true"
                    className={[
                      "shrink-0 font-mono text-[9px]",
                      keyed.has(col.name) ? "text-accent" : "text-transparent",
                    ].join(" ")}
                    title={keyed.has(col.name) ? "Primary key" : undefined}
                  >
                    ◆
                  </span>
                  <span className="min-w-0 truncate font-mono text-[11px] text-ink-muted">
                    {col.name}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-ink-faint">
                    {col.typeName}
                  </span>
                  {/* The panel is 320px. Anything that does not fit gets a way
                      out of it rather than a scrollbar to fight. */}
                  <button
                    onClick={() => openCellView(tab.id, selection!.row, i)}
                    aria-label={`Expand ${col.name}`}
                    title="Expand (⌘E)"
                    className="shrink-0 rounded px-1 text-[10px] text-ink-faint hover:bg-hover hover:text-ink"
                  >
                    ⤡
                  </button>
                </div>

                <div className="mt-0.5 pl-[calc(0.375rem+9px)]">
                  {editing ? (
                    <FieldEditor
                      value={cellEdit.isNull ? "" : cellEdit.draft}
                      isNull={cellEdit.isNull}
                      multiline={(value ?? "").includes("\n")}
                      enumValues={enumValues}
                      nullable={nullableColumn(tab.columns, col.name)}
                      onChange={setEditDraft}
                      onNull={() => setEditNull(true)}
                      onCommit={() => void commitEdit()}
                      onCancel={cancelEdit}
                    />
                  ) : doc ? (
                    /* Read-only here on purpose. Editing a document happens in
                       the expanded editor, where a nested key is not being
                       clicked at 300px wide. */
                    <div className="max-h-56 overflow-auto">
                      <JsonTree value={doc} className="-ml-1" />
                    </div>
                  ) : (
                    <button
                      onClick={() => reason === null && beginEdit(tab.id, selection!.row, i, "panel")}
                      title={reason ?? "Click to edit"}
                      className={[
                        "flex max-h-40 w-full items-baseline gap-1 overflow-y-auto rounded px-1 py-0.5 text-left font-mono text-[12px] break-all whitespace-pre-wrap select-text",
                        value === null ? "text-null italic" : "text-ink",
                        reason === null ? "hover:bg-hover" : "cursor-default",
                      ].join(" ")}
                    >
                      <span className="min-w-0">
                        {value === null ? "NULL" : value === "" ? " " : value}
                      </span>
                      {/* The standing sign that this field is a list, visible
                          before anything is clicked. */}
                      {enumValues && reason === null && (
                        <span
                          aria-hidden="true"
                          className="ml-auto shrink-0 text-[9px] text-ink-faint"
                        >
                          ⌄
                        </span>
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

/**
 * The panel's editor. Same state as the grid's, more room.
 *
 * A value that already contains a newline gets a textarea, where Enter has to
 * mean "newline" and `⌘⏎` runs the write. Anything else gets an input, where
 * Enter runs it, matching the grid.
 */
function FieldEditor({
  value,
  isNull,
  multiline,
  enumValues,
  nullable,
  onChange,
  onNull,
  onCommit,
  onCancel,
}: {
  value: string;
  isNull: boolean;
  multiline: boolean;
  /** Set when the column's type is a closed list. Same control as the grid's. */
  enumValues: string[] | null;
  nullable: boolean;
  onChange: (v: string) => void;
  onNull: () => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useLayoutEffect(() => ref.current?.select(), []);

  // A closed list replaces the field entirely: the same control the grid opens,
  // so an enum is edited one way in this application rather than two.
  if (enumValues) {
    return (
      <EnumPicker
        values={enumValues}
        current={value}
        isNull={isNull}
        nullable={nullable}
        onCommit={(v) => {
          onChange(v);
          onCommit();
        }}
        onNull={() => {
          onNull();
          onCommit();
        }}
        onCancel={onCancel}
      />
    );
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && (!multiline || e.metaKey)) {
      e.preventDefault();
      onCommit();
    } else if (e.key === "Backspace" && e.metaKey) {
      e.preventDefault();
      onNull();
    }
  };

  const shared =
    "w-full rounded border border-accent bg-base px-1 py-0.5 font-mono text-[12px] text-ink outline-none placeholder:text-null placeholder:italic";

  return (
    <div className="flex flex-col gap-1">
      {multiline ? (
        <textarea
          ref={ref as React.RefObject<HTMLTextAreaElement>}
          data-hotkeys-off=""
          rows={Math.min(10, value.split("\n").length + 1)}
          value={value}
          placeholder={isNull ? "NULL" : undefined}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          className={`${shared} resize-y`}
        />
      ) : (
        <input
          ref={ref as React.RefObject<HTMLInputElement>}
          data-hotkeys-off=""
          value={value}
          placeholder={isNull ? "NULL" : undefined}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          className={shared}
        />
      )}

      <div className="flex items-center gap-2 text-[10px] text-ink-faint">
        <button onClick={onNull} className="rounded px-1 hover:bg-hover hover:text-ink">
          Set NULL
        </button>
        <button onClick={onCancel} className="rounded px-1 hover:bg-hover hover:text-ink">
          Cancel
        </button>
        <span className="ml-auto font-mono">{multiline ? "⌘⏎" : "⏎"}</span>
        <button
          onClick={onCommit}
          className="pressable rounded bg-accent px-2 py-0.5 text-[10px] font-medium text-canvas"
        >
          Save
        </button>
      </div>
    </div>
  );
}
