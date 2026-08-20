import { useEffect, useMemo, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
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
import { PostgreSQL, schemaCompletionSource } from "@codemirror/lang-sql";
import {
  HighlightStyle,
  LanguageSupport,
  bracketMatching,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { caseAwareKeywords, catalogCompletion } from "@/components/editor/completion";
import { relationHighlight } from "@/components/editor/relationHighlight";
import { setActiveEditor } from "@/lib/activeEditor";
import { isKeyspaceDriver } from "@/lib/constants/connection";
import { useApp } from "@/store/app";

/**
 * Syntax colours come from the same tokens as the grid, so a `text` literal in
 * the editor and a text column in the results read as the same thing.
 */
const highlight = HighlightStyle.define([
  // 600 rather than 500: at 12px in a mono face, half a step of weight is not
  // a step. The keywords are the skeleton of a statement and they have to be
  // findable by shape alone, before the colour is read.
  { tag: [t.keyword, t.operatorKeyword], color: "var(--color-accent)", fontWeight: "600" },
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
  /*
    Why the editor cancels the root zoom, and pays for it in `calc`.

    The text size preference is `zoom` on `html` (see `prefs.ts` for why). In
    WebKit — which is the webview on macOS — `zoom` puts the page's own
    geometry and the pointer's in two different coordinate systems:
    `getBoundingClientRect` answers in unzoomed layout pixels while a pointer
    event reports itself in zoomed viewport pixels. Measured at `zoom: 0.9` on
    a 45-character line, the two disagreed by five characters; at 1.3, by
    twelve.

    Nothing is wrong with CodeMirror here. It maps a click by asking the
    browser where things are, and the browser gives two answers. So the editor
    takes itself out of the zoom the way the titlebar does, and scales its own
    type instead: inside this subtree the net zoom is 1 and the two answers are
    the same one.

    The cost is that every size in here that should follow the preference has
    to say so, which is what the `calc`s below are. `height` is deliberately
    not one of them — a percentage is resolved against the parent *after* this
    element's own zoom is accounted for, so `100%` already lands on the pane,
    and correcting it by hand scales it a second time.
  */
  "&": {
    height: "100%",
    zoom: "calc(1 / var(--ui-scale, 1))",
    fontSize: "calc(12px * var(--ui-scale, 1))",
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
    fontSize: "calc(12px * var(--ui-scale, 1))",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--color-accent-wash)",
    color: "var(--color-ink)",
  },
  /* The `on` clause a foreign-key suggestion would write, which is the reason
     to pick one option over another. Mono, because it is SQL and lines up with
     the editor it is about to be pasted into, and upright rather than
     CodeMirror's italic, which at 11px in a mono face is closer to a smudge
     than to emphasis. */
  ".cm-completionDetail": {
    fontFamily: "var(--font-mono)",
    fontSize: "calc(11px * var(--ui-scale, 1))",
    fontStyle: "normal",
    color: "var(--color-ink-faint)",
    marginLeft: "10px",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail": {
    color: "var(--color-ink-muted)",
  },
  /* CodeMirror marks a keyword with 🔑. Every other glyph in its set is a quiet
     mathematical letter — `𝑡` for a table, `□` for a column — and one emoji
     among them is the only colour in a list that is otherwise two greys and a
     yellow. Replaced with the letter form of its own scheme rather than
     dropped: the icon column is what tells a table apart from a keyword when
     neither carries a detail. */
  ".cm-completionIcon-keyword:after": { content: "'𝑘'" },
  ".cm-completionIcon": { opacity: "0.6" },
  /* A relation name. Painted by `relationHighlight` rather than by the
     highlight style, because the grammar reports a table and a column as the
     same kind of token and only position tells them apart. */
  ".cm-relation": { color: "var(--color-relation)" },
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
  /** Holds the language configuration, so it can be swapped without a rebuild. */
  const languageSlot = useRef(new Compartment());
  /**
   * The document the view and the store last agreed on.
   *
   * The two can be written from either end — the user types, or something puts
   * a statement in the tab — and without a record of the last agreement there
   * is no way to tell those apart. Comparing against the live document instead
   * would mean building the whole string on every keystroke.
   */
  const known = useRef(value);
  const setTabSql = useApp((s) => s.setTabSql);

  const appTheme = useApp((s) => s.prefs.theme);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const schemas = useApp((s) => s.schemas);
  const tables = useApp((s) => s.tables);
  const graphs = useApp((s) => s.graphs);

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

  /**
   * Tables and their columns, in the shape `lang-sql` completes from.
   *
   * The columns are what make `u.` answer anything: `lang-sql` resolves an
   * alias back to the table it was declared on, but only has something to
   * offer once the table's column list is here. They arrive with the schema
   * graph, which is fetched below and cached per connection, so a schema
   * nobody has opened contributes its table names and an empty list rather
   * than blocking the editor on a read.
   */
  const completionSchema = useMemo(() => {
    if (!activeConnectionId) return {};
    const out: Record<string, string[]> = {};
    for (const s of schemas[activeConnectionId] ?? []) {
      const graph = graphs[`${activeConnectionId}::${s.name}`];
      for (const table of tables[`${activeConnectionId}::${s.name}`] ?? []) {
        const columns = graph?.tables.find((t) => t.name === table.name)?.columns ?? [];
        out[s.name === "public" ? table.name : `${s.name}.${table.name}`] = columns.map(
          (c) => c.name,
        );
      }
    }
    return out;
  }, [activeConnectionId, schemas, tables, graphs]);

  /**
   * Reads the graph for the schemas the sidebar has opened.
   *
   * Only those: a server with two hundred schemas would otherwise be two
   * hundred catalogue reads to answer a completion nobody asked for. One call
   * per schema for the life of the connection, and the completion source falls
   * back to fetching on demand for anything else the user types.
   */
  useEffect(() => {
    if (!activeConnectionId) return;
    for (const s of schemas[activeConnectionId] ?? []) {
      if (tables[`${activeConnectionId}::${s.name}`]) {
        void useApp.getState().ensureGraph(activeConnectionId, s.name);
      }
    }
  }, [activeConnectionId, schemas, tables]);

  /**
   * The language half of the configuration, which is the half that changes
   * while the user is typing.
   *
   * Schemas, tables and graphs arrive over IPC seconds after a tab opens, and
   * rebuilding the view to take them would throw away the undo history and the
   * cursor mid-sentence. A compartment is CodeMirror's answer to that: the
   * rest of the configuration stays put and this is swapped in place.
   */
  const language = useMemo<Extension>(
    () =>
      console
        ? // A Redis command is not SQL, and the SQL grammar colours it wrongly:
          // `GET` is not a keyword, `user:1` is not an operator applied to a
          // number. Plain text is the honest rendering, and everything else
          // about the editor — the theme, the metrics, the keymap — stays as
          // it is.
          placeholder("One command per line, then ⌘⏎ to run. Select a line to run only that.")
        : [
            // Composed by hand rather than through `sql()`, which always
            // installs its own keyword source. Ours has to decide the case per
            // keystroke, and a second source alongside it would offer every
            // keyword twice.
            new LanguageSupport(PostgreSQL.language, [
              PostgreSQL.language.data.of({
                autocomplete: schemaCompletionSource({
                  dialect: PostgreSQL,
                  schema: completionSchema,
                }),
              }),
              PostgreSQL.language.data.of({ autocomplete: caseAwareKeywords }),
              PostgreSQL.language.data.of({ autocomplete: catalogCompletion(activeConnectionId) }),
            ]),
            relationHighlight,
            placeholder("Write SQL, then ⌘⏎ to run. Select a fragment to run only that."),
          ],
    [console, completionSchema, activeConnectionId],
  );

  useEffect(() => {
    view.current?.dispatch({ effects: languageSlot.current.reconfigure(language) });
  }, [language]);

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
      languageSlot.current.of(language),
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
        if (!u.docChanged) return;
        const text = u.state.doc.toString();
        known.current = text;
        setTabSql(tabId, text);
      }),
    ];

    const v = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host.current,
    });
    known.current = value;
    view.current = v;
    setActiveEditor(v);

    /*
      Geist Mono arrives after the first paint, and `ui-monospace` — what it
      swaps out of — is a different width. CodeMirror measures character
      metrics once on mount and keeps them, so the coordinates it maps a click
      to are the fallback font's until something asks it to look again. The
      symptom is a caret that lands short on a long line and further off the
      further right you click, which reads as the editor ignoring the pointer.
    */
    void document.fonts?.ready.then(() => view.current?.requestMeasure());

    return () => {
      setActiveEditor(null);
      v.destroy();
      view.current = null;
    };
    // Recreating on tab switch is correct: each tab owns its own document and
    // undo history. `value` is intentionally not a dependency, otherwise every
    // keystroke would rebuild the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // `appTheme` is here because the `dark` flag is fixed when the theme
    // extension is built and CodeMirror will not take a new one. `language` is
    // deliberately absent: it lives in a compartment and is swapped by the
    // effect above, which is what keeps a schema arriving mid-sentence from
    // costing the user their undo history.
  }, [tabId, appTheme]);

  /**
   * Takes a statement written into the tab by something other than typing.
   *
   * Opening a saved query is the case that needs it: it sets the tab's SQL,
   * and without this the editor kept showing whatever was there before — the
   * store and the screen disagreeing, silently, until the next keystroke wrote
   * the stale document back over the query that had just been loaded.
   *
   * Declared after the effect that builds the view so a tab switch is one
   * rebuild rather than a rebuild and a redundant write: the new view is
   * created with the new document, and this then sees nothing to do.
   */
  useEffect(() => {
    const v = view.current;
    if (!v || value === known.current) return;
    known.current = value;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: value },
      selection: { anchor: value.length },
    });
  }, [value]);

  return <div ref={host} className="h-full overflow-hidden" />;
}
