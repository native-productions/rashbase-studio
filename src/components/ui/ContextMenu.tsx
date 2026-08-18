import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDismiss } from "@/components/ui/menu";
import { MENU_ITEM, MENU_PANEL, PANEL_MARGIN } from "@/lib/constants/ui";

/**
 * A menu that opens at the pointer.
 *
 * Mostly flat: an action is one press with no hover-and-wait. A submenu is
 * used only where one verb has several forms of the same thing — Copy, and
 * what to copy — so the top level stays short. Destructive items sit below a
 * rule at the end, where the hand does not land by accident.
 */
export type ContextMenuItem =
  | { kind: "item"; id: string; label: string; danger?: boolean; hint?: string }
  | { kind: "submenu"; label: string; items: { id: string; label: string }[] }
  | { kind: "heading"; label: string }
  | { kind: "separator" };

export function ContextMenu({
  x,
  y,
  items,
  onSelect,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  const selectable = items.flatMap((item, i) =>
    item.kind === "item" || item.kind === "submenu" ? [i] : [],
  );
  const [active, setActive] = useState(selectable[0] ?? -1);

  // The open submenu, with the placement measured off its row so the panel
  // does not have to be a child of a row that is only one line tall.
  const [sub, setSub] = useState<{ index: number; left: number; top: number } | null>(null);
  const [subActive, setSubActive] = useState(0);
  const subItems = sub ? (items[sub.index] as Extract<ContextMenuItem, { kind: "submenu" }>).items : [];

  useDismiss(true, onClose, rootRef);

  // Nudge inward before the first paint rather than letting the menu render
  // half off-screen and jump.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    setPos({
      left: Math.max(PANEL_MARGIN, Math.min(x, window.innerWidth - w - PANEL_MARGIN)),
      top: Math.max(PANEL_MARGIN, Math.min(y, window.innerHeight - h - PANEL_MARGIN)),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const openSub = useCallback((index: number, row: HTMLElement) => {
    const box = row.getBoundingClientRect();
    const panel = row.parentElement?.getBoundingClientRect();
    setSub({ index, left: (panel?.right ?? box.right) - 2, top: box.top - 5 });
    setSubActive(0);
  }, []);

  const step = useCallback(
    (delta: number) => {
      setActive((current) => {
        const at = selectable.indexOf(current);
        const next = selectable[Math.min(selectable.length - 1, Math.max(0, at + delta))];
        return next ?? current;
      });
    },
    // `selectable` is derived from `items`, which is stable for the life of an
    // open menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items],
  );

  return (
    <div
      ref={rootRef}
      role="menu"
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (sub) setSub(null);
          else onClose();
          return;
        }
        if (sub) {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setSubActive((i) =>
              Math.min(subItems.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1))),
            );
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            setSub(null);
          } else if (e.key === "Enter" || e.key === "ArrowRight") {
            e.preventDefault();
            const item = subItems[subActive];
            if (item) onSelect(item.id);
          }
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          step(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          step(-1);
        } else if (e.key === "Enter" || e.key === "ArrowRight") {
          const item = items[active];
          if (item?.kind === "item" && e.key === "Enter") {
            e.preventDefault();
            onSelect(item.id);
          } else if (item?.kind === "submenu") {
            e.preventDefault();
            const row = rootRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`);
            if (row) openSub(active, row);
          }
        }
      }}
      className={`${MENU_PANEL} fixed z-50 min-w-52`}
    >
      {items.map((item, i) => {
        if (item.kind === "separator") {
          return <div key={i} className="my-1 border-t border-line-soft" />;
        }
        if (item.kind === "heading") {
          return (
            <div key={i} className="label-eyebrow px-1.5 pt-1 pb-0.5">
              {item.label}
            </div>
          );
        }
        const on = i === active;
        const tone = on ? "bg-accent-wash text-ink" : "text-ink-muted";

        if (item.kind === "submenu") {
          return (
            <button
              key={item.label}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={sub?.index === i}
              data-row={i}
              onPointerEnter={(e) => {
                setActive(i);
                openSub(i, e.currentTarget);
              }}
              onClick={(e) => openSub(i, e.currentTarget)}
              className={[MENU_ITEM, "justify-between text-left", tone].join(" ")}
            >
              {item.label}
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path
                  d="M3.5 2l3 3-3 3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          );
        }

        return (
          <button
            key={item.id}
            role="menuitem"
            data-row={i}
            onPointerEnter={() => {
              setActive(i);
              setSub(null);
            }}
            onClick={() => onSelect(item.id)}
            className={[
              MENU_ITEM,
              "text-left",
              item.danger ? (on ? "bg-danger/15 text-danger" : "text-danger") : tone,
            ].join(" ")}
          >
            {item.label}
            {item.hint && (
              <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-faint">
                {item.hint}
              </span>
            )}
          </button>
        );
      })}

      {sub && (
        <Submenu
          left={sub.left}
          top={sub.top}
          items={subItems}
          active={subActive}
          onActive={setSubActive}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}

/** The second level, placed to the right of its row and flipped when it would overflow. */
function Submenu({
  left,
  top,
  items,
  active,
  onActive,
  onSelect,
}: {
  left: number;
  top: number;
  items: { id: string; label: string }[];
  active: number;
  onActive: (i: number) => void;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left, top });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    setPos({
      left:
        left + w + PANEL_MARGIN > window.innerWidth
          ? Math.max(PANEL_MARGIN, left - w - (el.parentElement?.offsetWidth ?? 0) + 4)
          : left,
      top: Math.max(PANEL_MARGIN, Math.min(top, window.innerHeight - h - PANEL_MARGIN)),
    });
  }, [left, top, items.length]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      className={`${MENU_PANEL} fixed z-50 min-w-44`}
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          role="menuitem"
          onPointerEnter={() => onActive(i)}
          onClick={() => onSelect(item.id)}
          className={[
            MENU_ITEM,
            "text-left",
            i === active ? "bg-accent-wash text-ink" : "text-ink-muted",
          ].join(" ")}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
