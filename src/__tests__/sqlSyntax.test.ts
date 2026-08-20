/**
 * Which identifier in a statement is a relation.
 *
 * Every failure here is silent. An alias painted as a table is a colour that
 * says the wrong thing; a `from` clause read one token wide offers a join onto
 * something the statement never named; and a keyword completion that answers
 * in the wrong case rewrites what the user just typed on Enter, which is the
 * bug that started this. None of those throw.
 */
import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { PostgreSQL } from "@codemirror/lang-sql";
import { caseAwareKeywords } from "@/components/editor/completion";
import { columnSuggestions, joinSuggestions } from "@/lib/utils/sqlCompletions";
import { defaultName } from "@/lib/savedQueries";
import {
  keywordBefore,
  relationRanges,
  relationsIn,
  scopeAt,
  sqlScopes,
  tokensBefore,
} from "@/lib/utils/sqlSyntax";
import type { GraphTable, Relation } from "@/lib/types";

const parse = (doc: string) => ({
  tree: PostgreSQL.language.parser.parse(doc),
  read: (from: number, to: number) => doc.slice(from, to),
});

/** Relation names, in order, as the painter would mark them. */
function names(doc: string): string[] {
  const { tree, read } = parse(doc);
  return relationRanges(tree, read).map((r) => doc.slice(r.from, r.to));
}

/** The relations in scope at the end of the document. */
function scope(doc: string) {
  const { tree, read } = parse(doc);
  const at = scopeAt(sqlScopes(tree, read), doc.length);
  if (!at) throw new Error("no scope");
  return relationsIn(tokensBefore(at, doc.length, doc.length));
}

test("a table is a relation and its alias is not", () => {
  expect(names("SELECT id FROM users u WHERE u.id = 1")).toEqual(["users"]);
  expect(names("SELECT id FROM users AS u")).toEqual(["users"]);
  expect(scope("SELECT id FROM users u")[0]).toMatchObject({
    name: "users",
    alias: "u",
    schema: null,
  });
});

test("a qualified name keeps its schema", () => {
  expect(names("SELECT * FROM public.users")).toEqual(["public.users"]);
  expect(scope("SELECT * FROM billing.invoices i")[0]).toMatchObject({
    schema: "billing",
    name: "invoices",
    alias: "i",
  });
});

test("a comma list is a list of relations, not one relation and an alias", () => {
  expect(names("SELECT * FROM a, b")).toEqual(["a", "b"]);
  expect(names("SELECT * FROM a x, b y")).toEqual(["a", "b"]);
});

test("every clause that can name a relation does", () => {
  expect(names("SELECT * FROM a LEFT JOIN b ON b.id = a.id")).toEqual(["a", "b"]);
  expect(names("UPDATE public.c SET k = 1")).toEqual(["public.c"]);
  expect(names("INSERT INTO e (a, b) VALUES (1, 2)")).toEqual(["e"]);
  expect(names("DELETE FROM f WHERE id = 1")).toEqual(["f"]);
});

test("a column is never a relation, however it is written", () => {
  // `b.id` and `a.id` are composite identifiers in exactly the shape a
  // qualified table name has, and only their position says otherwise.
  expect(names("SELECT a.id FROM a JOIN b ON b.a_id = a.id")).toEqual(["a", "b"]);
  expect(names("SELECT users FROM t")).toEqual(["t"]);
});

test("a derived table takes an alias rather than naming a relation", () => {
  expect(names("SELECT * FROM (SELECT id FROM inner_t) x JOIN b ON b.id = x.id")).toEqual([
    "inner_t",
    "b",
  ]);
});

test("a subquery's scope is its own", () => {
  const doc = "SELECT * FROM outer_t WHERE id IN (SELECT id FROM inner_t";
  const { tree, read } = parse(doc);
  const at = scopeAt(sqlScopes(tree, read), doc.length);
  expect(relationsIn(at!.tokens).map((r) => r.name)).toEqual(["inner_t"]);
});

test("the keyword behind the cursor is what decides which list is offered", () => {
  const check = (doc: string) => {
    const { tree, read } = parse(doc);
    const at = scopeAt(sqlScopes(tree, read), doc.length);
    return at && keywordBefore(at, doc.length, doc.length);
  };
  expect(check("SELECT * FROM users LEFT JOIN ")).toBe("JOIN");
  expect(check("SELECT * FROM users WHERE ")).toBe("WHERE");
  expect(check("SELECT * FROM users JOIN orders ON ")).toBe("ON");
  // An identifier, not a keyword: nothing is being asked for here.
  expect(check("SELECT * FROM users ")).toBe(null);
});

test("a half-typed name is not mistaken for a table already joined", () => {
  const doc = "SELECT * FROM users LEFT JOIN ord";
  const { tree, read } = parse(doc);
  const at = scopeAt(sqlScopes(tree, read), doc.length)!;
  const wordFrom = doc.length - "ord".length;
  expect(keywordBefore(at, doc.length, wordFrom)).toBe("JOIN");
  expect(relationsIn(tokensBefore(at, doc.length, wordFrom)).map((r) => r.name)).toEqual(["users"]);
});

// ---- joins --------------------------------------------------------------

const ORDERS: Relation = {
  name: "orders_user_id_fkey",
  table: "orders",
  columns: ["user_id"],
  refSchema: "public",
  refTable: "users",
  refColumns: ["id"],
};

test("a key pointing at the table in scope offers the table that holds it", () => {
  const suggestions = joinSuggestions(scope("SELECT * FROM users u"), [ORDERS], "public");
  expect(suggestions).toHaveLength(1);
  expect(suggestions[0]).toMatchObject({ table: "orders", outgoing: false });
  expect(suggestions[0]!.text).toBe("orders ON orders.user_id = u.id");
});

test("a key declared on the table in scope offers what it points at, and comes first", () => {
  const suggestions = joinSuggestions(scope("SELECT * FROM orders o"), [ORDERS], "public");
  expect(suggestions[0]!.text).toBe("users ON users.id = o.user_id");
  expect(suggestions[0]!.outgoing).toBe(true);
});

test("a table with no alias is joined by its own name", () => {
  const suggestions = joinSuggestions(scope("SELECT * FROM users"), [ORDERS], "public");
  expect(suggestions[0]!.text).toBe("orders ON orders.user_id = users.id");
});

test("a composite key joins on every column pair", () => {
  const composite: Relation = {
    name: "line_items_order_fkey",
    table: "line_items",
    columns: ["order_id", "tenant_id"],
    refSchema: "public",
    refTable: "orders",
    refColumns: ["id", "tenant_id"],
  };
  const suggestions = joinSuggestions(scope("SELECT * FROM orders o"), [composite], "public");
  expect(suggestions[0]!.text).toBe(
    "line_items ON line_items.order_id = o.id AND line_items.tenant_id = o.tenant_id",
  );
});

test("a self-join is aliased, because unqualified columns would be ambiguous", () => {
  const manager: Relation = {
    name: "employees_manager_fkey",
    table: "employees",
    columns: ["manager_id"],
    refSchema: "public",
    refTable: "employees",
    refColumns: ["id"],
  };
  const suggestions = joinSuggestions(scope("SELECT * FROM employees"), [manager], "public");
  expect(suggestions[0]!.text).toBe("employees employees_2 ON employees_2.id = employees.manager_id");
});

test("a key touching nothing in scope is not offered", () => {
  expect(joinSuggestions(scope("SELECT * FROM products"), [ORDERS], "public")).toEqual([]);
});

// ---- columns ------------------------------------------------------------

const USERS: GraphTable = {
  name: "users",
  kind: "table",
  comment: null,
  columns: [
    { name: "id", dataType: "integer", notNull: true, primaryKey: true },
    { name: "email", dataType: "text", notNull: true, primaryKey: false },
  ],
};

const ORDERS_TABLE: GraphTable = {
  name: "orders",
  kind: "table",
  comment: null,
  columns: [
    { name: "id", dataType: "integer", notNull: true, primaryKey: true },
    { name: "user_id", dataType: "integer", notNull: true, primaryKey: false },
  ],
};

test("one relation in scope means unqualified columns", () => {
  const columns = columnSuggestions(scope("SELECT * FROM users u WHERE"), [USERS, ORDERS_TABLE]);
  expect(columns.map((c) => c.label)).toEqual(["id", "email"]);
  expect(columns[0]).toMatchObject({ dataType: "integer", primaryKey: true, table: "users" });
});

test("two relations in scope means every column is qualified", () => {
  const doc = "SELECT * FROM users u JOIN orders o ON o.user_id = u.id WHERE";
  expect(columnSuggestions(scope(doc), [USERS, ORDERS_TABLE]).map((c) => c.label)).toEqual([
    "u.id",
    "u.email",
    "o.id",
    "o.user_id",
  ]);
});

test("a relation with no alias is qualified by its own name", () => {
  const doc = "SELECT * FROM users, orders WHERE";
  expect(columnSuggestions(scope(doc), [USERS, ORDERS_TABLE]).map((c) => c.label)).toEqual([
    "users.id",
    "users.email",
    "orders.id",
    "orders.user_id",
  ]);
});

test("a relation the graph does not know contributes nothing rather than a guess", () => {
  // A subquery alias, a function call and a table in another schema all look
  // like this from here.
  expect(columnSuggestions(scope("SELECT * FROM unknown_t WHERE"), [USERS])).toEqual([]);
});

// ---- saved queries ------------------------------------------------------

test("a default name is the statement on one line, cut where it stops fitting", () => {
  expect(defaultName("  select\n  *\nfrom users  ")).toBe("select * from users");
  expect(defaultName(`select ${"a".repeat(80)}`)).toHaveLength(37);
  expect(defaultName(`select ${"a".repeat(80)}`).endsWith("…")).toBe(true);
});

// ---- keyword case -------------------------------------------------------

/** What the keyword source would offer for a document ending mid-word. */
function keywords(doc: string, explicit = false): string[] {
  const state = EditorState.create({ doc, extensions: [PostgreSQL.language] });
  const result = caseAwareKeywords(new CompletionContext(state, doc.length, explicit));
  if (!result || result instanceof Promise) return [];
  return result.options.map((o) => o.label).filter((label) => /^sel/i.test(label));
}

test("a completion answers in the case the keystroke was in", () => {
  // The bug this exists for: accepting the first completion after typing
  // `SELECT` used to leave `select` in the editor.
  expect(keywords("SEL")).toContain("SELECT");
  expect(keywords("sel")).toContain("select");
  expect(keywords("Sel")).toContain("select");
  // Asked for with nothing typed, so there is nothing to contradict: upper
  // case, which is the convention the app's own generated SQL follows.
  expect(keywords("", true)).toContain("SELECT");
});
