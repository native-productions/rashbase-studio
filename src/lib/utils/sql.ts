/**
 * SQL generated for table tabs.
 *
 * Kept out of the store and the components so it can be read and tested as one
 * thing: this is the statement the user's table browsing actually runs, and a
 * quoting mistake here is a broken query at best.
 */

import { OP_LABEL, TEXTUAL_OPS } from "@/lib/constants/filters";
import { escapeLike, filterReady, inList } from "@/lib/utils/filters";
import type { Filter, Sort, StatementColumn } from "@/lib/types";

/**
 * Quotes an identifier. Mixed case, reserved words, and anything containing a
 * quote all survive the round trip; an embedded `"` is doubled, which is what
 * stops a column name from ending the identifier and starting a statement.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quotes a value as a string literal. The mirror of `quoteIdent`, and the only
 * place a value the user typed becomes part of a statement.
 *
 * An embedded `'` is doubled, which is what stops a value from ending the
 * literal and starting a statement. Backslashes need no handling because
 * `standard_conforming_strings` has been on by default since Postgres 9.1, so a
 * literal means exactly the characters it contains. A NUL cannot travel in
 * Postgres text at all, so it is dropped rather than sent to be rejected.
 */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/\0/g, "").replace(/'/g, "''")}'`;
}

const qualified = (schema: string, table: string) =>
  `${quoteIdent(schema)}.${quoteIdent(table)}`;

/**
 * Statements for the sidebar's copy actions.
 *
 * Placeholders are `$1, $2, …` rather than something ornamental, because that
 * is real Postgres parameter syntax: the copied statement can be pasted into a
 * driver and bound without editing it first.
 */
export function selectStatement(
  schema: string,
  table: string,
  columns: StatementColumn[],
): string {
  const list = columns.length === 0 ? "*" : columns.map((c) => quoteIdent(c.name)).join(", ");
  return `select ${list}\nfrom ${qualified(schema, table)}\nlimit 500;`;
}

export function insertStatement(
  schema: string,
  table: string,
  columns: StatementColumn[],
): string {
  const names = columns.map((c) => quoteIdent(c.name)).join(", ");
  const values = columns.map((_, i) => `$${i + 1}`).join(", ");
  return `insert into ${qualified(schema, table)} (${names})\nvalues (${values});`;
}

/**
 * Primary keys go in the `where`, everything else in the `set` — updating a key
 * by way of the row it identifies is not what anyone means by "copy as update".
 * A table without a primary key gets a commented `where` instead of a silent
 * statement that would rewrite every row.
 */
export function updateStatement(
  schema: string,
  table: string,
  columns: StatementColumn[],
): string {
  const keys = columns.filter((c) => c.primaryKey);
  const rest = columns.filter((c) => !c.primaryKey);
  const assignable = rest.length > 0 ? rest : columns;

  let n = 0;
  const sets = assignable.map((c) => `${quoteIdent(c.name)} = $${++n}`).join(",\n    ");
  const where =
    keys.length > 0
      ? keys.map((c) => `${quoteIdent(c.name)} = $${++n}`).join("\n  and ")
      : "-- no primary key on this table; add a condition before running";

  return `update ${qualified(schema, table)}\nset ${sets}\nwhere ${where};`;
}

/**
 * Neither statement gets `cascade`. If something depends on the object,
 * Postgres refuses and names the dependency, and that refusal is more useful
 * than quietly taking the dependency down too.
 */
export function dropStatement(schema: string, name: string, kind: string): string {
  const what =
    kind === "view" ? "view" : kind === "matview" ? "materialized view" : "table";
  return `drop ${what} ${qualified(schema, name)};`;
}

export function truncateStatement(schema: string, table: string): string {
  return `truncate table ${qualified(schema, table)};`;
}

/**
 * The pending cell write, as a sentence, for the status bar.
 *
 * The value stays `$1` because that is the truth: the backend binds it rather
 * than interpolating it, and a preview that showed the value spliced into the
 * statement would be describing something this application never does. The key
 * values are shown inline because they are already on screen in the row.
 *
 * Kept next to the read builders so both statements a table tab can produce are
 * readable, and testable, in one place.
 */
export function updatePreview({
  schema,
  table,
  column,
  keys,
}: {
  schema: string;
  table: string;
  column: string;
  keys: { column: string; value: string }[];
}): string {
  const where = keys
    .map((k) => `${quoteIdent(k.column)} = ${quoteLiteral(k.value)}`)
    .join(" and ");
  return `update ${quoteIdent(schema)}.${quoteIdent(table)} set ${quoteIdent(column)} = $1 where ${where}`;
}

// ---------------------------------------------------------------------------
// Row filters
// ---------------------------------------------------------------------------

/** One condition against one column. Assumes `filterReady`. */
function condition(f: Filter, column: string, asText: boolean): string {
  const ident = quoteIdent(column);
  const ref = asText || TEXTUAL_OPS.has(f.op) ? `(${ident})::text` : ident;
  const [a = "", b = ""] = f.values;

  switch (f.op) {
    // For these the label is the SQL operator, so there is nothing to look up.
    case "eq":
    case "neq":
    case "lt":
    case "gt":
    case "lte":
    case "gte":
      return `${ref} ${OP_LABEL[f.op]} ${quoteLiteral(a)}`;
    // A null check reads the column itself; casting it to text would change
    // nothing and only make the statement harder to read.
    case "isNull":
      return `${ident} is null`;
    case "isNotNull":
      return `${ident} is not null`;
    case "in":
      return `${ref} in (${inList(a).map(quoteLiteral).join(", ")})`;
    case "notIn":
      return `${ref} not in (${inList(a).map(quoteLiteral).join(", ")})`;
    case "like":
      return `${ref} like ${quoteLiteral(a)}`;
    case "ilike":
      return `${ref} ilike ${quoteLiteral(a)}`;
    case "contains":
      return `${ref} ilike ${quoteLiteral(`%${escapeLike(a)}%`)}`;
    case "notContains":
      return `${ref} not ilike ${quoteLiteral(`%${escapeLike(a)}%`)}`;
    case "between":
      return `${ref} between ${quoteLiteral(a)} and ${quoteLiteral(b)}`;
    case "notBetween":
      return `${ref} not between ${quoteLiteral(a)} and ${quoteLiteral(b)}`;
  }
}

/**
 * The body of a `where` clause, or null when nothing is complete enough to run.
 *
 * Filters are ANDed. An incomplete one contributes nothing rather than a guess:
 * a blank value, a half-typed `between`, or an `in` list that parses to nothing
 * would otherwise turn the page the user is reading into a syntax error.
 *
 * `columns` is only consulted to expand an "any column" filter.
 */
export function filterWhere(filters: Filter[], columns: string[]): string | null {
  const parts = filters.filter(filterReady).flatMap((f) => {
    if (f.column !== null) return [condition(f, f.column, false)];
    if (columns.length === 0) return [];
    // "Any column" means the condition holds for at least one of them, which is
    // an OR even when the op is a negative one. Every column is cast to text so
    // one condition can span a mixed set of types; that makes an ordering
    // comparison lexical, which is the honest reading of comparing a value
    // against columns whose types are not known to be comparable.
    return [`(${columns.map((c) => condition(f, c, true)).join(" or ")})`];
  });
  return parts.length === 0 ? null : parts.join(" and ");
}

export function tablePageSql({
  schema,
  table,
  sort,
  limit,
  offset,
  filters = [],
  columns = [],
}: {
  schema: string;
  table: string;
  sort?: Sort | null;
  limit: number;
  offset: number;
  filters?: Filter[];
  columns?: string[];
}): string {
  const parts = [`select * from ${quoteIdent(schema)}.${quoteIdent(table)}`];
  const where = filterWhere(filters, columns);
  if (where) parts.push(`where ${where}`);
  if (sort) parts.push(`order by ${quoteIdent(sort.column)} ${sort.dir}`);
  parts.push(`limit ${Math.trunc(limit)}`);
  // Omitted at zero so the first page of an unsorted table reads as the
  // obvious statement someone would have typed by hand.
  if (offset > 0) parts.push(`offset ${Math.trunc(offset)}`);
  return `${parts.join(" ")};`;
}

/**
 * Exact count under the same filters as the page.
 *
 * Only reached when the user asks for it: the planner's estimate describes the
 * whole table, and once a filter is on there is no cheap version of this answer.
 */
export function tableCountSql({
  schema,
  table,
  filters = [],
  columns = [],
}: {
  schema: string;
  table: string;
  filters?: Filter[];
  columns?: string[];
}): string {
  const where = filterWhere(filters, columns);
  const from = `select count(*) from ${quoteIdent(schema)}.${quoteIdent(table)}`;
  return where ? `${from} where ${where};` : `${from};`;
}
