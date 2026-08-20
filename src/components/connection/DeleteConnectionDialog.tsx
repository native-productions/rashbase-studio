import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { asDbError } from "@/lib/utils/errors";
import type { ConnectionConfig } from "@/lib/types";
import { useApp } from "@/store/app";

/**
 * Confirms deleting a connection.
 *
 * No typed name, unlike a drop: nothing in the database changes. What is lost
 * is the stored password and, when the connection is a server, every database
 * picked off it — so both are stated rather than left to be discovered
 * afterwards.
 */
export function DeleteConnectionDialog({
  target,
  onClose,
}: {
  target: ConnectionConfig | null;
  onClose: () => void;
}) {
  const connections = useApp((s) => s.connections);
  const deleteConnection = useApp((s) => s.deleteConnection);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derived connections authenticate with this one's credential, so they cannot
  // outlive it. The backend removes them; this says so first.
  const children = target ? connections.filter((c) => c.parentId === target.id) : [];

  async function run() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await deleteConnection(target.id);
      onClose();
    } catch (e) {
      setError(asDbError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay-anim fixed inset-0 z-40 bg-scrim/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="sheet-anim fixed top-1/2 left-1/2 z-50 w-[min(440px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-overlay shadow-2xl shadow-black/50"
        >
          <div className="border-b border-line-soft px-5 py-3.5">
            <Dialog.Title className="text-[14px] font-semibold text-ink">
              Delete connection
            </Dialog.Title>
          </div>

          <div className="flex flex-col gap-3 px-5 py-4">
            <p className="text-[12px] text-ink-muted">
              <span className="text-ink">{target?.name}</span>{" "}
              <span className="font-mono text-[11px]">
                {target?.user}@{target?.host}:{target?.port}
                {target?.database ? `/${target.database}` : ""}
              </span>
            </p>

            <p className="text-[12px] text-ink-muted">
              The saved password is removed with it. Nothing on the server changes.
            </p>

            {children.length > 0 && (
              <p className="text-[12px] text-ink-muted">
                {children.length === 1 ? "One database" : `${children.length} databases`} picked off
                this server {children.length === 1 ? "goes" : "go"} too:{" "}
                <span className="font-mono text-[11px] text-ink">
                  {children.map((c) => c.name).join(", ")}
                </span>
              </p>
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
              autoFocus
              disabled={busy}
              onClick={() => void run()}
              className="pressable rounded bg-danger px-3 py-1.5 text-[12px] font-medium text-on-danger disabled:pointer-events-none disabled:opacity-40"
            >
              {busy ? "Deleting…" : "Delete"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
