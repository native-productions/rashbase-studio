/**
 * Picking a run of rows out of a list, the way a file manager does.
 *
 * Kept out of the sidebar because the interesting part is not React: it is that
 * the range runs over what is *visible*, so a filtered or collapsed tree
 * selects what the user can see rather than what the data happens to contain.
 */

/**
 * The inclusive run between the anchor and the row just clicked.
 *
 * `order` is the flat list of selectable rows as drawn, top to bottom. Without
 * an anchor, or with one that has since been filtered away, the answer is the
 * single row clicked — a shift-click that silently selects nothing would look
 * like the modifier being ignored.
 */
export function rangeBetween(order: string[], anchor: string | null, target: string): string[] {
  const to = order.indexOf(target);
  if (to === -1) return [];

  const from = anchor === null ? -1 : order.indexOf(anchor);
  if (from === -1) return [target];

  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return order.slice(lo, hi + 1);
}

/** Adds or removes one row, leaving the rest of the selection alone. */
export function toggle(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
}
