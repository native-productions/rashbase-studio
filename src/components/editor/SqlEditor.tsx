import { useEffect, useMemo, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { HighlightStyle, bracketMatching, syntaxHighlighting } from "@codemirror/language";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { setActiveEditor } from "@/lib/activeEditor";
import { isKeyspaceDriver } from "@/lib/constants/connection";
import { useApp } from "@/store/app";

/**
 * Syntax colours come from the same tokens as the grid, so a `text` literal in
 * the editor and a text column in the results read as the same thing.
 */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword], color: "var(--color-accent)", fontWeight: "500" },
  { tag: [t.string, t.special(t.string)], color: "var(--color-str)" },
  { tag: [t.number, t.bool, t.null], color: "var(--color-num)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--color-ink-faint)", fontStyle: "italic" },
  { tag: [t.typeName, t.className], color: "var(--color-bool)" },
  { tag: [t.variableName, t.propertyName], color: "var(--color-ink)" },
  { tag: [t.operator, t.punctuation, t.separator], color: "var(--color-ink-muted)" },
  { tag: t.invalid, color: "var(--color-danger)" },
]);

/*
  Why the `!important` below, so it does not get tidied away.

  `EditorView.theme` prefixes our selectors with a single generated class,
  while `EditorView.baseTheme` scopes its `&dark` rules with two:

      ours  .ͼx .cm-activeLine                             (0,2,0)
      base  .ͼ1.ͼ3 .cm-activeLine                          (0,3,0)
      base  .ͼ1.ͼ3.cm-focused > .cm-scroller > …           (0,6,0)

  So every colour that also has a base rule upstream loses no matter how long a
  selector we write — matching the longest base path still only reaches
  (0,5,0). That is true of the `&light` set as much as the `&dark` one, so the
  marks are needed under either palette. They are exactly the declarations that
  collide, checked against both in @codemirror/view.
*/
const RULES = {
  "&": {
    height: "100%",
    fontSize: "12px",
    backgroundColor: "var(--color-canvas)",
    color: "var(--color-ink)",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    padding: "8px 0",
    caretColor: "var(--color-accent) !important",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": {
    backgroundColor: "var(--color-canvas) !important",
    color: "var(--color-ink-faint) !important",
    border: "none !important",
    paddingRight: "4px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent !important",
    color: "var(--color-ink-muted) !important",
  },
  /*
    Translucent, not opaque. The active line is a decoration inside
    `.cm-content`, which paints above `.cm-selectionLayer`, so an opaque fill
    hides the selection on whichever line holds the cursor — which is every
    line after ⌘A, and the exact reason the last line looked unselected.
  */
  ".cm-activeLine": { backgroundColor: "var(--color-hover) !important" },
  ".cm-selectionBackground": { backgroundColor: "var(--color-selection) !important" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--color-selection) !important",
  },
  ".cm-content ::selection": { backgroundColor: "var(--color-selection) !important" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--color-accent) !important",
    borderLeftWidth: "2px",
  },
  /* Other occurrences of the selected word: the same yellow, weaker, so the
     real selection still reads as the one the pointer made. */
  ".cm-selectionMatch": { backgroundColor: "var(--color-selection-soft)" },
  ".cm-tooltip": {
    backgroundColor: "var(--color-overlay) !important",
    border: "1px solid var(--color-line) !important",
    borderRadius: "6px",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--color-accent-wash)",
    color: "var(--color-ink)",
  },
};

/**
 * One theme extension per palette, built once.
 *
 * The `dark` flag is what decides whether CodeMirror applies its `&dark` or
 * `&light` base rules, and every colour we do not override falls through to
 * that set — a theme built with `dark: true` running on paper renders those in
 * CodeMirror's dark palette, with nothing on screen to explain why. The flag
 * cannot be changed on a live extension, so switching palette rebuilds the
 * view. That is the same bargain the Redis console makes below, and acceptable
 * for the same reason: it happens when a preference changes, not while anyone
 * is typing.
 */
const THEMES = {
  dark: EditorView.theme(RULES, { dark: true }),
  light: EditorView.theme(RULES, { dark: false }),
} as const;

export function SqlEditor({ tabId, value }: { tabId: string; value: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const setTabSql = useApp((s) => s.setTabSql);

  const appTheme = useApp((s) => s.prefs.theme);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const schemas = useApp((s) => s.schemas);
  const tables = useApp((s) => s.tables);

  /**
   * Whether this tab talks to a key-value store rather than a SQL server.
   *
   * Read from the tab's own connection, not the active one: a console tab stays
   * pointed at the connection it was opened on while the sidebar moves.
   */
  const console = useApp((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    const config = s.connections.find((c) => c.id === tab?.connectionId);
    return !!config && isKeyspaceDriver(config.driver);
  });

  // Table names for completion. Columns arrive with column introspection in
  // Phase 1; until then this is still enough to stop typos in table names.
  const completionSchema = useMemo(() => {
    if (!activeConnectionId) return {};
    const out: Record<string, string[]> = {};
    for (const s of schemas[activeConnectionId] ?? []) {
      for (const table of tables[`${activeConnectionId}::${s.name}`] ?? []) {
        out[s.name === "public" ? table.name : `${s.name}.${table.name}`] = [];
      }
    }
    return out;
  }, [activeConnectionId, schemas, tables]);

  useEffect(() => {
    if (!host.current) return;

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSelectionMatches(),
      history(),
      drawSelection(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      syntaxHighlighting(highlight),
      // A Redis command is not SQL, and the SQL grammar colours it wrongly:
      // `GET` is not a keyword, `user:1` is not an operator applied to a
      // number. Plain text is the honest rendering, and everything else about
      // the editor — the theme, the metrics, the keymap — stays as it is.
      ...(console
        ? [placeholder("One command per line, then ⌘⏎ to run. Select a line to run only that.")]
        : [
            sql({ dialect: PostgreSQL, schema: completionSchema, upperCaseKeywords: false }),
            placeholder("Write SQL, then ⌘⏎ to run. Select a fragment to run only that."),
          ]),
      THEMES[appTheme],
      EditorView.lineWrapping,
      // ⌘⏎ is deliberately absent: the global hotkey layer owns it, so the
      // palette and the keyboard can never disagree about what it does.
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) setTabSql(tabId, u.state.doc.toString());
      }),
    ];

    const v = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host.current,
    });
    view.current = v;
    setActiveEditor(v);

    return () => {
      setActiveEditor(null);
      v.destroy();
      view.current = null;
    };
    // Recreating on tab switch is correct: each tab owns its own document and
    // undo history. `value` is intentionally not a dependency, otherwise every
    // keystroke would rebuild the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // `console` too: switching a tab between a SQL server and a key-value store
    // changes which language extension is loaded, and CodeMirror cannot be told
    // that without rebuilding the view. `appTheme` for the same reason: the
    // `dark` flag is fixed when the theme extension is built.
  }, [tabId, completionSchema, console, appTheme]);

  return <div ref={host} className="h-full overflow-hidden" />;
}
