/**
 * How the palette decides what a query matches.
 *
 * Postgres names things with underscores, and nobody types them. `aiproj` has
 * to find `ai_project`, which a substring test can never do, so the match is a
 * subsequence and the ranking is what keeps it useful: a subsequence match on
 * its own would put `a_p_i_r_o_j` above the table the user meant.
 */

/** Characters that start a new word in an identifier. */
const BOUNDARY = /[_\-. /:]/;

/** Separators dropped from the query, so `ai proj` and `ai_proj` are one thing. */
const NEEDLE_NOISE = /[\s_\-.]/g;

const CONSECUTIVE_BONUS = 8;
const BOUNDARY_BONUS = 10;
/** Charged per character skipped, so a match spread across the name ranks low. */
const GAP_PENALTY = 1;

/**
 * How well `needle` matches `haystack`, or `null` when it does not.
 *
 * Higher is better. An empty needle scores 0 rather than failing, which is what
 * lets "no query shows everything" stay one code path.
 */
export function fuzzyScore(needle: string, haystack: string): number | null {
  const query = needle.toLowerCase().replace(NEEDLE_NOISE, "");
  if (query.length === 0) return 0;

  const target = haystack.toLowerCase();
  let score = 0;
  let at = 0;
  let previous = -1;

  for (const char of query) {
    const found = target.indexOf(char, at);
    if (found === -1) return null;

    if (found === previous + 1) score += CONSECUTIVE_BONUS;
    if (found === 0 || BOUNDARY.test(target[found - 1] ?? "")) score += BOUNDARY_BONUS;
    score -= (found - at) * GAP_PENALTY;

    previous = found;
    at = found + 1;
  }

  // Two names that match equally well: the shorter one is the closer answer.
  return score - target.length * 0.1;
}
