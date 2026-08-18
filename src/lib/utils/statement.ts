/**
 * Deciding whether a statement the user typed can be wrapped for paging.
 *
 * Wrapping means running `select * from (<their sql>) _ limit n offset m`
 * instead of what they wrote, so the bar for saying yes is high: a wrong yes
 * either breaks a statement that worked or, worse, re-runs a write on every
 * page. Every check below defaults to *no*, and a false no costs only the
 * pager — the row cap still keeps the result set small.
 *
 * All of it works on a masked copy of the SQL, so a semicolon in a string
 * literal is not a second statement and the word "delete" in a comment is not
 * a write.
 */

/** Alias for the wrapping subquery. Long enough not to collide with a real one. */
const PAGE_ALIAS = "_rashbase_page";

/**
 * Replaces every comment and literal with spaces, keeping the string the same
 * length so offsets still line up with the original.
 *
 * Handles what Postgres actually lexes: line comments, *nestable* block
 * comments, `''`-escaped strings, `E''` strings where a backslash escapes,
 * `""` identifiers, and `$tag$` dollar quoting. Newlines survive so a line
 * comment still ends where it should.
 */
export function maskLiterals(sql: string): string {
  const out = sql.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  const isWordChar = (ch: string | undefined) => !!ch && /[A-Za-z0-9_]/.test(ch);

  /** Scans to the closing quote, honouring `''` and optionally a backslash. */
  const endOfQuoted = (start: number, quote: string, backslashEscapes: boolean) => {
    let j = start;
    while (j < sql.length) {
      if (backslashEscapes && sql[j] === "\\") {
        j += 2;
        continue;
      }
      if (sql[j] === quote) {
        // A doubled quote is a literal quote, not the end.
        if (sql[j + 1] === quote) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    // Unterminated. Everything to the end is inside the literal, which is what
    // Postgres would say too.
    return sql.length;
  };

  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (c === "-" && next === "-") {
      let j = i;
      while (j < sql.length && sql[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }

    if (c === "/" && next === "*") {
      // Postgres nests these, so a `/*` inside a comment opens another one.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (c === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        const j = close === -1 ? sql.length : close + tag.length;
        blank(i, j);
        i = j;
        continue;
      }
    }

    // `E'…'` only counts as an escape string when the E stands alone; in
    // `some_table'x'` the E is the tail of an identifier.
    const escapeString = (c === "e" || c === "E") && next === "'" && !isWordChar(sql[i - 1]);
    if (c === "'" || escapeString) {
      const j = endOfQuoted(escapeString ? i + 2 : i + 1, "'", escapeString);
      blank(i, j);
      i = j;
      continue;
    }

    if (c === '"') {
      const j = endOfQuoted(i + 1, '"', false);
      blank(i, j);
      i = j;
      continue;
    }

    i++;
  }

  return out.join("");
}

/** Every bare word in the statement, paired with its parenthesis depth. */
function words(masked: string): { word: string; depth: number }[] {
  const out: { word: string; depth: number }[] = [];
  let depth = 0;
  const token = /[()]|[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(masked)) !== null) {
    const t = m[0];
    if (t === "(") depth++;
    else if (t === ")") depth = Math.max(0, depth - 1);
    else out.push({ word: t.toLowerCase(), depth });
  }
  return out;
}

/** Statements that write. Inside a CTE they sit behind parentheses, so these
 *  are looked for at every depth, not just the top level. */
const WRITES = new Set(["insert", "update", "delete", "merge"]);

/**
 * Why this statement cannot be wrapped for paging, or null when it can.
 *
 * The string is shown to the user, so it reads as a reason rather than a code.
 */
export function unpageableReason(sql: string): string | null {
  const masked = maskLiterals(sql);

  // One trailing semicolon is punctuation, not a second statement.
  const body = masked.replace(/;\s*$/, "");
  if (body.trim() === "") return "there is no statement here";
  if (body.includes(";")) return "the script has more than one statement";

  const found = words(body);
  const leading = found[0]?.word ?? "";
  if (leading !== "select" && leading !== "with") {
    return `${leading.toUpperCase() || "This"} does not return a page of rows`;
  }

  const top = new Set(found.filter((w) => w.depth === 0).map((w) => w.word));
  if (top.has("limit") || top.has("offset") || top.has("fetch")) {
    return "the statement sets its own limit";
  }
  // `select … for update` cannot be a subquery: Postgres rejects it outright.
  // Checked before the write scan below, because the `update` in `for update`
  // is a locking mode rather than a write, and reporting it as one would send
  // the user looking for a write that is not there.
  if (top.has("for")) return "row locking cannot be paged";
  // `select … into t` creates a table rather than returning rows.
  if (top.has("into")) return "SELECT INTO writes a table rather than returning rows";

  // A data-modifying CTE runs its write once per execution. Paging one would
  // run the DELETE again on every click, which is the worst thing this
  // function could get wrong.
  if (found.some((w) => WRITES.has(w.word))) {
    return "the statement writes rows, so it must not be re-run per page";
  }

  return null;
}

/** Whether `pagedSql` may be used on this statement. */
export const pageable = (sql: string): boolean => unpageableReason(sql) === null;

/**
 * The statement without its trailing semicolon, and anything trailing it.
 *
 * Located through the mask, so `select 1; -- done` loses the semicolon that
 * would otherwise end up inside the subquery and break it.
 */
function withoutTrailingSemicolon(sql: string): string {
  const at = /;\s*$/.exec(maskLiterals(sql));
  return at ? sql.slice(0, at.index) : sql;
}

/**
 * One page of an arbitrary query.
 *
 * Only ever called on a statement `pageable` has approved. The user's SQL goes
 * in untouched, on its own lines, so the statement stays readable if it is ever
 * printed or logged.
 *
 * Paging an unordered query can repeat or skip a row between pages, because
 * without `order by` Postgres does not promise a stable order. That is true of
 * every table tab in this app as well, and forcing an order here would mean
 * choosing a column on the user's behalf.
 */
export function pagedSql(sql: string, limit: number, offset: number): string {
  const body = withoutTrailingSemicolon(sql).trim();
  const parts = [
    `select * from (\n${body}\n) as ${PAGE_ALIAS} limit ${Math.trunc(limit)}`,
  ];
  if (offset > 0) parts.push(`offset ${Math.trunc(offset)}`);
  return `${parts.join(" ")};`;
}
