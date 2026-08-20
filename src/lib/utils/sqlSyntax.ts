import type { Tree } from "@lezer/common";

/**
 * Where the relations are in a statement, read off the parsed tree.
 *
 * The SQL grammar does not distinguish a table from a column: both arrive as
 * `Identifier`, and `select id from users` is four tokens of the same kind.
 * Position is the only thing that separates them, so this walks the token
 * stream and answers "which identifiers sit where a relation can sit".
 *
 * Two readers, one walk. The editor paints those ranges a different colour,
 * and the JOIN completion needs the same list to know what a foreign key
 * could be joined *to*. Matching identifiers against the sidebar's table list
 * instead would have been shorter and wrong: a column named `users` is a
 * column, and there is no query where the two readings are both useful.
 */

export interface SqlToken {
  /** Lezer node name: `Keyword`, `Identifier`, `CompositeIdentifier`, `Parens`… */
  name: string;
  from: number;
  to: number;
  text: string;
}

/** One statement, or one parenthesised group inside it. */
export interface SqlScope {
  from: number;
  to: number;
  tokens: SqlToken[];
}

export interface RelationRef {
  /** Qualifier when the statement wrote one, e.g. `public` in `public.users`. */
  schema: string | null;
  name: string;
  alias: string | null;
  /** Range of the name itself, which is what gets painted. */
  from: number;
  to: number;
}

/** Nodes that hold other tokens rather than being one. */
const CONTAINERS = new Set(["Statement", "Parens", "Brackets", "Braces"]);

/** Keywords after which the next identifier names a relation. */
const BEFORE_RELATION = new Set(["FROM", "JOIN", "INTO", "UPDATE", "TABLE"]);

const IDENTIFIER = new Set(["Identifier", "QuotedIdentifier", "CompositeIdentifier"]);

/**
 * Splits the tree into one token list per statement and per parenthesised
 * group, without descending into a `CompositeIdentifier`.
 *
 * Parens are a scope of their own *and* a token in the scope above, which is
 * what makes `from (select …) x` read correctly at both levels: the subquery
 * gets its own `from` to walk, and the outer level sees a relation-shaped
 * thing followed by its alias rather than a bare identifier called `x`.
 *
 * `read` rather than the whole document, so the editor can hand over a slice
 * of a large buffer and the tests can hand over a string.
 */
export function sqlScopes(
  tree: Tree,
  read: (from: number, to: number) => string,
  from = 0,
  to = Number.MAX_SAFE_INTEGER,
): SqlScope[] {
  const scopes: SqlScope[] = [];
  const stack: SqlScope[] = [];

  tree.iterate({
    from,
    to: Math.min(to, tree.length),
    enter(node) {
      if (node.name === "Script") return true;

      const parent = stack[stack.length - 1];
      if (parent) {
        parent.tokens.push({
          name: node.name,
          from: node.from,
          to: node.to,
          text: read(node.from, node.to),
        });
      }

      if (!CONTAINERS.has(node.name)) return false;
      const scope: SqlScope = { from: node.from, to: node.to, tokens: [] };
      scopes.push(scope);
      stack.push(scope);
      return true;
    },
    leave(node) {
      if (CONTAINERS.has(node.name)) stack.pop();
    },
  });

  return scopes;
}

/**
 * The relations named in one scope, in the order they appear.
 *
 * A four-state walk, because every state answers a different question:
 * whether the next identifier is a relation, whether it is that relation's
 * alias, and whether a comma has started the list over. Without the alias
 * states, `from users u` reports two relations and paints the alias.
 */
export function relationsIn(tokens: SqlToken[]): RelationRef[] {
  const out: RelationRef[] = [];
  let mode: "scan" | "relation" | "alias" | "done" = "scan";

  for (const token of tokens) {
    if (token.name === "Keyword") {
      const word = token.text.toUpperCase();
      if (BEFORE_RELATION.has(word)) {
        mode = "relation";
      } else if (word === "AS" && mode === "alias") {
        // `from users as u`: the alias is still coming.
      } else {
        mode = "scan";
      }
      continue;
    }

    if (mode === "relation") {
      if (IDENTIFIER.has(token.name)) {
        out.push({ ...split(token.text), alias: null, from: token.from, to: token.to });
        mode = "alias";
      } else if (token.name === "Parens") {
        // A derived table. It names no relation, but it still takes an alias,
        // and treating that alias as a relation is how `(select …) x` would
        // otherwise paint `x`.
        mode = "alias";
      } else {
        mode = "scan";
      }
      continue;
    }

    if (mode === "alias" || mode === "done") {
      if (token.name === "Punctuation" && token.text === ",") {
        mode = "relation";
      } else if (mode === "alias" && token.name === "Identifier") {
        const last = out[out.length - 1];
        if (last) last.alias = token.text;
        mode = "done";
      } else {
        mode = "scan";
      }
    }
  }

  return out;
}

/** Every relation in the parsed range, sorted, which is what the painter needs. */
export function relationRanges(
  tree: Tree,
  read: (from: number, to: number) => string,
  from?: number,
  to?: number,
): RelationRef[] {
  return sqlScopes(tree, read, from, to)
    .flatMap((scope) => relationsIn(scope.tokens))
    .sort((a, b) => a.from - b.from);
}

/**
 * The innermost scope holding `pos`, which is the one a completion is being
 * asked for. A join offered inside a subquery is a join onto that subquery's
 * own tables, not onto the outer statement's.
 */
export function scopeAt(scopes: SqlScope[], pos: number): SqlScope | null {
  let best: SqlScope | null = null;
  for (const scope of scopes) {
    if (pos < scope.from || pos > scope.to) continue;
    if (!best || scope.from >= best.from) best = scope;
  }
  if (best) return best;

  // Nothing contains the cursor, which is what a trailing space looks like: a
  // statement's range stops at its last token, and `from users join ` puts the
  // caret one character past the end of everything. Falling back to the last
  // scope that closed before it is the difference between offering a join and
  // offering nothing at the exact moment the user is asking for one.
  for (const scope of scopes) {
    if (scope.to > pos) continue;
    if (!best || scope.to > best.to || (scope.to === best.to && scope.from > best.from)) {
      best = scope;
    }
  }
  return best;
}

/**
 * The keyword the cursor is sitting behind, upper-cased, or null.
 *
 * What decides whether a completion is being asked for a table (`join `) or a
 * column (`where `). `wordFrom` is where the identifier being typed starts, so
 * a half-written name is not read as the token before the cursor — and, in the
 * same move, is not mistaken for a table already in the statement.
 */
export function keywordBefore(scope: SqlScope, pos: number, wordFrom: number): string | null {
  const last = tokensBefore(scope, pos, wordFrom).at(-1);
  return last?.name === "Keyword" ? last.text.toUpperCase() : null;
}

/** Tokens fully behind the cursor, minus the one being typed. */
export function tokensBefore(scope: SqlScope, pos: number, wordFrom: number): SqlToken[] {
  return scope.tokens.filter((t) => t.to <= pos && t.from < wordFrom);
}

/** `public.users` → schema `public`, name `users`. A bare name has no schema. */
function split(text: string): { schema: string | null; name: string } {
  const dot = text.lastIndexOf(".");
  if (dot < 0) return { schema: null, name: unquote(text) };
  return { schema: unquote(text.slice(0, dot)), name: unquote(text.slice(dot + 1)) };
}

const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);
