import type { QueryTab } from "@/lib/types";

/**
 * The source of a view or function, as Postgres reports it.
 *
 * Read-only and unreformatted. `pg_get_viewdef` and `pg_get_functiondef` are
 * what `\d+` and `\sf` print, and a client that pretty-printed them differently
 * would be showing something the server never said.
 */
export function DefinitionView({ tab }: { tab: QueryTab }) {
  if (tab.definition === null) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-ink-faint">
        Reading definition…
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <pre className="px-3 py-2 font-mono text-[12px] leading-[1.6] whitespace-pre text-ink select-text">
        {tab.definition}
      </pre>
    </div>
  );
}
