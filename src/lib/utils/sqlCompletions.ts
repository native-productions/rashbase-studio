import type { GraphTable, Relation } from "@/lib/types";
import type { RelationRef } from "@/lib/utils/sqlSyntax";

/**
 * What the schema says could come next, at the two places in a statement where
 * that is a real question: after `join`, and where a column goes.
 *
 * The whole point is that the answer is not a guess: a key names both sides
 * and both column lists, so the `on` clause is copied out of the catalogue
 * rather than inferred from column names that happen to match. A schema with
 * no keys offers nothing here, which is honest — the generic table list is
 * still behind it.
 *
 * Both directions are offered. `orders` is reachable from `users` because
 * `orders.user_id` points at it, and that key is stored on `orders`, so
 * looking only at the keys declared on the table in scope would answer half
 * the question.
 */

export interface JoinSuggestion {
  /** Relation to join to. */
  table: string;
  schema: string;
  /** The whole insertion, e.g. `orders ON orders.user_id = u.id`. */
  text: string;
  /** The key it came from, for the completion's second line. */
  via: string;
  /** True when the key is declared on the table already in scope. */
  outgoing: boolean;
}

/**
 * Builds one suggestion per foreign key touching a relation in scope.
 *
 * `scope` is what the statement has named so far; `relations` is every key in
 * the schema. Aliases are honoured but never invented — a table joined here
 * arrives unaliased, because a generated short name is a name the user has to
 * read and correct. The one exception is a name already in scope, where an
 * alias is not decoration but the only way the `on` clause means anything.
 */
export function joinSuggestions(
  scope: RelationRef[],
  relations: Relation[],
  defaultSchema: string,
): JoinSuggestion[] {
  const out: JoinSuggestion[] = [];
  const seen = new Set<string>();
  const taken = new Set(scope.flatMap((r) => [r.name, ...(r.alias ? [r.alias] : [])]));

  for (const here of scope) {
    const lhs = here.alias ?? here.name;

    for (const relation of relations) {
      const outgoing = relation.table === here.name;
      const incoming = relation.refTable === here.name;
      if (!outgoing && !incoming) continue;

      // Which side of the key is the new table, and which columns pair up.
      const table = outgoing ? relation.refTable : relation.table;
      const schema = outgoing ? relation.refSchema : defaultSchema;
      const newColumns = outgoing ? relation.refColumns : relation.columns;
      const hereColumns = outgoing ? relation.columns : relation.refColumns;
      if (newColumns.length === 0 || newColumns.length !== hereColumns.length) continue;

      // A self-join, or a second table with a name already in the statement.
      // Unqualified columns would be ambiguous, so this is the one place a
      // name is generated.
      const rhs = taken.has(table) ? unique(table, taken) : table;

      const pairs = newColumns.map((column, i) => `${rhs}.${column} = ${lhs}.${hereColumns[i]}`);
      const text = `${rhs === table ? table : `${table} ${rhs}`} ON ${pairs.join(" AND ")}`;
      if (seen.has(text)) continue;
      seen.add(text);

      out.push({
        table,
        schema,
        text,
        via: relation.columns.map((c, i) => `${relation.table}.${c} → ${relation.refTable}.${relation.refColumns[i]}`).join(", "),
        outgoing,
      });
    }
  }

  // Outgoing first: a key declared on the table you are looking at is the join
  // you meant more often than one declared on something pointing back at it.
  return out.sort((a, b) => Number(b.outgoing) - Number(a.outgoing) || a.table.localeCompare(b.table));
}

/** `orders` → `orders_2`, and keeps going while the name is still taken. */
function unique(base: string, taken: Set<string>): string {
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}


export interface ColumnSuggestion {
  /** What gets inserted: `u.total` where it has to be qualified, `total` where it does not. */
  label: string;
  column: string;
  table: string;
  dataType: string;
  primaryKey: boolean;
}

/**
 * The columns reachable from the relations a statement has already named.
 *
 * Qualified only when there is more than one relation in scope. With one
 * table, `users.id` is three tokens saying what `id` says, and the completion
 * that writes it makes every `where` clause longer than the user would have
 * typed by hand.
 *
 * A relation the graph does not know contributes nothing rather than a guess:
 * a subquery, a function call and a table in another schema all look the same
 * from here, and inventing column names for them is worse than staying quiet.
 */
export function columnSuggestions(
  scope: RelationRef[],
  tables: GraphTable[],
): ColumnSuggestion[] {
  const qualify = scope.length > 1;
  const out: ColumnSuggestion[] = [];
  const seen = new Set<string>();

  for (const here of scope) {
    const table = tables.find((t) => t.name === here.name);
    if (!table) continue;
    const prefix = qualify ? `${here.alias ?? here.name}.` : "";

    for (const column of table.columns) {
      const label = `${prefix}${column.name}`;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push({
        label,
        column: column.name,
        table: here.name,
        dataType: column.dataType,
        primaryKey: column.primaryKey,
      });
    }
  }

  return out;
}
