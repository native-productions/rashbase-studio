import * as Dialog from "@radix-ui/react-dialog";
import { useApp } from "@/store/app";

/**
 * A refusal the user has to read.
 *
 * The database's own words, unedited and selectable: message, then the detail
 * and hint it sent with them. A foreign key violation is the case this exists
 * for — Postgres names the referencing table and the key that still points at
 * the row, and that sentence is the answer to "why not", so paraphrasing it or
 * dropping it into a toast that fades would throw away the useful part.
 *
 * Only for writes the user explicitly confirmed. Everything else stays a toast:
 * a dialog for a failed background poll would be a dialog nobody asked for.
 */
export function ErrorDialog() {
  const dialog = useApp((s) => s.errorDialog);
  const setErrorDialog = useApp((s) => s.setErrorDialog);

  const error = dialog?.error;

  return (
    <Dialog.Root open={dialog !== null} onOpenChange={(o) => !o && setErrorDialog(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay-anim fixed inset-0 z-40 bg-scrim/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="sheet-anim fixed top-1/2 left-1/2 z-50 w-[min(520px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-overlay shadow-2xl shadow-black/50"
        >
          <div className="flex items-baseline gap-2 border-b border-line-soft px-5 py-3.5">
            <Dialog.Title className="text-[14px] font-semibold text-ink">
              {dialog?.title}
            </Dialog.Title>
            {/* The SQLSTATE, because it is the one part of this that can be
                looked up. `23503` is a foreign key violation whether or not the
                sentence beside it says so in a language the reader knows. */}
            {error?.code && (
              <span className="font-mono text-[11px] text-danger select-text">{error.code}</span>
            )}
          </div>

          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-5 py-4">
            <p className="text-[12px] leading-relaxed text-ink select-text">{error?.message}</p>

            {error?.detail && (
              <p className="text-[12px] leading-relaxed text-ink-muted select-text">
                {error.detail}
              </p>
            )}

            {error?.hint && (
              <p className="rounded border border-line-soft bg-canvas px-2.5 py-2 text-[12px] leading-relaxed text-ink-muted select-text">
                {error.hint}
              </p>
            )}
          </div>

          <div className="flex justify-end border-t border-line-soft px-5 py-3">
            <Dialog.Close className="pressable rounded bg-accent-fill px-3 py-1.5 text-[12px] font-medium text-on-accent">
              Close
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
