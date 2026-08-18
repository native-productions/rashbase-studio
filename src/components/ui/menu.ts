import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { PANEL_MARGIN } from "@/lib/constants/ui";

/**
 * The behaviour every popup menu in the app shares, so the second one does not
 * quietly diverge from the first: dismissal, and up-or-down placement.
 *
 * Deliberately two hooks rather than a `<Popover>` component. The consumers
 * differ in what lives inside the panel and how it handles keys. They do not
 * differ in any of this. The class strings that make a panel *look* like a
 * menu are in `@/lib/constants/ui`, since a constant is not a hook.
 */

/**
 * Closes the menu on a pointer press outside it.
 *
 * Capture phase, so a press landing on something that stops propagation still
 * dismisses. Split out from `useAnchoredPanel` because a context menu opens at
 * the pointer rather than off an element, and shares this half but not the
 * placement half.
 */
export function useDismiss(
  open: boolean,
  onDismiss: () => void,
  rootRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) onDismiss();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, onDismiss, rootRef]);
}

/**
 * Returns whether the panel should open upward.
 *
 * Measured in a layout effect so the answer is known before the browser
 * paints: a panel near the bottom of the window must never be drawn once in
 * the wrong place and then corrected.
 */
export function useAnchoredPanel({
  open,
  onDismiss,
  rootRef,
  anchorRef,
  panelRef,
}: {
  open: boolean;
  onDismiss: () => void;
  /** Wrapper that counts as "inside" for dismissal purposes. */
  rootRef: RefObject<HTMLElement | null>;
  /** Element the panel hangs off, used to measure remaining space. */
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
}): boolean {
  const [flip, setFlip] = useState(false);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!open || !panel || !anchor) return;
    const box = anchor.getBoundingClientRect();
    const height = panel.offsetHeight;
    setFlip(box.bottom + height + PANEL_MARGIN > window.innerHeight && box.top > height);
  }, [open, anchorRef, panelRef]);

  useDismiss(open, onDismiss, rootRef);

  return flip;
}
