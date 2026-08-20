import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ipc } from "@/lib/ipc";
import { asDbError } from "@/lib/utils/errors";
import { dropStatement, truncateStatement } from "@/lib/utils/sql";
import type { RowCount } from "@/lib/types";
import { useApp } from "@/store/app";

/**
 * Confirms a statement that cannot be taken back.
 *
 * The statement is shown exactly as it will run, and the row count is shown
 * next to it, because "drop table users" and "drop table users, which holds
 * thirty thousand rows" are different decisions. Nothing here composes SQL the
 * user has not read.
 */
export interface PendingAction {
  action: "drop" | "truncate";
  schema: string;
  name: string;
  kind: string;
}

export function DestructiveDialog({
  connectionId,
  pending,
  onClose,
}: {
  connectionId: string;
  pending: PendingAction | null;
  onClose: () => void;
}) {
  const dropObject = useApp((s) => s.dropObject);
  const truncateTable = useApp((s) => s.truncateTable);
  const setToast = useApp((s) => s.setToast);

  const [typed, setTyped] = useState("");
  const [rows, setRows] = useState<RowCount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dropping = pending?.action === "drop";
  const sql = !pending
    ? ""
    : dropping
      ? dropStatement(pending.schema, pending.name, pending.kind)
      : truncateStatement(pending.schema, pending.name);

  // Typing the name is only required for a drop. Truncate leaves the table
  // and its shape behind, so the statement plus the count is enough.
  const confirmed = !dropping || typed.trim() === pending?.name;

  useEffect(() => {
    if (!pending) return;
    setTyped("");
    setRows(null);
    setError(null);
    let live = true;
    void ipc
      .estimateRows(connectionId, pending.schema, pending.name)
      .then((r) => live && setRows(r))
      .catch(() => {
        /* A missing count must not block the decision. */
      });
    return () => {
      live = false;
    };
  }, [pending, connectionId]);

  async function run() {
    if (!pending || !confirmed) return;
    setBusy(true);
    setError(null);
    try {
      if (dropping) await dropObject(connectionId, pending.schema, pending.name, pending.kind);
      else await truncateTable(connectionId, pending.schema, pending.name);
      onClose();
    } catch (e) {
      // Postgres refuses a drop that would orphan a dependent object and names
      // it. That sentence is the useful part; show it unedited.
      setError(asDbError(e).message);
      setToast(null);
    } finally {
      setBusy(false);
    }
  }

  const title = dropping
    ? `Drop ${pending?.kind === "table" ? "table" : pending?.kind === "matview" ? "materialized view" : "view"}`
    : "Truncate table";

  return (
    <Dialog.Root open={pending !== null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay-anim fixed inset-0 z-40 bg-scrim/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="sheet-anim fixed top-1/2 left-1/2 z-50 w-[min(440px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-overlay shadow-2xl shadow-black/50"
        >
          <div className="border-b border-line-soft px-5 py-3.5">
            <Dialog.Title className="text-[14px] font-semibold text-ink">{title}</Dialog.Title>
          </div>

          <div className="flex flex-col gap-3 px-5 py-4">
            <pre className="overflow-x-auto rounded border border-line-soft bg-canvas px-2.5 py-2 font-mono text-[12px] text-ink select-text">
              {sql}
            </pre>

            <p className="text-[12px] text-ink-muted">
              {rows === null ? "Counting rows…" : null}
              {rows !== null && (
                <>
                  <span className="font-mono tabular-nums text-ink">
                    {rows.exact ? "" : "~"}
                    {rows.value.toLocaleString()}
                  </span>{" "}
                  {rows.value === 1 ? "row" : "rows"}.{" "}
                </>
              )}
              This cannot be undone.
            </p>

            {dropping && (
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-ink-faint">
                  Type <span className="font-mono text-ink">{pending?.name}</span> to confirm
                </span>
                <input
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && confirmed) void run();
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  className="rounded border border-line-soft bg-canvas px-2 py-1.5 font-mono text-[12px] text-ink focus:border-danger focus:outline-none"
                />
              </label>
            )}

            {error && (
              <p className="rounded border border-danger/40 bg-danger/10 px-2.5 py-2 text-[12px] text-danger select-text">
                {error}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-line-soft px-5 py-3">
            <Dialog.Close className="pressable rounded px-3 py-1.5 text-[12px] text-ink-muted hover:bg-hover hover:text-ink">
              Cancel
            </Dialog.Close>
            <button
              disabled={!confirmed || busy}
              onClick={() => void run()}
              className="pressable rounded bg-danger px-3 py-1.5 text-[12px] font-medium text-on-danger disabled:pointer-events-none disabled:opacity-40"
            >
              {busy ? "Running…" : dropping ? "Drop" : "Truncate"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
