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
};

export const FILTER_OPS = Object.keys(OP_LABEL) as FilterOp[];

/** Ops that only mean anything against text, so the column is cast before use. */
export const TEXTUAL_OPS = new Set<FilterOp>(["like", "ilike", "contains", "notContains"]);
