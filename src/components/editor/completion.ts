import { syntaxTree } from "@codemirror/language";
import { PostgreSQL, keywordCompletionSource } from "@codemirror/lang-sql";
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { columnSuggestions, joinSuggestions } from "@/lib/utils/sqlCompletions";
import {
  keywordBefore,
  relationsIn,
  scopeAt,
  sqlScopes,
  tokensBefore,
} from "@/lib/utils/sqlSyntax";
import { useApp } from "@/store/app";

/**
 * Keyword completion that answers in the case the user is already typing.
 *
 * `upperCaseKeywords` is one flag decided when the extension is built, so
 * whichever way it is set, half the time accepting a completion rewrites what
 * was just typed: with it off, `SELECT` became `select` on Enter. The case is
 * a property of the keystroke, not of the editor, so it is read per request.
 * An empty or all-caps prefix takes upper case, which is the convention this
 * editor's own generated SQL follows.
 */
const UPPER = keywordCompletionSource(PostgreSQL, true);
const LOWER = keywordCompletionSource(PostgreSQL, false);

export const caseAwareKeywords: CompletionSource = (context) => {
  const word = context.matchBefore(/[\w$]+/);
  return (word && /[a-z]/.test(word.text) ? LOWER : UPPER)(context);
};

/** Keywords a column can follow. */
const BEFORE_COLUMN = new Set(["SELECT", "WHERE", "AND", "OR", "ON", "HAVING", "BY"]);

/**
 * What the connected schema says could come next.
 *
 * Two questions, one source, because they need the same three things: the
 * relations the statement has already named, the keyword the cursor is behind,
 * and the schema graph. After `join` the answer is a table and the foreign key
 * that reaches it; after `where` — or `and`, `on`, `select`, `order by` — it is
 * a column of something already in the statement.
 *
 * Both refuse when the statement has named no relation yet. A column list with
 * nothing to hang it on is the whole schema, which is what the plain
 * identifier completion is already for.
 *
 * The popup is CodeMirror's own: arrow keys, click and scroll come with it,
 * and it is already themed. The graph is fetched on demand and cached for the
 * life of the connection. Awaiting it stalls the first popup by one round trip
 * on a schema nobody has opened yet; returning early instead would show a list
 * that silently lacks the keys, which is worse than a pause.
 */
export function catalogCompletion(connectionId: string | null): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    if (!connectionId) return null;

    const word = context.matchBefore(/[\w$]*/);
    const from = word?.from ?? context.pos;
    const read = (a: number, b: number) => context.state.doc.sliceString(a, b);

    const scope = scopeAt(sqlScopes(syntaxTree(context.state), read), context.pos);
    if (!scope) return null;

    const keyword = keywordBefore(scope, context.pos, from);
    if (keyword !== "JOIN" && !BEFORE_COLUMN.has(keyword ?? "")) return null;

    const inScope = relationsIn(tokensBefore(scope, context.pos, from));
    if (inScope.length === 0) return null;

    const schema = schemaFor(connectionId, inScope[0]!.schema, inScope[0]!.name);
    const graph = await useApp.getState().ensureGraph(connectionId, schema);
    if (!graph) return null;

    const options =
      keyword === "JOIN"
        ? joinOptions(inScope, graph.relations, schema)
        : columnOptions(inScope, graph.tables);
    if (options.length === 0) return null;

    return { from, options, validFor: /^[\w.]*$/ };
  };
}

function joinOptions(
  scope: Parameters<typeof joinSuggestions>[0],
  relations: Parameters<typeof joinSuggestions>[1],
  schema: string,
): Completion[] {
  return joinSuggestions(scope, relations, schema).map((suggestion, i) => ({
    label: suggestion.table,
    // The `on` clause, which is the part worth reading before choosing.
    detail: suggestion.text.slice(suggestion.text.indexOf(" ON ") + 1),
    info: suggestion.via,
    // The same icon `lang-sql` gives a table, so the two halves of the list do
    // not read as two different kinds of thing.
    type: "type",
    apply: suggestion.text,
    boost: 99 - i,
  }));
}

function columnOptions(
  scope: Parameters<typeof columnSuggestions>[0],
  tables: Parameters<typeof columnSuggestions>[1],
): Completion[] {
  return columnSuggestions(scope, tables).map((suggestion, i) => ({
    label: suggestion.label,
    detail: suggestion.primaryKey ? `${suggestion.dataType} · pk` : suggestion.dataType,
    // No `info`. The label already carries the alias, and CodeMirror draws
    // that panel as a second floating box beside the list — a whole surface
    // for one word the user typed themselves two clauses ago.
    type: "property",
    // Ahead of the keyword list. Every one of these positions can also take a
    // keyword, and there are hundreds of those against a handful of columns
    // that are actually in the statement.
    boost: 99 - i,
  }));
}

/**
 * Which schema to read the graph from.
 *
 * What the statement wrote wins. Otherwise the sidebar already knows where a
 * table by that name was found, and `public` is the fallback because that is
 * where an unqualified name resolves on a default `search_path`.
 */
function schemaFor(connectionId: string, written: string | null, table: string): string {
  if (written) return written;
  const { tables } = useApp.getState();
  for (const [key, entries] of Object.entries(tables)) {
    const [id, schema] = key.split("::");
    if (id !== connectionId || !schema) continue;
    if (entries.some((e) => e.name === table)) return schema;
  }
  return "public";
}
