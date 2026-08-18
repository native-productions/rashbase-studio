import { PageSizeMenu } from "@/components/table/PageSizeMenu";

/**
 * Previous, page size, next.
 *
 * Shared by the table footer and the query footer because they are the same
 * control: what differs between them is what they can say about the total,
 * which each footer renders beside this.
 *
 * No motion anywhere in here. Paging is something a person does dozens of times
 * in a sitting, and an entrance transition on a repeated action reads as the
 * app being slow.
 */
function Chevron({ back }: { back?: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d={back ? "M6.5 1.5L3 5l3.5 3.5" : "M3.5 1.5L7 5l-3.5 3.5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const stepCls =
  "pressable rounded p-1 text-ink-faint hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-30";

export function Pager({
  limit,
  offset,
  rows,
  running,
  onPage,
  onLimit,
}: {
  limit: number;
  offset: number;
  /** Rows on this page. Next is offered only when it came back full. */
  rows: number;
  running: boolean;
  onPage: (delta: number) => void;
  onLimit: (limit: number) => void;
}) {
  // Exact and free, where comparing against an estimate would sometimes lie.
  const hasNext = rows === limit;

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => onPage(-1)}
        disabled={offset === 0 || running}
        aria-label="Previous page"
        title="Previous page"
        className={stepCls}
      >
        <Chevron back />
      </button>

      <PageSizeMenu limit={limit} onChange={onLimit} />

      <button
        onClick={() => onPage(1)}
        disabled={!hasNext || running}
        aria-label="Next page"
        title="Next page"
        className={stepCls}
      >
        <Chevron />
      </button>
    </div>
  );
}
