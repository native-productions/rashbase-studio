import { useEffect } from "react";
import { COMMANDS, runCommand } from "@/lib/commands";
import { useApp } from "@/store/app";

/**
 * Parses the display form used in the command registry ("⌘⇧K") into a matcher.
 * Keeping one source of truth means a palette entry can never advertise a
 * shortcut the keyboard layer does not actually handle.
 */
interface Binding {
  meta: boolean;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  key: string;
}

const NAMED: Record<string, string> = {
  "⏎": "enter",
  "⇥": "tab",
  Esc: "escape",
  "⌫": "backspace",
  "/": "/",
};

function parse(display: string): Binding | null {
  let rest = display;
  const b: Binding = { meta: false, shift: false, ctrl: false, alt: false, key: "" };
  for (;;) {
    if (rest.startsWith("⌘")) { b.meta = true; rest = rest.slice(1); continue; }
    if (rest.startsWith("⇧")) { b.shift = true; rest = rest.slice(1); continue; }
    if (rest.startsWith("⌃")) { b.ctrl = true; rest = rest.slice(1); continue; }
    if (rest.startsWith("⌥")) { b.alt = true; rest = rest.slice(1); continue; }
    break;
  }
  const key = NAMED[rest] ?? rest.toLowerCase();
  if (!key) return null;
  b.key = key;
  return b;
}

const BINDINGS: [Binding, string][] = COMMANDS.flatMap((c) => {
  if (!c.keys) return [];
  const b = parse(c.keys);
  return b ? [[b, c.id] as [Binding, string]] : [];
});

function matches(b: Binding, e: KeyboardEvent): boolean {
  return (
    b.meta === e.metaKey &&
    b.ctrl === e.ctrlKey &&
    b.alt === e.altKey &&
    b.shift === e.shiftKey &&
    b.key === e.key.toLowerCase()
  );
}

/** True when the event came from somewhere that owns its own keystrokes. */
function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

/**
 * True when the event came from a surface that has claimed its own keystrokes.
 *
 * The listener below runs in the capture phase, so a surface cannot defend a
 * binding by handling it: ⌘⏎ inside the filter editor would run the tab's query
 * on the way down, before the editor ever saw the key. Marking the container
 * with `data-hotkeys-off` is how it opts out.
 */
function ownsKeys(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest?.("[data-hotkeys-off]");
}

export function useHotkeys() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (ownsKeys(e.target)) return;

      // ⌘1..9 jumps to a tab. Handled here rather than as nine registry
      // entries, which would bloat the palette with noise.
      if (e.metaKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const { tabs, setActiveTab } = useApp.getState();
        const tab = tabs[Number(e.key) - 1];
        if (tab) {
          e.preventDefault();
          setActiveTab(tab.id);
        }
        return;
      }

      for (const [binding, id] of BINDINGS) {
        if (!matches(binding, e)) continue;
        // A bare Escape inside a text field belongs to that field (dismissing
        // autocomplete, for one). Modified shortcuts still win.
        if (binding.key === "escape" && inTextField(e.target)) return;
        e.preventDefault();
        runCommand(id);
        return;
      }
    }

    // Capture phase: CodeMirror, the result grid and Radix dialogs all handle
    // keys of their own, and any one of them calling stopPropagation would
    // silently kill a global shortcut on the way up.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
