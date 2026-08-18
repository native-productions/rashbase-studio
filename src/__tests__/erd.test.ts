import { expect, test } from "bun:test";
import {
  autoLayout,
  buildEdges,
  degrees,
  fkColumnSet,
  fkTargets,
  keyColumns,
  nodeHeight,
  tableNames,
} from "@/lib/erd";
import type { GraphColumn, GraphTable, Relation } from "@/lib/types";

const col = (name: string, primaryKey = false): GraphColumn => ({
  name,
  dataType: "text",
  notNull: false,
  primaryKey,
});

const table = (name: string, ...columns: GraphColumn[]): GraphTable => ({
  name,
  kind: "table",
  comment: null,
  columns,
});

const fk = (
  name: string,
  from: string,
  columns: string[],
  to: string,
  refColumns: string[],
  refSchema = "public",
): Relation => ({ name, table: from, columns, refSchema, refTable: to, refColumns });

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const NO_FKS = new Set<string>();

test("places every table exactly once", () => {
  const tables = ["a", "b", "c", "d", "e"].map((n) => table(n, col("id", true)));
  const placed = autoLayout(tables, [], NO_FKS, false);

  expect(placed).toHaveLength(5);
  expect(new Set(placed.map((p) => p.name))).toEqual(new Set(["a", "b", "c", "d", "e"]));
});

test("lays the same schema out the same way twice", () => {
  // A refresh must not move a table the user has learned where to find, so the
  // inputs are sorted before they reach the layout engine.
  const tables = [table("beta", col("id", true)), table("alpha", col("id", true))];
  const relations = [fk("f", "beta", ["a"], "alpha", ["id"])];
  const fks = fkColumnSet(relations);

  expect(autoLayout(tables, relations, fks, false)).toEqual(
    autoLayout(tables, relations, fks, false),
  );
});

test("puts a referencing table to the left of what it references", () => {
  // The whole point of ranking rather than gridding: direction is the thing
  // you should see first.
  const tables = [table("orders", col("id", true), col("user_id")), table("users", col("id", true))];
  const relations = [fk("f", "orders", ["user_id"], "users", ["id"])];
  const placed = autoLayout(tables, relations, fkColumnSet(relations), false);

  const at = (name: string) => placed.find((p) => p.name === name)!;
  expect(at("orders").x).toBeLessThan(at("users").x);
});

test("ranks a three-deep chain into three columns", () => {
  const tables = [
    table("items", col("id", true), col("order_id")),
    table("orders", col("id", true), col("user_id")),
    table("users", col("id", true)),
  ];
  const relations = [
    fk("a", "items", ["order_id"], "orders", ["id"]),
    fk("b", "orders", ["user_id"], "users", ["id"]),
  ];
  const placed = autoLayout(tables, relations, fkColumnSet(relations), false);

  const at = (name: string) => placed.find((p) => p.name === name)!;
  expect(at("items").x).toBeLessThan(at("orders").x);
  expect(at("orders").x).toBeLessThan(at("users").x);
});

test("does not stack keyless tables into one tall column", () => {
  // Dagre would put all six in rank 0, one under another, and stretch the
  // canvas past anything a window can show.
  const tables = ["a", "b", "c", "d", "e", "f"].map((n) => table(n, col("id", true)));
  const placed = autoLayout(tables, [], NO_FKS, false);

  expect(new Set(placed.map((p) => p.x)).size).toBeGreaterThan(1);
});

test("keeps a table that only points at itself in the ranked graph", () => {
  // A self reference ranks nothing, but it is still a key — the table belongs
  // with the graph and not in the block of keyless leftovers.
  const tables = [
    table("nodes", col("id", true), col("parent_id")),
    table("orphan", col("id", true)),
  ];
  const relations = [fk("self", "nodes", ["parent_id"], "nodes", ["id"])];
  const placed = autoLayout(tables, relations, fkColumnSet(relations), false);

  const at = (name: string) => placed.find((p) => p.name === name)!;
  expect(at("orphan").y).toBeGreaterThan(at("nodes").y);
});

test("survives a cycle rather than looping forever", () => {
  const tables = [table("a", col("id", true), col("b_id")), table("b", col("id", true), col("a_id"))];
  const relations = [
    fk("ab", "a", ["b_id"], "b", ["id"]),
    fk("ba", "b", ["a_id"], "a", ["id"]),
  ];
  const placed = autoLayout(tables, relations, fkColumnSet(relations), false);

  expect(placed).toHaveLength(2);
  expect(placed.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
});

test("a node's measured height matches what the node body renders", () => {
  // Layout sizes the boxes from this. If it disagrees with the component the
  // ranks either overlap or leave a corridor of dead space.
  const orders = table("orders", col("id", true), col("user_id"), col("total"), col("note"));
  const fks = fkColumnSet([fk("f", "orders", ["user_id"], "users", ["id"])]);

  // Header + id + user_id + the "2 more" line.
  expect(nodeHeight(orders, fks, false)).toBe(30 + 3 * 20);
  // Header + four columns, nothing hidden.
  expect(nodeHeight(orders, fks, true)).toBe(30 + 4 * 20);
});

test("counts a key against both ends", () => {
  const d = degrees([fk("f", "orders", ["user_id"], "users", ["id"])]);
  expect(d.get("orders")).toBe(1);
  expect(d.get("users")).toBe(1);
});

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

test("collapses several keys between the same pair into one edge", () => {
  // Three edges between the same two nodes are drawn on top of each other:
  // two of them cost the same to render as the one you can see.
  const relations = [
    fk("created_by", "orders", ["created_by"], "users", ["id"]),
    fk("updated_by", "orders", ["updated_by"], "users", ["id"]),
    fk("owned_by", "orders", ["owned_by"], "users", ["id"]),
  ];

  const edges = buildEdges(relations, new Set(["orders", "users"]));
  expect(edges).toHaveLength(1);
  // Nothing is lost but the overdraw: the label still names all three.
  expect(edges[0]!.label.split("\n")).toHaveLength(3);
  expect(edges[0]!.label).toContain("created_by");
  expect(edges[0]!.label).toContain("owned_by");
});

test("keeps the two directions between a pair apart", () => {
  const relations = [
    fk("a", "orders", ["user_id"], "users", ["id"]),
    fk("b", "users", ["last_order"], "orders", ["id"]),
  ];

  expect(buildEdges(relations, new Set(["orders", "users"]))).toHaveLength(2);
});

test("drops a key that points out of the schema", () => {
  // The target is not on the canvas, so an edge to it would end nowhere.
  const relations = [fk("f", "orders", ["tenant_id"], "tenants", ["id"], "billing")];

  expect(buildEdges(relations, new Set(["orders"]))).toEqual([]);
});

test("still marks a column whose edge was dropped", () => {
  // Otherwise a reference that leaves the schema reads as no reference at all.
  const relations = [fk("f", "orders", ["tenant_id"], "tenants", ["id"], "billing")];

  expect(fkColumnSet(relations).has("orders.tenant_id")).toBe(true);
  expect(fkTargets(relations).get("orders.tenant_id")).toBe("billing.tenants.id");
});

test("draws a self reference", () => {
  const relations = [fk("parent", "nodes", ["parent_id"], "nodes", ["id"])];
  const edges = buildEdges(relations, new Set(["nodes"]));

  expect(edges).toHaveLength(1);
  expect(edges[0]!.source).toBe("nodes");
  expect(edges[0]!.target).toBe("nodes");
});

test("pairs a composite key's columns in the order it was declared", () => {
  // `conkey` and `confkey` are positional. Pairing them wrongly is invisible on
  // screen and says the key points somewhere it does not.
  const relations = [fk("f", "line_items", ["tenant", "order"], "orders", ["tenant", "id"])];
  const targets = fkTargets(relations);

  expect(targets.get("line_items.tenant")).toBe("public.orders.tenant");
  expect(targets.get("line_items.order")).toBe("public.orders.id");
});

// ---------------------------------------------------------------------------
// What a collapsed node shows
// ---------------------------------------------------------------------------

test("a collapsed node shows its keys and nothing else", () => {
  const orders = table(
    "orders",
    col("id", true),
    col("user_id"),
    col("total"),
    col("status"),
    col("note"),
  );
  const fks = fkColumnSet([fk("f", "orders", ["user_id"], "users", ["id"])]);

  expect(keyColumns(orders, fks).map((c) => c.name)).toEqual(["id", "user_id"]);
});

test("a table with no keys collapses to nothing rather than everything", () => {
  const logs = table("logs", col("message"), col("level"));
  expect(keyColumns(logs, new Set())).toEqual([]);
});

test("names every table in the graph", () => {
  const graph = { tables: [table("a", col("id", true)), table("b")], relations: [] };
  expect(tableNames(graph)).toEqual(new Set(["a", "b"]));
});
