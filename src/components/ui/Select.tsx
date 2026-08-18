import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAnchoredPanel } from "@/components/ui/menu";
import { MENU_ITEM, MENU_PANEL, TYPEAHEAD_RESET_MS } from "@/lib/constants/ui";

/**
 * Dropdown that obeys the app's own tokens.
 *
 * A native `<select>` renders its popup with the OS, which means it arrives in
 * system chrome — light grey on a dark app, its own font, its own metrics —
 * and there is no CSS that reaches inside it. So it is drawn here instead.
 *
 * Everything native `<select>` gets right is kept, because those are the parts
 * people notice only when they break: arrow keys, Home/End, type-to-jump,
 * Escape without losing the value, click-outside, and focus returning to the
 * trigger afterwards.
 *
 * Rendered in place rather than through a portal: the only surfaces that hold
 * a dropdown here are modal, and a portalled popup fights the dialog's focus
 * trap for no benefit at this size.
 */
export interface SelectOption {
  value: string;
  label: string;
}

export function Select({
  value,
  options,
  onChange,
  labelledBy,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Id of the element naming this control, since there is no `<label>` tie. */
  labelledBy?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ buffer: "", at: 0 });

  const dismiss = useCallback(() => setOpen(false), []);
  const flip = useAnchoredPanel({
    open,
    onDismiss: dismiss,
    rootRef,
    anchorRef: triggerRef,
    panelRef: listRef,
  });

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const selected = options[selectedIndex];

  function openMenu() {
    setActive(selectedIndex);
    setOpen(true);
  }

  function close(refocus = true) {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }

  function commit(index: number) {
    const option = options[index];
    if (option) onChange(option.value);
    close();
  }

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function onListKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "Escape":
        // Without this the enclosing dialog would take the Escape and close
        // the whole sheet, which is not what dismissing a menu means.
        e.stopPropagation();
        close();
        return;
      case "Tab":
        close(false);
        return;
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(options.length - 1, i + 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        return;
      case "Home":
        e.preventDefault();
        setActive(0);
        return;
      case "End":
        e.preventDefault();
        setActive(options.length - 1);
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(active);
        return;
    }

    if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
    const now = Date.now();
    const buffer = now - typed.current.at > TYPEAHEAD_RESET_MS ? e.key : typed.current.buffer + e.key;
    typed.current = { buffer, at: now };
    const match = options.findIndex((o) => o.label.toLowerCase().startsWith(buffer.toLowerCase()));
    if (match >= 0) setActive(match);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={labelledBy}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openMenu();
          }
        }}
        className={[
          // Same height, fill, and radius as a text input: a form reads as one
          // control vocabulary or as a pile of widgets, and there is no third
          // option.
          "flex h-7 w-full items-center gap-2 rounded-md bg-field px-2 text-left text-[12px] text-ink",
          open
            ? "outline outline-1 -outline-offset-1 outline-accent"
            : "hover:bg-field-hover",
        ].join(" ")}
      >
        <span className="truncate">{selected?.label ?? value}</span>
        <svg
          width="9"
          height="9"
          viewBox="0 0 10 10"
          aria-hidden="true"
          className={[
            "ml-auto shrink-0 text-ink-faint transition-transform duration-150",
            open ? "rotate-180" : "",
          ].join(" ")}
        >
          <path
            d="M1.5 3.5L5 7l3.5-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKeyDown}
          className={[
            MENU_PANEL,
            "absolute z-10 max-h-56 w-full",
            flip ? "bottom-full mb-1" : "top-full mt-1",
          ].join(" ")}
        >
          {options.map((option, i) => (
            <div
              key={option.value}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={option.value === value}
              onPointerEnter={() => setActive(i)}
              onClick={() => commit(i)}
              className={[
                MENU_ITEM,
                i === active ? "bg-accent-wash text-ink" : "text-ink-muted",
              ].join(" ")}
            >
              {/* Always laid out, only sometimes inked, so the labels do not
                  shift when the selection moves. */}
              <span
                aria-hidden="true"
                className={[
                  "w-2.5 shrink-0 text-[10px]",
                  option.value === value ? "text-accent" : "text-transparent",
                ].join(" ")}
              >
                ✓
              </span>
              <span className="truncate">{option.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
