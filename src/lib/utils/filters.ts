import { OP_ARITY, OP_LABEL } from "@/lib/constants/filters";
import type { Filter } from "@/lib/types";

/** `IN ('a', 'b')` is typed as one field, because that is how people write a list. */
export const inList = (raw: string): string[] =>
  raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");

/**
 * Escapes the LIKE metacharacters so CONTAINS means "holds this literal text".
 *
 * LIKE and ILIKE deliberately skip this: there the value *is* a pattern, and
 * escaping it would leave the user no way to write one. That difference is the
 * whole reason both operators are offered.
 */
export const escapeLike = (v: string): string => v.replace(/([\\%_])/g, "\\$1");

/** True when the filter has everything its op needs to produce a condition. */
export function filterReady(f: Filter): boolean {
  const arity = OP_ARITY[f.op];
  if (arity === 0) return true;
  if (f.op === "in" || f.op === "notIn") return inList(f.values[0] ?? "").length > 0;
  return f.values.length >= arity && f.values.slice(0, arity).every((v) => v !== "");
}

/**
 * A blank filter, ready for the editor.
 *
 * "Any column" and CONTAINS because that is the filter you reach for without
 * knowing the schema, which is the state the editor most often opens in.
 */
let draftSeq = 0;
export const newFilter = (): Filter => ({
  id: `filter-${++draftSeq}`,
  column: null,
  op: "contains",
  values: [""],
});

/**
 * A blank keyspace filter.
 *
 * Opens on the key with a prefix, because that is both the filter people reach
 * for and the only cheap one: a value search reads every key the walk touches,
 * and defaulting to it would make the first filter anyone tries the slowest.
 */
export const newKeyFilter = (): Filter => ({
  id: `filter-${++draftSeq}`,
  column: "key",
  op: "prefix",
  values: [""],
});

/** What a chip says: the column, the operator, and the value as typed. */
export function summarizeFilter(f: Filter): { column: string; op: string; value: string } {
  const arity = OP_ARITY[f.op];
  return {
    column: f.column ?? "any column",
    op: OP_LABEL[f.op],
    value:
      arity === 0 ? "" : arity === 2 ? `${f.values[0]} … ${f.values[1]}` : (f.values[0] ?? ""),
  };
}
