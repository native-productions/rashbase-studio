import type { DbError } from "@/lib/types";

/**
 * Every rejected command carries the same flat shape, so callers have one error
 * branch. Anything that reaches here without it came from the webview rather
 * than the backend, and is wrapped to look the same.
 */
export function asDbError(e: unknown): DbError {
  if (e && typeof e === "object" && "message" in e) return e as DbError;
  return { message: String(e), code: null, detail: null, hint: null, position: null };
}
