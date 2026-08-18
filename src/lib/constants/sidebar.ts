import type { DbObject, FunctionEntry, TableEntry } from "@/lib/types";

export const KIND_GLYPH: Record<DbObject["kind"], string> = {
  table: "▤",
  view: "◫",
  matview: "◲",
  foreign: "◈",
  other: "▫",
  function: "ƒ",
  diagram: "◇",
};

/** Schema-less object, before the schema it lives in is attached. */
export type SidebarMember = Omit<DbObject, "schema"> & {
  comment?: string | null;
  signature?: string;
  /** Shown instead of `name` where the relation's own name is jargon. */
  label?: string;
};

/**
 * Tables, views, and functions read as three different kinds of thing, so they
 * are listed as three, in the order you are most likely to want them.
 */
export const OBJECT_GROUPS: {
  label: string;
  pick: (t: TableEntry[], f: FunctionEntry[]) => SidebarMember[];
}[] = [
  {
    label: "Tables",
    pick: (tables) =>
      tables
        .filter((t) => t.kind === "table" || t.kind === "foreign" || t.kind === "other")
        .map((t) => ({ name: t.name, kind: t.kind, comment: t.comment })),
  },
  {
    label: "Views",
    pick: (tables) =>
      tables
        .filter((t) => t.kind === "view" || t.kind === "matview")
        .map((t) => ({ name: t.name, kind: t.kind, comment: t.comment })),
  },
  {
    label: "Functions",
    pick: (_tables, functions) =>
      functions.map((f) => ({
        name: f.name,
        kind: "function" as const,
        oid: f.oid,
        signature: `${f.name}(${f.args}) → ${f.returns}`,
      })),
  },
];
