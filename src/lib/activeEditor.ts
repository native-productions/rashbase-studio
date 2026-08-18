import type { EditorView } from "@codemirror/view";

/**
 * The mounted SQL editor, so the command registry can reach it.
 *
 * Module-level rather than context: the registry is plain functions outside
 * the React tree, and threading a ref through providers to reach it would be
 * more machinery than the one value is worth.
 *
 * These live here rather than next to the component on purpose. A module that
 * exports both a component and a plain function cannot be Fast Refreshed, and
 * Vite then invalidates upward until it reaches something that can be — which
 * re-evaluates the store module and leaves the app with two copies of a
 * supposedly global singleton. Keeping non-component exports out of `.tsx`
 * files is what stops that.
 */
let view: EditorView | null = null;

export function setActiveEditor(v: EditorView | null) {
  view = v;
}

/**
 * Selected SQL, or `null` when nothing is selected.
 *
 * Focus is part of the question: CodeMirror keeps its selection after you
 * click away, and without this check a forgotten selection would silently
 * narrow what ⌘⏎ runs.
 */
export function selectedSql(): string | null {
  if (!view?.hasFocus) return null;
  const { from, to } = view.state.selection.main;
  if (from === to) return null;
  const text = view.state.sliceDoc(from, to).trim();
  return text || null;
}

/** Moves the cursor to the character Postgres blamed for a syntax error. */
export function focusErrorPosition(position: number) {
  if (!view) return;
  const pos = Math.min(Math.max(0, position - 1), view.state.doc.length);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
}
