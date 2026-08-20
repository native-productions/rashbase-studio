import { deleteRowsPreview, quoteLiteral, updatePreview } from "@/lib/utils/sql";
import { rowKeysFor, stagedRowsIn } from "@/lib/utils/rowKeys";
import { deletePreview, stagedKeysIn } from "@/lib/utils/redis";
import { retryPreview, stagedJobsIn, stateLabel } from "@/lib/utils/bullmq";
import { isKeyspace, rowsDeletable } from "@/lib/utils/tabs";
import { shortServerVersion } from "@/lib/utils/version";
import type { QueryTab } from "@/lib/types";
import { Spinner } from "@/components/ui/Spinner";
import { useApp, activeTab } from "@/store/app";

/**
 * The statement an open cell editor is about to run.
 *
 * PRODUCT.md: generated writes are shown before they run. A modal for each cell
 * would be shown too, and would also make editing ten cells ten dialogs, which
 * is what sends people back to writing UPDATE by hand. This says the same thing
 * without interrupting.
 *
 * Returns null when the pieces to name the row are not all here, so the bar
 * shows nothing rather than half a statement. `rowKeysFor` is the same function
 * the store uses to build the real write, so the preview cannot describe a
 * different row than the one that gets written.
 */
function pendingWrite(
  tab: QueryTab,
  edit: NonNullable<ReturnType<typeof useApp.getState>["cellEdit"]>,
): { sql: string; bound: string } | null {
  const object = tab.object;
  const result = tab.results[tab.activeResultIndex];
  const column = result?.columns[edit.col]?.name;
  if (!object || !result || !column) return null;

  const identity = rowKeysFor(tab.columns, result, edit.row);
  if (!identity.ok) return null;

  return {
    sql: updatePreview({ schema: object.schema, table: object.name, column, keys: identity.keys }),
    // `$1` stays a parameter in the statement because that is what the backend
    // binds. The value is shown beside it rather than spliced into it.
    bound: edit.isNull ? "$1 = NULL" : `$1 = ${quoteLiteral(edit.draft)}`,
  };
}

export function StatusBar() {
  const tab = useApp(activeTab);
  const open = useApp((s) => s.open);
  const setPalette = useApp((s) => s.setPalette);

  const info = tab?.connectionId ? open[tab.connectionId] : undefined;
  const result = tab?.results[tab.activeResultIndex];

  const cellEdit = useApp((s) => s.cellEdit);
  /**
   * What the app is waiting on, in words.
   *
   * The sidebar spinner says *something* is happening to that row; this says
   * what. A tunnelled connection is the case that needs both — nine pixels of
   * motion beside a name is not enough to sit through ten seconds of.
   *
   * First one wins. Two round trips at once is normal and a queue of them is
   * not worth reading; what matters is that the bar is not claiming "Ready"
   * while the app waits.
   */
  const waiting = useApp((s) => Object.values(s.busy)[0] ?? null);
  const pending = tab && cellEdit?.tabId === tab.id ? pendingWrite(tab, cellEdit) : null;

  /**
   * The staged deletion, as the command it will run.
   *
   * The same bargain the pending write makes, and the reason neither needs a
   * dialog: PRODUCT.md asks that a generated write be shown before it runs, and
   * this shows it — beside red rows the user marked one at a time — without
   * turning ten deletions into ten modals.
   */
  const staged = tab && isKeyspace(tab.object) && tab.staged.length > 0 ? tab : null;
  const stagedKeys = staged && result ? stagedKeysIn(result, new Set(staged.staged)) : [];

  /**
   * The staged retry, as what it is about to do.
   *
   * The same bargain the staged deletion makes one bar down, and deliberately
   * not the same colour. Red there means the thing that cannot be undone; a
   * retry puts work back into the queue, and dressing it as a destruction would
   * make the one genuinely dangerous footer in this app mean less.
   */
  /**
   * The staged row deletions, as the statements they will run.
   *
   * The third shape of the same bargain, and the reason it needs no dialog is
   * the reason the other two do not: the rows are already struck through in
   * red, and this says exactly what is about to be sent. `stagedRowsIn` is the
   * function the store uses to build the write, so the footer cannot name a
   * different set of rows than the one that goes.
   */
  const stagedRows =
    tab && rowsDeletable(tab) && tab.staged.length > 0 && result
      ? stagedRowsIn(tab.columns, result, new Set(tab.staged))
      : [];

  const stagedRetry =
    tab?.object?.kind === "queue" && tab.queue?.state && tab.staged.length > 0 ? tab : null;
  const retryIds = stagedRetry && result ? stagedJobsIn(result, new Set(stagedRetry.staged)) : [];

  if (retryIds.length > 0 && stagedRetry) {
    const state = stagedRetry.queue!.state!;
    return (
      <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line-soft bg-raised px-3 text-[11px]">
        <span className="min-w-0 truncate font-mono text-str select-text">
          {retryPreview(retryIds, stateLabel(state), false)}
        </span>
        <span className="shrink-0 text-ink-muted">
          {retryIds.length} {retryIds.length === 1 ? "job" : "jobs"}
        </span>
        <span className="ml-auto shrink-0 text-ink-faint">
          <span className="font-mono text-ink-muted">⌘S</span> retry
          {/* Named rather than hidden behind the same key. A job that has used
              its whole allowance fails again within seconds unless the counter
              is cleared, and a job that has not should not silently be given a
              fresh one — so the two are two bindings, not a default. */}
          <span className="ml-2 font-mono text-ink-muted">⇧⌘S</span> retry + reset attempts
          <span className="ml-2 font-mono text-ink-muted">esc</span> cancel
        </span>
      </footer>
    );
  }

  if (stagedRows.length > 0 && tab?.object) {
    return (
      <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-danger/30 bg-danger/10 px-3 text-[11px]">
        <span className="min-w-0 truncate font-mono text-danger select-text">
          {deleteRowsPreview(tab.object.schema, tab.object.name, stagedRows)}
        </span>
        <span className="shrink-0 text-ink-muted">
          {stagedRows.length} {stagedRows.length === 1 ? "row" : "rows"}
        </span>
        <span className="ml-auto shrink-0 text-ink-faint">
          <span className="font-mono text-ink-muted">⌘S</span> delete{" "}
          <span className="ml-2 font-mono text-ink-muted">esc</span> cancel
        </span>
      </footer>
    );
  }

  if (stagedKeys.length > 0) {
    return (
      <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-danger/30 bg-danger/10 px-3 text-[11px]">
        <span className="min-w-0 truncate font-mono text-danger select-text">
          {deletePreview(stagedKeys)}
        </span>
        <span className="shrink-0 text-ink-muted">
          {stagedKeys.length} {stagedKeys.length === 1 ? "key" : "keys"}
        </span>
        <span className="ml-auto shrink-0 text-ink-faint">
          <span className="font-mono text-ink-muted">⌘S</span> delete{" "}
          <span className="ml-2 font-mono text-ink-muted">esc</span> cancel
        </span>
      </footer>
    );
  }

  if (pending) {
    return (
      <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line-soft bg-raised px-3 text-[11px]">
        <span
          title={`${pending.sql};  ${pending.bound}`}
          className="min-w-0 truncate font-mono text-ink-muted select-text"
        >
          {pending.sql}
        </span>
        <span className="shrink-0 font-mono text-ink">{pending.bound}</span>
        <span className="ml-auto shrink-0 text-ink-faint">
          <span className="font-mono text-ink-muted">⏎</span> run{" "}
          <span className="ml-2 font-mono text-ink-muted">esc</span> cancel
        </span>
      </footer>
    );
  }

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line-soft bg-raised px-3 text-[11px] text-ink-faint">
      {tab?.running ? (
        <span className="flex items-center gap-1.5 text-accent">
          <Spinner size={9} label="Running" />
          Running…
        </span>
      ) : waiting ? (
        <span className="flex items-center gap-1.5 text-accent">
          <Spinner size={9} label={waiting} />
          {waiting}
        </span>
      ) : result ? (
        <>
          <span className="text-ink-muted">
            {result.rows.length.toLocaleString()}
            {/* Saying "1,000 rows" for a result the cap cut short would be
                describing the window rather than the statement. */}
            {result.truncated && ` of ${result.rowsAffected.toLocaleString()}`}
            {result.columns.length > 0
              ? ` row${result.rows.length === 1 && !result.truncated ? "" : "s"}`
              : ` affected`}
          </span>
          <span title="Time spent on the server">{result.durationMs.toLocaleString()} ms</span>
          {tab.clientMs != null && (
            <span title="Round trip including transfer to the window">
              {tab.clientMs.toLocaleString()} ms total
            </span>
          )}
          {tab.results.length > 1 && (
            <span>
              set {tab.activeResultIndex + 1} of {tab.results.length}
            </span>
          )}
        </>
      ) : (
        <span>Ready</span>
      )}

      <div className="ml-auto flex items-center gap-4">
        {info && (
          <>
            <span>{info.currentDatabase}</span>
            <span>{shortServerVersion(info.serverVersion)}</span>
            {info.backendPid > 0 && (
              <span title="Server-side connection id">pid {info.backendPid}</span>
            )}
          </>
        )}
        <button
          onClick={() => setPalette("commands")}
          className="hover:text-ink-muted"
          title="Command palette"
        >
          ⌘K for commands
        </button>
      </div>
    </footer>
  );
}
