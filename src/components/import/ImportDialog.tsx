import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { listen } from "@tauri-apps/api/event";
import { open as openFile } from "@tauri-apps/plugin-dialog";

import { ipc } from "@/lib/ipc";
import { asDbError } from "@/lib/utils/errors";
import { formatBytes } from "@/lib/utils/exportPlan";
import {
  DEFAULT_OPTIONS,
  describeSummary,
  importFraction,
  planImport,
  type ImportOptions,
} from "@/lib/utils/importPlan";
import { Check, Field } from "@/components/ui/Form";
import { Spinner } from "@/components/ui/Spinner";
import { useApp } from "@/store/app";
import type { DbError, ImportPreflight, ImportProgress } from "@/lib/types";

/**
 * Running a `.sql` file into the database.
 *
 * The peer of `ExportDialog`, and deliberately the same geometry: the same
 * sheet, the same header, the same footer, the two panes in the same places.
 * They are one question asked in two directions, and a second dialog that
 * rearranged the furniture would cost the user the reading they already did.
 *
 * The panes hold the two halves of that question. Left is *what is in the
 * file*, which is a scan: counts, then a list. Right is *what will be done to
 * it*, which is a form: four switches, read down, each with the reason it
 * exists underneath.
 *
 * The table list is in file order and never sorted. That order is the
 * information — it is the order that was going to fail, and `order_items`
 * sitting above `orders` is the whole argument for the first switch.
 *
 * A failure does not leave as a toast. Nothing was applied, the transaction was
 * rolled back, and the pane that was describing the file becomes the pane
 * carrying the server's own refusal and the line of the file it was on. An
 * import that fails with less information than psql would have given is an
 * import that sent the user back to psql.
 */

export function ImportDialog() {
  const target = useApp((s) => s.importTarget);
  const setImportTarget = useApp((s) => s.setImportTarget);

  // Remounted per opening, so a file, its preflight and a failure from the last
  // run never turn up in front of the next one.
  return (
    <Dialog.Root open={target !== null} onOpenChange={(o) => !o && setImportTarget(null)}>
      {target && <Body connectionId={target.connectionId} />}
    </Dialog.Root>
  );
}

function Body({ connectionId }: { connectionId: string }) {
  const connections = useApp((s) => s.connections);
  const open = useApp((s) => s.open);
  const setImportTarget = useApp((s) => s.setImportTarget);
  const setToast = useApp((s) => s.setToast);
  // Read from the store rather than taken as a prop: a file dropped while the
  // dialog is already open has to replace the one in it, and a prop captured
  // when the dialog opened cannot.
  const path = useApp((s) => s.importTarget?.path ?? null);

  const config = connections.find((c) => c.id === connectionId);
  const database = open[connectionId]?.currentDatabase ?? config?.database ?? "";

  const [options, setOptions] = useState<ImportOptions>(DEFAULT_OPTIONS);
  const [preflight, setPreflight] = useState<ImportPreflight | null>(null);
  const [reading, setReading] = useState(false);
  const [running, setRunning] = useState<ImportProgress | null>(null);
  const [failure, setFailure] = useState<DbError | null>(null);

  // Reading a large dump takes a moment and touches no database, so it starts
  // the instant a file is named rather than waiting for the user to commit.
  useEffect(() => {
    if (!path) {
      setPreflight(null);
      return;
    }
    let live = true;
    setReading(true);
    setFailure(null);
    void ipc
      .importInspect(path)
      .then((result) => live && setPreflight(result))
      .catch((e) => {
        if (!live) return;
        setPreflight(null);
        setFailure(asDbError(e));
      })
      .finally(() => live && setReading(false));
    return () => {
      live = false;
    };
  }, [path]);

  const jobId = running?.jobId;
  useEffect(() => {
    if (!jobId) return;
    const stop = listen<ImportProgress>("import://progress", (event) => {
      if (event.payload.jobId !== jobId) return;
      setRunning((r) => (r ? { ...r, ...event.payload } : r));
    });
    return () => {
      void stop.then((off) => off());
    };
  }, [jobId]);

  const plan = planImport(options, preflight);
  const ready = plan.blocked === null && !reading && !!path;

  async function choose() {
    const picked = await openFile({
      multiple: false,
      filters: [{ name: "SQL", extensions: ["sql", "gz"] }],
    });
    if (typeof picked === "string") setImportTarget({ connectionId, path: picked });
  }

  async function run() {
    if (!path || !preflight) return;
    const id = crypto.randomUUID();
    setFailure(null);
    setRunning({ jobId: id, statements: 0, total: preflight.statements, bytes: 0, table: "" });
    try {
      const summary = await ipc.importSql(connectionId, id, {
        path,
        ...plan.effective,
        orm: preflight.orm,
        totalStatements: preflight.statements,
      });
      setToast({ kind: "info", text: describeSummary(summary) });
      setImportTarget(null);
    } catch (e) {
      const refused = asDbError(e);
      // Stopping is not failing: the transaction was rolled back, so there is
      // nothing to report and no reason to keep the user in front of it.
      if (refused.code === "CANCELLED") setImportTarget(null);
      else setFailure(refused);
    } finally {
      setRunning(null);
    }
  }

  const fraction = running ? importFraction(running.statements, running.total) : null;

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="overlay-anim fixed inset-0 z-40 bg-scrim/50" />
      <Dialog.Content
        aria-describedby={undefined}
        // While the file is being applied the dialog is the only way to stop
        // it, so it does not go away by accident. Stop is still one click.
        onEscapeKeyDown={(e) => running && e.preventDefault()}
        onPointerDownOutside={(e) => running && e.preventDefault()}
        onInteractOutside={(e) => running && e.preventDefault()}
        className="sheet-anim fixed top-1/2 left-1/2 z-50 flex h-[min(560px,88vh)] w-[min(780px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-line bg-overlay shadow-2xl shadow-black/50"
      >
        {/* The same line the export dialog carries, and it matters more here.
            Telling a local Docker Postgres from a production replica at a
            glance is the safety feature, and this is the largest write this
            application performs. */}
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-line-soft px-5">
          <Dialog.Title className="text-[14px] font-semibold text-ink">Import</Dialog.Title>
          <span className="font-mono text-[11px] text-ink-faint">
            {database} · {config?.host ?? ""}
          </span>
        </div>

        <FileRow
          path={path}
          preflight={preflight}
          reading={reading}
          locked={running !== null}
          onChoose={() => void choose()}
        />

        <div className="flex min-h-0 flex-1">
          {/* What is in it. A reading surface, so it is prose and a list rather
              than a form, and it becomes the failure report when there is one. */}
          <div className="w-[300px] shrink-0 overflow-y-auto border-r border-line-soft px-5 py-4">
            {failure ? (
              <Failure error={failure} />
            ) : (
              <Contents
                plan={plan}
                preflight={preflight}
                reading={reading}
                hasFile={!!path}
              />
            )}
          </div>

          {/* What will be done to it. A form, read top to bottom. */}
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            <Field label="What will be done">
              <div className="flex flex-col gap-4">
                {plan.switches.map((item) => (
                  <div key={item.key} className="flex flex-col gap-1">
                    <Check
                      checked={plan.effective[item.key]}
                      disabled={item.lockedNote !== null || running !== null}
                      label={item.label}
                      onChange={(value) =>
                        setOptions((o) => ({ ...o, [item.key]: value }))
                      }
                    />
                    <p className="pl-[22px] text-[11px] leading-snug text-ink-faint">
                      {item.lockedNote ?? item.note}
                    </p>
                  </div>
                ))}
              </div>
            </Field>

            {/* Said once, at the bottom of the switches, because it is the
                frame all four sit in rather than a property of any one. */}
            <p className="mt-5 border-t border-line-soft pt-3 text-[11px] leading-snug text-ink-faint">
              {plan.transactionNote}
            </p>
          </div>
        </div>

        <div className="relative flex h-12 shrink-0 items-center justify-between border-t border-line-soft px-5">
          <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-muted">
            {running ? (
              <>
                <Spinner size={10} className="text-accent" label="Importing" />
                Importing
                {running.table && (
                  <span className="truncate font-mono text-ink">{running.table}</span>
                )}
                <span className="shrink-0 tabular-nums">
                  · {running.statements.toLocaleString()}
                  {running.total > 0 && ` of ${running.total.toLocaleString()}`}
                </span>
              </>
            ) : (
              plan.footer
            )}
          </p>

          <div className="flex shrink-0 gap-2">
            {!running && (
              <Dialog.Close className="pressable rounded px-3 py-1.5 text-[12px] text-ink-muted hover:bg-hover hover:text-ink">
                Cancel
              </Dialog.Close>
            )}
            <button
              disabled={!running && !ready}
              onClick={() => (running ? void ipc.cancelImport(running.jobId) : void run())}
              className={[
                "pressable rounded px-3 py-1.5 text-[12px] font-medium disabled:pointer-events-none disabled:opacity-40",
                running ? "bg-field text-ink hover:bg-field-hover" : "bg-accent-fill text-on-accent",
              ].join(" ")}
            >
              {running ? "Stop" : "Import"}
            </button>
          </div>

          {/* On the dialog's own edge, the way the export dialog's is: the work
              belongs to the whole dialog, and a bar in the body would push the
              form about while it ran. */}
          {fraction !== null && (
            <div
              className="absolute right-0 bottom-0 left-0 h-0.5 bg-accent transition-[width] duration-200 ease-[var(--ease-out-quart)]"
              style={{ width: `${fraction * 100}%` }}
            />
          )}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

/**
 * The chosen file, on one line.
 *
 * A row rather than a dashed rectangle with an icon in it. The whole window
 * already accepts a dropped file, so a box drawn to say "drop here" is a
 * container that does nothing — and this codebase does not wrap things in those.
 */
function FileRow({
  path,
  preflight,
  reading,
  locked,
  onChoose,
}: {
  path: string | null;
  preflight: ImportPreflight | null;
  reading: boolean;
  locked: boolean;
  onChoose: () => void;
}) {
  const name = path?.split(/[/\\]/).pop() ?? null;

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line-soft px-5">
      {name ? (
        <>
          <span title={path ?? undefined} className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
            {name}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-ink-faint tabular-nums">
            {reading ? "reading…" : preflight ? formatBytes(preflight.bytes) : ""}
          </span>
        </>
      ) : (
        <span className="min-w-0 flex-1 text-[12px] text-ink-muted">
          Drop a <span className="font-mono">.sql</span> file on this window, or choose one.
        </span>
      )}
      <button
        disabled={locked}
        onClick={onChoose}
        className="pressable shrink-0 rounded bg-field px-2.5 py-1 text-[12px] text-ink hover:bg-field-hover disabled:pointer-events-none disabled:opacity-40"
      >
        {name ? "Change…" : "Choose…"}
      </button>
    </div>
  );
}

/** What the preflight found, as a short read. */
function Contents({
  plan,
  preflight,
  reading,
  hasFile,
}: {
  plan: ReturnType<typeof planImport>;
  preflight: ImportPreflight | null;
  reading: boolean;
  hasFile: boolean;
}) {
  if (!hasFile) {
    return (
      <p className="text-[12px] leading-relaxed text-ink-faint">
        A dump written by another client, or by this one. Everything in it is
        read and counted before any of it runs.
      </p>
    );
  }

  return (
    // Opacity alone, and the pane keeps its size: the switches beside it must
    // not move under the pointer when the count arrives.
    <div
      className="flex flex-col gap-3 transition-opacity duration-150 ease-[var(--ease-out-quart)]"
      style={{ opacity: reading ? 0 : 1 }}
    >
      <h2 className="label-eyebrow">In this file</h2>

      {plan.contents && <p className="text-[12px] text-ink-muted">{plan.contents}</p>}
      {plan.written && <p className="text-[12px] text-ink-muted">{plan.written}</p>}
      {preflight?.compressed && (
        <p className="text-[11px] text-ink-faint">Gzipped. Read without unpacking it first.</p>
      )}

      {preflight && preflight.tables.length > 0 && (
        <div className="mt-1 flex flex-col">
          {preflight.tables.map(([name, count]) => (
            <div key={name} className="flex items-baseline gap-2 py-0.5">
              <span title={name} className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
                {name}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums">
                {count.toLocaleString()}
              </span>
            </div>
          ))}
          {/* A list that was cut says it was cut. A number that looks complete
              and is not is the one thing the status bar never does either. */}
          {preflight.tableCount > preflight.tables.length && (
            <p className="mt-1 text-[11px] text-ink-faint">
              First {preflight.tables.length} of {preflight.tableCount.toLocaleString()}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A refused statement, in the server's own words.
 *
 * `message`, `detail` and `hint` are Postgres'. `context` is this application's
 * — the line of the file — and it is kept visibly apart from them for that
 * reason.
 */
function Failure({ error }: { error: DbError }) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="label-eyebrow text-danger">Rolled back</h2>
      <p className="text-[12px] leading-snug text-ink-muted">
        Nothing was applied. The database is as it was before this started.
      </p>

      <p className="text-[12px] leading-snug text-danger select-text">{error.message}</p>
      {error.detail && (
        <p className="text-[11px] leading-snug text-ink-muted select-text">{error.detail}</p>
      )}
      {error.hint && (
        <p className="text-[11px] leading-snug text-ink-muted select-text">{error.hint}</p>
      )}

      {error.context && (
        <pre className="mt-1 overflow-x-auto border-t border-line-soft pt-3 font-mono text-[11px] leading-snug whitespace-pre-wrap text-ink-faint select-text">
          {error.context}
        </pre>
      )}
    </div>
  );
}
