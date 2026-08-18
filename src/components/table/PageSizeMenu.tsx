import { useCallback, useEffect, useRef, useState } from "react";
import { useAnchoredPanel } from "@/components/ui/menu";
import { PAGE_SIZE_PRESETS } from "@/lib/constants/grid";
import { MENU_ITEM, MENU_PANEL } from "@/lib/constants/ui";

/**
 * Rows per page, sitting between the pager arrows.
 *
 * Presets cover what people actually pick; the field underneath exists because
 * the right page size is a property of the table you are reading, not of the
 * list we guessed at.
 */
export function PageSizeMenu({
  limit,
  onChange,
}: {
  limit: number;
  onChange: (limit: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const dismiss = useCallback(() => setOpen(false), []);
  const flip = useAnchoredPanel({
    open,
    onDismiss: dismiss,
    rootRef,
    anchorRef: triggerRef,
    panelRef,
  });

  useEffect(() => {
    if (open) setDraft(String(limit));
  }, [open, limit]);

  function commit(next: number) {
    if (!Number.isFinite(next) || next < 1) return;
    setOpen(false);
    triggerRef.current?.focus();
    if (next !== limit) onChange(next);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={`${limit} rows per page`}
        aria-label="Rows per page"
        className={[
          "pressable rounded p-1",
          open ? "bg-hover text-ink" : "text-ink-faint hover:bg-hover hover:text-ink",
        ].join(" ")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none">
          <circle cx="6" cy="6" r="1.85" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M6 1v1.4M6 9.6V11M11 6H9.6M2.4 6H1M9.54 2.46l-1 1M3.46 8.54l-1 1M9.54 9.54l-1-1M3.46 3.46l-1-1"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            setOpen(false);
            triggerRef.current?.focus();
          }}
          className={[
            MENU_PANEL,
            "absolute z-10 left-1/2 w-36 -translate-x-1/2",
            flip ? "bottom-full mb-1.5" : "top-full mt-1.5",
          ].join(" ")}
        >
          {PAGE_SIZE_PRESETS.map((n) => (
            <button
              key={n}
              role="menuitemradio"
              aria-checked={n === limit}
              onClick={() => commit(n)}
              className={[
                MENU_ITEM,
                n === limit ? "bg-accent-wash text-ink" : "text-ink-muted hover:bg-hover",
              ].join(" ")}
            >
              <span
                aria-hidden="true"
                className={["w-2.5 shrink-0 text-[10px]", n === limit ? "text-accent" : "text-transparent"].join(" ")}
              >
                ✓
              </span>
              <span>{n.toLocaleString()}</span>
              <span className="ml-auto text-[10px] text-ink-faint">rows</span>
            </button>
          ))}

          <div className="mt-1 border-t border-line-soft px-1.5 pt-1.5 pb-0.5">
            <label className="flex items-center gap-1.5">
              <span className="text-[10px] text-ink-faint">Custom</span>
              <input
                type="number"
                min={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  commit(Number(draft));
                }}
                className="w-full min-w-0 rounded border border-line-soft bg-base px-1.5 py-1 text-right font-mono text-[11px] text-ink focus:border-accent focus:outline-none"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
