import { TABLE_HEAD_CLS } from "@/lib/constants/ui";
import type { QueryTab } from "@/lib/types";

/**
 * What the table is, as Postgres describes it.
 *
 * Reuses the grid's metrics so switching views does not feel like landing in a
 * different application, but is not virtualised: a table with a thousand
 * columns is a problem no scroll strategy fixes.
 *
 * Index definitions are printed exactly as `pg_get_indexdef` returns them.
 * Restating them in our own words would only add a way to be wrong about a
 * definition the user may be about to copy.
 */

export function StructureView({ tab }: { tab: QueryTab }) {
  if (!tab.columns || !tab.indexes) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-ink-faint">
        Reading structure…
      </div>
    );
  }

  const { columns, indexes } = tab;

  return (
    <div className="h-full overflow-auto font-mono text-[12px]">
      <div className="flex min-w-max">
        <div className={`${TABLE_HEAD_CLS} w-56 shrink-0`}>Column</div>
        <div className={`${TABLE_HEAD_CLS} w-52 shrink-0`}>Type</div>
        <div className={`${TABLE_HEAD_CLS} w-16 shrink-0`}>Null</div>
        <div className={`${TABLE_HEAD_CLS} w-64 shrink-0`}>Default</div>
        <div className={`${TABLE_HEAD_CLS} min-w-56 flex-1`}>Comment</div>
      </div>

      {columns.map((col) => (
        <div key={col.name} className="flex min-w-max border-b border-line-soft">
          <div className="flex h-6 w-56 shrink-0 items-center gap-1.5 px-2">
            {/* The key marker sits in the gutter of the name, where the eye is
                already looking, rather than in a column of its own. */}
            <span
              aria-hidden="true"
              className={["shrink-0 text-[9px]", col.primaryKey ? "text-accent" : "text-transparent"].join(" ")}
              title={col.primaryKey ? "Primary key" : undefined}
            >
              ◆
            </span>
            <span className="truncate text-ink">{col.name}</span>
          </div>
          <div className="flex h-6 w-52 shrink-0 items-center truncate px-2 text-bool">
            {col.dataType}
          </div>
          <div className="flex h-6 w-16 shrink-0 items-center px-2 text-ink-muted">
            {col.notNull ? "no" : "yes"}
          </div>
          <div className="flex h-6 w-64 shrink-0 items-center truncate px-2" title={col.default ?? undefined}>
            {col.default === null ? (
              <span className="text-null italic">NULL</span>
            ) : (
              <span className="truncate text-str">{col.default}</span>
            )}
          </div>
          <div className="flex h-6 min-w-56 flex-1 items-center truncate px-2 font-sans text-[11px] text-ink-faint">
            {col.comment}
          </div>
        </div>
      ))}

      <div className="mt-6 border-t border-line-soft px-3 pt-3 pb-1.5">
        <span className="label-eyebrow">Indexes</span>
      </div>
      {indexes.length === 0 ? (
        <p className="px-3 pb-4 font-sans text-[11px] text-ink-faint">No indexes.</p>
      ) : (
        <div className="pb-6">
          {indexes.map((index) => (
            <div key={index.name} className="flex items-baseline gap-3 px-3 py-1">
              <span className="w-56 shrink-0 truncate text-ink-muted" title={index.name}>
                {index.name}
              </span>
              {index.primary && (
                <span className="shrink-0 rounded-sm bg-accent-wash px-1 font-sans text-[9px] tracking-wide text-accent uppercase">
                  pk
                </span>
              )}
              <span className="text-[11px] break-all text-ink-faint select-text">
                {index.definition}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
