/**
 * Turning a schema graph into something drawable.
 *
 * Pure: no React, no canvas component, no storage. Everything here is a
 * function of the graph the backend returned, which is what makes the parts
 * that are easy to get quietly wrong — composite key order, a pair of tables
 * joined by three keys, a reference that leaves the schema — testable without
 * a window.
 */

import dagre from "@dagrejs/dagre";
import type { GraphColumn, GraphTable, Relation, SchemaGraph } from "@/lib/types";

/** Node box metrics, shared with the node component so layout can size boxes. */
export const NODE_W = 232;
export const NODE_HEADER_H = 30;
export const NODE_ROW_H = 20;

/** Gaps between ranks and within one, in the laid-out direction. */
const RANK_GAP = 120;
const NODE_GAP = 40;
/** Orphans are packed into a block this many columns wide. */
const ORPHAN_COLS = 4;
const ORPHAN_GAP_X = 64;
const ORPHAN_GAP_Y = 48;

export interface Placed {
  name: string;
  x: number;
  y: number;
}

/** How many foreign keys touch a relation, in either direction. */
export function degrees(relations: Relation[]): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (name: string) => out.set(name, (out.get(name) ?? 0) + 1);
  for (const r of relations) {
    bump(r.table);
    bump(r.refTable);
  }
  return out;
}

/**
 * Which columns a node shows: its primary key and its foreign keys, unless the
 * user asked for all of them.
 *
 * Those are the columns the diagram is about. Everything else is what the
 * metadata panel is for, and rendering all of them by default is the difference
 * between three hundred DOM nodes and three thousand.
 */
export function keyColumns(table: GraphTable, fks: Set<string>): GraphColumn[] {
  return table.columns.filter((c) => c.primaryKey || fks.has(`${table.name}.${c.name}`));
}

/**
 * How tall a node renders. Must agree with `TableNode` exactly: layout that
 * assumes a different height leaves either overlap or a corridor of dead space
 * between every rank.
 */
export function nodeHeight(table: GraphTable, fks: Set<string>, expanded: boolean): number {
  const shown = expanded ? table.columns : keyColumns(table, fks);
  const hidden = table.columns.length - shown.length;
  return NODE_HEADER_H + (shown.length + (hidden > 0 ? 1 : 0)) * NODE_ROW_H;
}

/**
 * Where to put a relation nobody has dragged yet.
 *
 * Layered along the direction of the foreign keys, not scattered and not on a
 * grid. A grid is tidy and says nothing: neighbours in it are neighbours by
 * accident, so every edge is a line across the canvas and the shape of the
 * schema is invisible. Random placement is worse again — it is a grid with the
 * crossings turned up. Ranking by reference direction is what makes "what
 * points at what" the thing you see first, which is the only reason to draw a
 * schema rather than list it.
 *
 * Left to right, because the nodes are wider than they are tall and their
 * handles are on the sides: a referencing table sits to the left of what it
 * references, and every arrow runs the same way.
 *
 * Tables with no key in this schema are not part of that story. Dagre would
 * stack them into one very tall rank, so they are packed into a block under
 * the graph instead, where they are still findable and no longer stretch the
 * canvas past what a window can show.
 *
 * Deterministic: same schema, same picture. Inputs are sorted by name before
 * they reach dagre, so a refresh never moves a table the user has learned where
 * to find.
 */
export function autoLayout(
  tables: GraphTable[],
  relations: Relation[],
  fks: Set<string>,
  expanded: boolean,
): Placed[] {
  const present = new Set(tables.map((t) => t.name));
  const sorted = [...tables].sort((a, b) => a.name.localeCompare(b.name));

  // Only keys with both ends on the canvas rank anything. One pointing out of
  // the schema has no node to be ranked against.
  const edges = relations
    .filter((r) => present.has(r.table) && present.has(r.refTable) && r.table !== r.refTable)
    .map((r) => [r.table, r.refTable] as const)
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  // A self reference joins a table to itself and so ranks nothing, but it is
  // still a key: a table that only points at itself belongs in the graph.
  const linked = new Set<string>();
  for (const r of relations) {
    if (!present.has(r.table) || !present.has(r.refTable)) continue;
    linked.add(r.table);
    linked.add(r.refTable);
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", ranksep: RANK_GAP, nodesep: NODE_GAP, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const table of sorted) {
    if (!linked.has(table.name)) continue;
    g.setNode(table.name, { width: NODE_W, height: nodeHeight(table, fks, expanded) });
  }
  for (const [from, to] of edges) g.setEdge(from, to);

  dagre.layout(g);

  const out: Placed[] = [];
  let floor = 0;
  for (const table of sorted) {
    if (!linked.has(table.name)) continue;
    const node = g.node(table.name);
    if (!node) continue;
    // Dagre positions a node by its centre; React Flow places by top left.
    const y = node.y - node.height / 2;
    out.push({ name: table.name, x: node.x - node.width / 2, y });
    floor = Math.max(floor, y + node.height);
  }

  const orphans = sorted.filter((t) => !linked.has(t.name));
  if (orphans.length > 0) {
    let y = out.length > 0 ? floor + RANK_GAP : 0;
    for (let i = 0; i < orphans.length; i += ORPHAN_COLS) {
      const row = orphans.slice(i, i + ORPHAN_COLS);
      row.forEach((table, col) => {
        out.push({ name: table.name, x: col * (NODE_W + ORPHAN_GAP_X), y });
      });
      // Rows are as tall as their tallest node rather than uniformly tall: a
      // fixed row height pads every row to match the one wide table.
      y += Math.max(...row.map((t) => nodeHeight(t, fks, expanded))) + ORPHAN_GAP_Y;
    }
  }

  // Anything dagre dropped still needs a position; a node without one lands on
  // the origin under whatever is already there.
  for (const table of sorted) {
    if (!out.some((p) => p.name === table.name)) out.push({ name: table.name, x: 0, y: 0 });
  }
  return out;
}

export interface ErdEdge {
  id: string;
  source: string;
  target: string;
  /** Every key joining this pair, for the tooltip. */
  label: string;
}

/**
 * One edge per pair of relations, not one per constraint.
 *
 * Two tables joined by three foreign keys are three edges drawn on top of each
 * other: the extra two are invisible and cost the same to render as the one
 * you can see. They are collapsed into a single edge whose label names all
 * three, so nothing is lost but the overdraw.
 *
 * A key pointing outside `present` is dropped rather than drawn to a node that
 * is not on the canvas. The column is still marked in the node body by
 * `fkColumnSet`, so a reference that leaves the schema shows up as a marked
 * column with no edge rather than vanishing.
 */
export function buildEdges(relations: Relation[], present: Set<string>): ErdEdge[] {
  const byPair = new Map<string, { source: string; target: string; keys: string[] }>();
  for (const r of relations) {
    if (!present.has(r.table) || !present.has(r.refTable)) continue;
    const id = `${r.table}→${r.refTable}`;
    const entry = byPair.get(id) ?? { source: r.table, target: r.refTable, keys: [] };
    entry.keys.push(`${r.columns.join(", ")} → ${r.refTable}.${r.refColumns.join(", ")}`);
    byPair.set(id, entry);
  }
  return [...byPair].map(([id, e]) => ({
    id,
    source: e.source,
    target: e.target,
    label: e.keys.join("\n"),
  }));
}

/**
 * Which columns are the referencing half of a foreign key, as `table.column`.
 *
 * Built from every relation, including the ones `buildEdges` dropped: a column
 * pointing at another schema is still a foreign key, and the node marks it as
 * one whether or not there is an edge to follow.
 */
export function fkColumnSet(relations: Relation[]): Set<string> {
  const out = new Set<string>();
  for (const r of relations) {
    for (const column of r.columns) out.add(`${r.table}.${column}`);
  }
  return out;
}

/** What a foreign-key column points at, for the marker's tooltip. */
export function fkTargets(relations: Relation[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of relations) {
    r.columns.forEach((column, i) => {
      const target = r.refColumns[i] ?? r.refColumns[0] ?? "";
      out.set(`${r.table}.${column}`, `${r.refSchema}.${r.refTable}.${target}`);
    });
  }
  return out;
}

/** Every relation name in the graph, for the `present` set `buildEdges` wants. */
export const tableNames = (graph: SchemaGraph): Set<string> =>
  new Set(graph.tables.map((t) => t.name));
