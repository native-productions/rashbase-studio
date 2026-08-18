import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { KIND_GLYPH } from "@/lib/constants/sidebar";
import { NODE_W, keyColumns } from "@/lib/erd";
import type { GraphTable } from "@/lib/types";

/**
 * One relation on the canvas.
 *
 * `memo`, and it is not decoration: dragging one node re-renders the flow on
 * every pointer move, and without this every other node re-renders with it.
 * The data this reads is built once per graph and never mutated, so the default
 * shallow comparison is enough.
 *
 * Collapsed by default to its keys — the columns the diagram is actually about.
 * A hundred tables averaging thirty columns is three thousand rows to lay out
 * and paint; the same hundred showing two keys each is three hundred. The rest
 * are a click away in the metadata panel, which is where you go when you want
 * a column's type rather than its shape.
 */

export interface TableNodeData extends Record<string, unknown> {
  table: GraphTable;
  /** `table.column` for every referencing side of a foreign key. */
  fks: Set<string>;
  /** `table.column` to the qualified name it points at, for the tooltip. */
  targets: Map<string, string>;
  expanded: boolean;
  selected: boolean;
}

function TableNodeImpl({ data }: NodeProps & { data: TableNodeData }) {
  const { table, fks, targets, expanded, selected } = data;
  const shown = expanded ? table.columns : keyColumns(table, fks);
  const hidden = table.columns.length - shown.length;

  return (
    <div
      style={{ width: NODE_W }}
      // `bg-canvas`, not `bg-raised`: the canvas is the one surface whose
      // legibility may not depend on the desktop showing through the window.
      className={[
        "overflow-hidden rounded-md border bg-canvas font-mono text-[11px] shadow-lg shadow-black/30",
        selected ? "border-accent" : "border-line",
      ].join(" ")}
    >
      {/* Node-level handles, not one per column. Per-column anchors route a
          little more precisely and multiply the DOM by the column count. */}
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-line" />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-1.5 !w-1.5 !border-0 !bg-line"
      />

      <div
        className="flex h-[30px] items-center gap-1.5 border-b border-line-soft bg-raised px-2"
        title={table.comment ?? undefined}
      >
        <span aria-hidden="true" className="shrink-0 text-ink-faint">
          {KIND_GLYPH[table.kind]}
        </span>
        <span className="truncate font-sans text-[12px] font-medium text-ink">{table.name}</span>
      </div>

      {shown.map((col) => {
        const isFk = fks.has(`${table.name}.${col.name}`);
        return (
          <div key={col.name} className="flex h-5 items-center gap-1.5 px-2">
            <span
              aria-hidden="true"
              className={[
                "w-2 shrink-0 text-[9px]",
                col.primaryKey ? "text-accent" : isFk ? "text-bool" : "text-transparent",
              ].join(" ")}
              // A key pointing outside this schema has no edge to follow, so
              // the marker is the only place that can say where it goes.
              title={
                col.primaryKey
                  ? "Primary key"
                  : isFk
                    ? `References ${targets.get(`${table.name}.${col.name}`) ?? "another table"}`
                    : undefined
              }
            >
              {col.primaryKey ? "◆" : isFk ? "◇" : "·"}
            </span>
            <span className="truncate text-ink-muted">{col.name}</span>
            <span className="ml-auto shrink-0 truncate text-[10px] text-ink-faint">
              {col.dataType}
            </span>
          </div>
        );
      })}

      {hidden > 0 && (
        <div className="flex h-5 items-center px-2 pl-[18px] font-sans text-[10px] text-ink-faint">
          {hidden} more {hidden === 1 ? "column" : "columns"}
        </div>
      )}
    </div>
  );
}

export const TableNode = memo(TableNodeImpl);
