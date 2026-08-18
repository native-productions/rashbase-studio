/**
 * Reading and rewriting a JSON document held in one cell.
 *
 * A `jsonb` payload is the one value in a result set that has structure the
 * grid cannot show, so it gets a tree instead of a line of text. Everything the
 * tree needs is here rather than in the component: paths, immutable writes, and
 * the one rule that decides what a typed leaf means.
 */

/** Where a node sits in the document. Strings index objects, numbers arrays. */
export type Path = (string | number)[];

export type JsonContainer = Record<string, unknown> | unknown[];

/**
 * The document in `text`, or `undefined` when there is no document.
 *
 * Only objects and arrays count. A `jsonb` column holding `5` or `"hi"` parses
 * fine and is still a scalar, and a tree drawn around one number is noise. The
 * first-character check is what keeps a text column full of digits from being
 * read as JSON at all.
 */
export function parseJson(text: string | null | undefined): JsonContainer | undefined {
  if (text === null || text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isContainer(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function isContainer(value: unknown): value is JsonContainer {
  return typeof value === "object" && value !== null;
}

export function getAt(root: unknown, path: Path): unknown {
  let node: unknown = root;
  for (const step of path) {
    if (!isContainer(node)) return undefined;
    node = (node as Record<string | number, unknown>)[step];
  }
  return node;
}

/**
 * `root` with `value` written at `path`, as a new document.
 *
 * Immutable because the tree is React state: mutating in place would leave the
 * node that changed rendering its old value until something else re-rendered
 * it. An empty path replaces the whole document.
 */
export function setAt(root: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) return value;
  const [step, ...rest] = path;
  if (!isContainer(root)) return root;

  if (Array.isArray(root)) {
    const index = Number(step);
    const next = root.slice();
    // Past the end is an append, which is how the tree adds an array item
    // without a second function that only differs in where it writes.
    next[index] = setAt(root[index], rest, value);
    return next;
  }
  const key = String(step);
  return { ...root, [key]: setAt((root as Record<string, unknown>)[key], rest, value) };
}

/** `root` with whatever is at `path` gone: a key deleted, an item spliced out. */
export function removeAt(root: unknown, path: Path): unknown {
  if (path.length === 0) return root;
  const [step, ...rest] = path;
  if (!isContainer(root)) return root;

  if (Array.isArray(root)) {
    const index = Number(step);
    if (rest.length === 0) return root.filter((_, i) => i !== index);
    const next = root.slice();
    next[index] = removeAt(root[index], rest);
    return next;
  }

  const key = String(step);
  const object = root as Record<string, unknown>;
  if (rest.length === 0) {
    const { [key]: _dropped, ...kept } = object;
    return kept;
  }
  return { ...object, [key]: removeAt(object[key], rest) };
}

/**
 * What a leaf typed into the tree means.
 *
 * `true` is a boolean, `12` is a number, `null` is null, and anything JSON
 * cannot read is the string the user typed. So the literal string "true" is
 * written as `"true"`, with the quotes — the same rule the browser console
 * uses, and the only one that keeps every JSON type reachable from a text
 * field.
 */
export function coerce(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A collapsed container, the way a console prints one. */
export function preview(value: JsonContainer): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  const keys = Object.keys(value);
  if (keys.length === 0) return "{}";
  const shown = keys
    .slice(0, 3)
    .map((k) => `${k}: ${scalarPreview(value[k])}`)
    .join(", ");
  return `{${shown}${keys.length > 3 ? ", …" : ""}}`;
}

function scalarPreview(value: unknown): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (isContainer(value)) return "{…}";
  return JSON.stringify(value) ?? String(value);
}
