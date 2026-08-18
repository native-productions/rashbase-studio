import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { EnumPicker } from "@/components/grid/EnumPicker";
import { useDismiss } from "@/components/ui/menu";
import { PANEL_MARGIN } from "@/lib/constants/ui";
import type { ColumnMeta } from "@/lib/types";

/**
 * The cell editor, as a popover anchored to the cell.
 *
 * It deliberately does not replace the cell's own text. An editor drawn at cell
 * metrics is the same font at the same size in the same place, which makes an
 * open editor and a static cell indistinguishable, and a 120px column is not
 * somewhere a uuid or a jsonb payload can be read while it is being changed.
 * The popover gives the value room and says plainly that it is open.
 *
 * Positioned `fixed` from the cell's own rect: the grid is a scroll container,
 * so anything absolute inside it is clipped at the viewport edges.
 */
const MIN_W = 300;
const MAX_W = 520;

/** Past this, a single line stops being readable in one glance. */
const LONG = 60;

export function CellEditor({
  anchorRef,
  column,
  value,
  isNull,
  enumValues,
  nullable,
  onChange,
  onNull,
  onCommit,
  onCancel,
  onExpand,
}: {
  /** The cell being edited. The popover hangs off its rect. */
  anchorRef: RefObject<HTMLElement | null>;
  column: ColumnMeta;
  value: string;
  isNull: boolean;
  /**
   * Set when the column's type is a closed list, which replaces the field with
   * the list itself. A value that cannot be typed wrong should not be typed.
   */
  enumValues: string[] | null;
  nullable: boolean;
  onChange: (v: string) => void;
  onNull: () => void;
  onCommit: () => void;
  onCancel: () => void;
  /** Opens the same cell in the expanded editor, where a document has room. */
  onExpand: () => void;
}) {
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const picking = enumValues !== null;
  const multiline = !picking && (value.includes("\n") || value.length > LONG);

  // A press outside discards. Losing a half-typed value to a stray click is a
  // smaller harm than writing to the database on one, and Save and ⏎ are both
  // named on the panel for as long as it is open.
  useDismiss(true, onCancel, panelRef);

  // Focus *and* select. `select()` alone leaves the caret nowhere on some
  // engines, which is indistinguishable from the editor never having opened.
  useLayoutEffect(() => {
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }, []);

  // Measured before the browser paints, so the popover is never drawn in the
  // wrong place and then corrected.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const cell = anchor.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = panel;

    const below = cell.bottom + 4;
    const flip = below + h + PANEL_MARGIN > window.innerHeight && cell.top - h - 4 > PANEL_MARGIN;
    setPos({
      left: Math.max(PANEL_MARGIN, Math.min(cell.left, window.innerWidth - w - PANEL_MARGIN)),
      top: flip ? cell.top - h - 4 : below,
    });
  }, [anchorRef]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The grid navigates on arrow keys and the global layer owns Escape; both
    // would fight the caret that is now inside this field.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && (!multiline || e.metaKey)) {
      e.preventDefault();
      onCommit();
    } else if (e.key === "Backspace" && e.metaKey) {
      // The one gesture that tells NULL apart from the empty string.
      e.preventDefault();
      onNull();
    }
  };

  const field =
    "w-full rounded border border-line-soft bg-base px-1.5 py-1 font-mono text-[12px] text-ink outline-none focus:border-accent placeholder:text-null placeholder:italic";

  return (
    <div
      ref={panelRef}
      data-hotkeys-off=""
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width: multiline ? MAX_W : MIN_W,
      }}
      className="menu-anim fixed z-40 rounded-md border border-line bg-overlay p-2 shadow-xl shadow-black/50"
    >
      <div className="mb-1.5 flex items-baseline gap-1.5">
        <span className="min-w-0 truncate font-mono text-[11px] text-ink">{column.name}</span>
        <span className="shrink-0 text-[10px] text-ink-faint">{column.typeName}</span>
      </div>

      {picking ? (
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
      ) : multiline ? (
        <textarea
          ref={fieldRef as RefObject<HTMLTextAreaElement>}
          rows={Math.min(12, Math.max(3, value.split("\n").length + 1))}
          value={value}
          placeholder={isNull ? "NULL" : undefined}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className={`${field} resize-y`}
        />
      ) : (
        <input
          ref={fieldRef as RefObject<HTMLInputElement>}
          value={value}
          placeholder={isNull ? "NULL" : undefined}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          className={field}
        />
      )}

      {/* A closed list has nothing to confirm: the choice is the commit. All
          that is left is the way out of the popover. */}
      {picking ? (
        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-ink-faint">
          <button onClick={onCancel} className="rounded px-1 py-0.5 hover:bg-hover hover:text-ink">
            Cancel
          </button>
          <span className="ml-auto font-mono">⏎</span>
        </div>
      ) : (
        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-ink-faint">
          <button onClick={onNull} className="rounded px-1 py-0.5 hover:bg-hover hover:text-ink">
            Set NULL
          </button>
          <button onClick={onExpand} className="rounded px-1 py-0.5 hover:bg-hover hover:text-ink">
            Expand
          </button>
          <button onClick={onCancel} className="rounded px-1 py-0.5 hover:bg-hover hover:text-ink">
            Cancel
          </button>
          <span className="ml-auto font-mono">{multiline ? "⌘⏎" : "⏎"}</span>
          <button
            onClick={onCommit}
            className="pressable rounded bg-accent px-2 py-0.5 text-[10px] font-medium text-base"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}
