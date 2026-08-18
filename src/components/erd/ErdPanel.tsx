import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui/Spinner";
import { ipc } from "@/lib/ipc";
import { asDbError } from "@/lib/utils/errors";
import type { ColumnInfo, IndexInfo, Relation } from "@/lib/types";
import { useApp } from "@/store/app";

/**
 * The clicked relation, in full.
 *
 * Fetched here rather than carried in the graph: the graph deliberately holds
 * four fields per column so a hundred-table schema stays cheap to move, and the
 * three it drops — default, comment, enum labels — are exactly what someone
 * wants once they have picked a table out of the diagram. One relation at a
 * time is a round trip nobody notices.
 *
 * It shrinks the canvas rather than floating over it, like the row panel: an
 * overlay would cover the neighbours whose edges you clicked in to follow.
 */

export function ErdPanel({
  connectionId,
  schema,
  table,
  relations,
  onClose,
}: {
  connectionId: string;
  schema: string;
  table: string;
  /** Every key in the schema; the outgoing and incoming halves are split here. */
  relations: Relation[];
  onClose: () => void;
}) {
  const setToast = useApp((s) => s.setToast);
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  const [indexes, setIndexes] = useState<IndexInfo[] | null>(null);

  useEffect(() => {
    let live = true;
    setColumns(null);
    setIndexes(null);
    void Promise.all([
      ipc.listColumns(connectionId, schema, table),
      ipc.listIndexes(connectionId, schema, table),
    ])
      .then(([c, i]) => {
        // The user can click a second node before the first reply lands.
        if (!live) return;
        setColumns(c);
        setIndexes(i);
      })
      .catch((e: unknown) => {
        if (live) setToast({ kind: "error", text: asDbError(e).message });
      });
    return () => {
      live = false;
    };
  }, [connectionId, schema, table, setToast]);

  const outgoing = relations.filter((r) => r.table === table);
  const incoming = relations.filter((r) => r.refTable === table && r.table !== table);

  return (
    <div className="flex w-80 shrink-0 flex-col border-l border-line-soft bg-base">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line-soft px-3">
        <span className="truncate font-mono text-[12px] text-ink">{table}</span>
        <button
          onClick={onClose}
          aria-label="Close panel"
          className="ml-auto shrink-0 text-[13px] leading-none text-ink-faint hover:text-ink"
        >
          ×
        </button>
      </div>

      {!columns || !indexes ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-ink-faint">
          <Spinner size={11} className="text-accent" label="Reading" />
          Reading structure…
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto pb-4">
          <Section label="Columns" />
          {columns.map((col) => (
            <div key={col.name} className="px-3 py-1 font-mono text-[11px]">
              <div className="flex items-baseline gap-1.5">
                <span
                  aria-hidden="true"
                  className={["shrink-0 text-[9px]", col.primaryKey ? "text-accent" : "text-transparent"].join(" ")}
                  title={col.primaryKey ? "Primary key" : undefined}
                >
                  ◆
                </span>
                <span className="truncate text-ink">{col.name}</span>
                <span className="ml-auto shrink-0 truncate text-bool">{col.dataType}</span>
              </div>
              <div className="pl-[18px] font-sans text-[10px] text-ink-faint">
                {col.notNull ? "not null" : "nullable"}
                {col.default !== null && <> · default {col.default}</>}
                {col.enumValues.length > 0 && <> · {col.enumValues.length} labels</>}
              </div>
              {col.comment && (
                <p className="pl-[18px] font-sans text-[10px] text-ink-muted">{col.comment}</p>
              )}
            </div>
          ))}

          {(outgoing.length > 0 || incoming.length > 0) && <Section label="Relations" />}
          {outgoing.map((r) => (
            <Reference
              key={r.name}
              arrow="→"
              from={r.columns.join(", ")}
              to={`${r.refSchema}.${r.refTable}.${r.refColumns.join(", ")}`}
              name={r.name}
            />
          ))}
          {incoming.map((r) => (
            <Reference
              key={r.name}
              arrow="←"
              from={r.refColumns.join(", ")}
              to={`${r.table}.${r.columns.join(", ")}`}
              name={r.name}
            />
          ))}

          <Section label="Indexes" />
          {indexes.length === 0 ? (
            <p className="px-3 font-sans text-[11px] text-ink-faint">No indexes.</p>
          ) : (
            indexes.map((index) => (
              <div key={index.name} className="px-3 py-1 font-mono text-[11px]">
                <span className="truncate text-ink-muted">{index.name}</span>
                <p className="text-[10px] break-all text-ink-faint select-text">
                  {index.definition}
                </p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const Section = ({ label }: { label: string }) => (
  <div className="px-3 pt-4 pb-1.5">
    <span className="label-eyebrow">{label}</span>
  </div>
);

const Reference = ({
  arrow,
  from,
  to,
  name,
}: {
  arrow: string;
  from: string;
  to: string;
  name: string;
}) => (
  <div className="px-3 py-1 font-mono text-[11px]" title={name}>
    <div className="flex items-baseline gap-1.5">
      <span aria-hidden="true" className="shrink-0 text-[9px] text-bool">
        {arrow}
      </span>
      <span className="truncate text-ink">{from}</span>
    </div>
    <p className="truncate pl-[18px] text-[10px] text-ink-faint">{to}</p>
  </div>
);
