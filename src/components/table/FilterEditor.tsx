import { useEffect, useRef, useState, type RefObject } from "react";
import { Select } from "@/components/ui/Select";
import { useAnchoredPanel } from "@/components/ui/menu";
import { FILTER_OPS, KEY_FILTER_OPS, OP_ARITY, OP_LABEL } from "@/lib/constants/filters";
import { INPUT_COMPACT_CLS } from "@/lib/constants/ui";
import { filterReady } from "@/lib/utils/filters";
import type { ColumnMeta, Filter, FilterOp } from "@/lib/types";

/**
 * The popover that builds one condition.
 *
 * Deliberately not `MENU_PANEL`: that class carries `overflow-y-auto`, which
 * would clip the listbox of the two `Select`s inside this panel. Everything
 * else about the surface matches the app's other menus.
 */
const PANEL =
  "menu-anim absolute z-30 w-80 rounded-md border border-line bg-overlay p-2 shadow-xl shadow-black/50";

/** Any column is first because it is the filter you reach for without knowing the schema. */
const ANY = "";

export function FilterEditor({
  columns,
  keyspace = false,
  filter,
  anchorRef,
  onCommit,
  onRemove,
  onClose,
}: {
  columns: ColumnMeta[];
  /**
   * Whether this is filtering a flat key namespace rather than a relation.
   *
   * Changes the operator list and drops "any column": a keyspace has two things
   * to filter on and they cost very differently, so ORing a condition across
   * both would be a search whose price the user cannot see.
   */
  keyspace?: boolean;
  /** The filter being edited, or a fresh one from `newFilter`. */
  filter: Filter;
  /** Wrapper holding both the trigger and this panel: dismissal and placement. */
  anchorRef: RefObject<HTMLDivElement | null>;
  onCommit: (filter: Filter) => void;
  /** Absent for a filter that is not on the bar yet. */
  onRemove: (() => void) | null;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Filter>(filter);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstValueRef = useRef<HTMLInputElement>(null);

  const flip = useAnchoredPanel({
    open: true,
    onDismiss: onClose,
    rootRef: anchorRef,
    anchorRef,
    panelRef,
  });

  const arity = OP_ARITY[draft.op];

  // The value is what the user came to type, so it holds the caret from the
  // start. Re-runs when the arity changes so switching off IS NULL lands
  // somewhere useful rather than nowhere.
  useEffect(() => {
    firstValueRef.current?.select();
  }, [arity]);

  const setValue = (i: number, v: string) =>
    setDraft((d) => {
      const values = [...d.values];
      values[i] = v;
      return { ...d, values };
    });

  // A filter missing a value would contribute no condition, so it never reaches
  // the bar: a chip that changes nothing is worse than no chip.
  const ready = filterReady(draft);
  const commit = () => {
    if (ready) onCommit(draft);
  };

  return (
    <div
      ref={panelRef}
      // This surface owns ⌘⏎. Without the marker the global handler would run
      // the tab's query on the way past, since it listens in the capture phase.
      data-hotkeys-off=""
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          return;
        }
        // An open `Select` owns Enter: there it picks the highlighted option,
        // and applying on the same keystroke would commit the draft as it was
        // before the pick.
        if (e.key === "Enter" && (e.target as HTMLElement).getAttribute("role") !== "listbox") {
          e.preventDefault();
          commit();
        }
      }}
      className={[PANEL, flip ? "bottom-full mb-1.5" : "top-full mt-1.5"].join(" ")}
    >
      <div className="flex flex-col gap-1.5">
        <Select
          value={draft.column ?? (keyspace ? "key" : ANY)}
          onChange={(v) => setDraft((d) => ({ ...d, column: v === ANY ? null : v }))}
          options={[
            ...(keyspace ? [] : [{ value: ANY, label: "Any column" }]),
            ...columns.map((c) => ({ value: c.name, label: `${c.name} · ${c.typeName}` })),
          ]}
        />

        <div className="flex items-center gap-1.5">
          <div className="w-32 shrink-0">
            <Select
              value={draft.op}
              onChange={(v) =>
                setDraft((d) => {
                  const op = v as FilterOp;
                  // Values are kept across an op change: switching = to <> or
                  // BETWEEN to NOT BETWEEN should not make you retype.
                  const values = d.values.slice(0, OP_ARITY[op]);
                  while (values.length < OP_ARITY[op]) values.push("");
                  return { ...d, op, values };
                })
              }
              options={(keyspace ? KEY_FILTER_OPS : FILTER_OPS).map((op) => ({
                value: op,
                label: OP_LABEL[op],
              }))}
            />
          </div>

          {arity === 0 ? (
            <span className="flex-1 text-[11px] text-ink-faint">No value needed</span>
          ) : (
            <>
              <input
                ref={firstValueRef}
                autoFocus
                value={draft.values[0] ?? ""}
                onChange={(e) => setValue(0, e.target.value)}
                placeholder={
                  draft.op === "in" || draft.op === "notIn"
                    ? "a, b, c"
                    : draft.op === "like" || draft.op === "ilike"
                      ? "pattern with %"
                      : draft.op === "matches"
                        ? "nvp:na:*"
                        : draft.op === "prefix"
                          ? "nvp:na:"
                          : "value"
                }
                className={INPUT_COMPACT_CLS}
              />
              {arity === 2 && (
                <>
                  <span className="shrink-0 text-[10px] text-ink-faint">and</span>
                  <input
                    value={draft.values[1] ?? ""}
                    onChange={(e) => setValue(1, e.target.value)}
                    placeholder="value"
                    className={INPUT_COMPACT_CLS}
                  />
                </>
              )}
            </>
          )}
        </div>

        <div className="mt-0.5 flex items-center gap-2 border-t border-line-soft pt-2">
          {onRemove && (
            <button
              onClick={onRemove}
              className="rounded px-1 py-0.5 text-[11px] text-ink-faint hover:text-danger"
            >
              Remove
            </button>
          )}
          <span className="ml-auto font-mono text-[10px] text-ink-faint">⌘⏎</span>
          <button
            onClick={commit}
            disabled={!ready}
            className="pressable rounded bg-accent-fill px-2.5 py-1 text-[11px] font-medium text-on-accent disabled:pointer-events-none disabled:opacity-30"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
