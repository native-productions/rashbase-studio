import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { JsonTree } from "@/components/grid/JsonTree";
import { parseJson, type JsonContainer } from "@/lib/utils/json";
import { editableReason } from "@/lib/utils/tabs";
import { useApp } from "@/store/app";

/**
 * One cell, at full size.
 *
 * The grid and the row panel are both scan surfaces: a column is 120px and the
 * panel is 320px, and neither is anywhere a nested document or a 4kB text
 * column can be read, let alone changed. This is the surface that admits the
 * value is bigger than the place it normally lives.
 *
 * Two ways to look at the same string, never two values: `text` is the only
 * state. The tree writes back into it, so switching to Raw always shows what
 * would be sent, and there is nothing to reconcile when the user switches back.
 *
 * One write, on Save. Retyping six leaves in the tree is one decision, and six
 * `update` statements would be six chances for the fourth to fail.
 */
export function CellModal() {
  const view = useApp((s) => s.cellView);
  const tab = useApp((s) => s.tabs.find((t) => t.id === s.cellView?.tabId) ?? null);
  const closeCellView = useApp((s) => s.closeCellView);
  const commitCellView = useApp((s) => s.commitCellView);

  const result = tab?.results[tab.activeResultIndex];
  const column = view ? result?.columns[view.col] : undefined;
  const original = view && result ? (result.rows[view.row]?.[view.col] ?? null) : null;

  const [text, setText] = useState("");
  const [mode, setMode] = useState<"tree" | "raw">("raw");

  /**
   * A JSON column keeps its shape: anything that will not parse is refused
   * before it reaches the server, which turns a 22P02 into a sentence next to
   * the field that caused it.
   */
  const strictJson =
    column?.typeClass === "json" || parseJson(original) !== undefined;

  // Fresh state per cell. Without the reset, expanding a second cell would
  // open on the first one's draft.
  useEffect(() => {
    if (!view) return;
    const opened = parseJson(original);
    setText(opened ? JSON.stringify(opened, null, 2) : (original ?? ""));
    setMode(opened ? "tree" : "raw");
    // Keyed by the cell, not by the value: a re-render after a write must not
    // throw away what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.tabId, view?.row, view?.col]);

  const doc = useMemo(() => parseJson(text), [text]);

  const parseError = useMemo(() => {
    if (!strictJson || text.trim() === "") return null;
    try {
      JSON.parse(text);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Not valid JSON";
    }
  }, [text, strictJson]);

  const reason = tab ? editableReason(tab) : "No row selected.";
  // Compared as documents, not as text. Opening a jsonb cell pretty-prints it,
  // and offering to save that would put a reformat-only write behind a button
  // the user pressed meaning "keep what I changed".
  const dirty = canonical(text) !== canonical(original ?? "");
  const canSave = reason === null && parseError === null && dirty;

  if (!view || !column || !tab) return null;

  const format = () => doc && setText(JSON.stringify(doc, null, 2));

  return (
    <Dialog.Root open onOpenChange={(o) => !o && closeCellView()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay-anim fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          data-hotkeys-off=""
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey && canSave) {
              e.preventDefault();
              void commitCellView(text);
            }
          }}
          className="sheet-anim fixed top-1/2 left-1/2 z-50 flex h-[min(72vh,680px)] w-[min(880px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-line bg-sheet shadow-2xl shadow-black/50"
        >
          <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
            <Dialog.Title className="min-w-0 truncate font-mono text-[12px] text-ink">
              {column.name}
            </Dialog.Title>
            <span className="shrink-0 text-[11px] text-ink-faint">{column.typeName}</span>

            {/* Only offered when there is something to draw. A text column has
                no tree, and a disabled tab would only be a question the surface
                already knows the answer to. */}
            {doc && (
              <div className="ml-3 flex shrink-0 gap-px rounded bg-base p-px">
                {(["tree", "raw"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={[
                      "rounded px-2 py-0.5 text-[11px] capitalize",
                      mode === m ? "bg-overlay text-ink" : "text-ink-faint hover:text-ink",
                    ].join(" ")}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}

            <Dialog.Close
              aria-label="Close"
              className="ml-auto shrink-0 rounded px-1 text-[13px] text-ink-faint hover:text-ink"
            >
              ×
            </Dialog.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-auto bg-base py-1.5">
            {mode === "tree" && doc ? (
              <JsonTree
                value={doc}
                onChange={
                  reason === null
                    ? (next: JsonContainer) => setText(JSON.stringify(next, null, 2))
                    : undefined
                }
              />
            ) : (
              <textarea
                value={text}
                spellCheck={false}
                readOnly={reason !== null}
                onChange={(e) => setText(e.target.value)}
                className="h-full w-full resize-none bg-transparent px-3 font-mono text-[12px] leading-[1.6] text-ink outline-none"
              />
            )}
          </div>

          <footer className="flex h-10 shrink-0 items-center gap-2 border-t border-line px-3 text-[11px]">
            {reason !== null ? (
              <span className="min-w-0 truncate text-ink-faint">{reason}</span>
            ) : parseError ? (
              <span className="min-w-0 truncate text-danger" title={parseError}>
                {parseError}
              </span>
            ) : (
              doc && (
                <button
                  onClick={format}
                  className="rounded px-1.5 py-0.5 text-ink-faint hover:bg-hover hover:text-ink"
                >
                  Format
                </button>
              )
            )}

            <Dialog.Close className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-ink-faint hover:bg-hover hover:text-ink">
              Close
            </Dialog.Close>
            {reason === null && (
              <>
                <span className="shrink-0 font-mono text-ink-faint">⌘⏎</span>
                <button
                  disabled={!canSave}
                  onClick={() => void commitCellView(text)}
                  className="pressable shrink-0 rounded bg-accent px-2.5 py-0.5 text-[11px] font-medium text-base disabled:bg-line disabled:text-ink-faint"
                >
                  Save
                </button>
              </>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * A value reduced to what it means, so whitespace is not a change. Anything
 * that is not JSON is already its own canonical form.
 */
function canonical(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}
