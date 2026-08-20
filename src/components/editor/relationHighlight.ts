import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView } from "@codemirror/view";
import { relationRanges } from "@/lib/utils/sqlSyntax";

/**
 * Paints relation names differently from every other identifier.
 *
 * A decoration rather than a highlight-style tag, because the grammar has no
 * tag to hang it on: `users` and `user_id` are both `Identifier`, and the
 * difference is where they sit. `sqlSyntax` works that out; this only draws
 * the answer.
 */
const RELATION = Decoration.mark({ class: "cm-relation" });

function build(view: EditorView): DecorationSet {
  const tree = syntaxTree(view.state);
  const read = (from: number, to: number) => view.state.doc.sliceString(from, to);
  const builder = new RangeSetBuilder<Decoration>();
  let last = -1;

  for (const range of view.visibleRanges) {
    // Widened to the whole statement. A `from` scrolled off the top is still
    // what makes the name below it a table, so parsing only what is on screen
    // would drop the colour of the very rows being read.
    for (const relation of relationRanges(tree, read, statementStart(view, range.from), range.to)) {
      // Two visible ranges can overlap one statement, and `RangeSetBuilder`
      // requires strictly increasing positions.
      if (relation.from <= last) continue;
      builder.add(relation.from, relation.to, RELATION);
      last = relation.from;
    }
  }

  return builder.finish();
}

function statementStart(view: EditorView, pos: number): number {
  let node = syntaxTree(view.state).resolveInner(pos, 1);
  while (node.name !== "Statement" && node.parent) node = node.parent;
  return node.name === "Statement" ? node.from : pos;
}

export const relationHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: { docChanged: boolean; viewportChanged: boolean; view: EditorView }) {
      if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
