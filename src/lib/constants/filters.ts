import type { FilterOp } from "@/lib/types";

/** How many values the op needs, which is also how many inputs the editor draws. */
export const OP_ARITY: Record<FilterOp, 0 | 1 | 2> = {
  eq: 1,
  neq: 1,
  lt: 1,
  gt: 1,
  lte: 1,
  gte: 1,
  in: 1,
  notIn: 1,
  like: 1,
  ilike: 1,
  between: 2,
  notBetween: 2,
  contains: 1,
  notContains: 1,
  isNull: 0,
  isNotNull: 0,
  matches: 1,
  prefix: 1,
};

/** What the user sees. Symbols where SQL has one, the keyword where it does not. */
export const OP_LABEL: Record<FilterOp, string> = {
  eq: "=",
  neq: "<>",
  lt: "<",
  gt: ">",
  lte: "<=",
  gte: ">=",
  in: "IN",
  notIn: "NOT IN",
  like: "LIKE",
  ilike: "ILIKE",
  between: "BETWEEN",
  notBetween: "NOT BETWEEN",
  contains: "CONTAINS",
  notContains: "NOT CONTAINS",
  isNull: "IS NULL",
  isNotNull: "IS NOT NULL",
  matches: "MATCHES",
  prefix: "PREFIX",
};

/**
 * The SQL vocabulary. `matches` and `prefix` are excluded: they describe a
 * glob a key-value store evaluates, and offering them against a Postgres column
 * would be an operator that produces no condition.
 */
export const FILTER_OPS = (Object.keys(OP_LABEL) as FilterOp[]).filter(
  (op) => op !== "matches" && op !== "prefix",
);

/**
 * What a keyspace can be narrowed by, in the order the editor lists them.
 *
 * Four rather than sixteen, because a flat namespace of opaque values supports
 * exactly four questions: does the key start with this, match this glob, hold
 * this text somewhere, or equal this exactly. Offering the SQL list here would
 * be fourteen operators that quietly match nothing.
 *
 * `prefix` first: it is the one people reach for, and `nvp:na:` is easier to
 * type correctly than `nvp:na:*`.
 */
export const KEY_FILTER_OPS: FilterOp[] = ["prefix", "matches", "contains", "eq"];

/** The two things a keyspace row can be filtered on, and what they cost. */
export const KEY_FILTER_COLUMNS: { value: string; label: string }[] = [
  { value: "key", label: "key" },
  { value: "value", label: "value · reads every key scanned" },
];

/** Ops that only mean anything against text, so the column is cast before use. */
export const TEXTUAL_OPS = new Set<FilterOp>(["like", "ilike", "contains", "notContains"]);
