import { useCallback, useEffect, useId, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { listen } from "@tauri-apps/api/event";
import { open as openFolder } from "@tauri-apps/plugin-dialog";
import { downloadDir } from "@tauri-apps/api/path";

import { ipc } from "@/lib/ipc";
import { asDbError } from "@/lib/utils/errors";
import { defaultFileName, formatBytes, planExport, type ExportOptions } from "@/lib/utils/exportPlan";
import { KIND_GLYPH } from "@/lib/constants/sidebar";
import { INPUT_CLS } from "@/lib/constants/ui";
import { Segmented } from "@/components/ui/Segmented";
import { Spinner } from "@/components/ui/Spinner";
import { useApp } from "@/store/app";
import type { ExportProgress, ObjectRef, TableEntry } from "@/lib/types";

/**
 * Choosing what leaves the database, and where it lands.
 *
 * Two panes, and they answer two different questions. The left one is *which
 * relations*, which is a scan: a list, a filter, one checkbox per row. The
 * right one is *what the file should be*, which is a form: read top to bottom,
 * every control on one line, the answer accumulating as you go.
 *
 * One checkbox per relation, not three. Structure, drop, and data are
 * properties of the export rather than of each table, and putting them on every
 * row is what turns the usual export dialog into a matrix nobody can read.
 *
 * A control that no longer applies is shown off with the reason under it rather
 * than removed. CSV cannot carry a schema; saying so where the schema control
 * was is how the user learns that, and a control that vanished would only look
 * like a bug.
 */

/** Above this many, counting rows costs more round trips than the answer is worth. */
const COUNT_LIMIT = 40;

/** One relation as the tree lists it. */
interface Entry {
  schema: string;
  name: string;
  kind: TableEntry["kind"];
  key: string;
}

const keyOf = (schema: string, name: string) => `${schema}.${name}`;

export function ExportDialog() {
  const target = useApp((s) => s.exportTarget);
  const setExportTarget = useApp((s) => s.setExportTarget);

  // Remounted per opening, so nothing about the last export leaks into the
  // next one: a directory kept would be welcome, a half-typed name would not.
  return (
    <Dialog.Root open={target !== null} onOpenChange={(o) => !o && setExportTarget(null)}>
      {target && <Body connectionId={target.connectionId} seed={target.keys} />}
    </Dialog.Root>
  );
}

function Body({ connectionId, seed }: { connectionId: string; seed: string[] }) {
  const connections = useApp((s) => s.connections);
  const open = useApp((s) => s.open);
  const schemas = useApp((s) => s.schemas);
  const tables = useApp((s) => s.tables);
  const loadAllTables = useApp((s) => s.loadAllTables);
  const setExportTarget = useApp((s) => s.setExportTarget);
  const setToast = useApp((s) => s.setToast);

  const config = connections.find((c) => c.id === connectionId);
  const database = open[connectionId]?.currentDatabase ?? config?.database ?? "export";

  const [checked, setChecked] = useState<Set<string>>(() => new Set(seed));
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [options, setOptions] = useState<ExportOptions>(() => ({
    format: "sql",
    mode: "full",
    dropIfExists: false,
    safe: false,
    layout: "single",
    compress: false,
    directory: "",
    fileName: defaultFileName(database, new Date()),
  }));

  const [counts, setCounts] = useState<Record<string, number>>({});
  const [overwrites, setOverwrites] = useState(false);
  const [running, setRunning] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The whole tree, not only the schemas the sidebar happens to have opened:
  // a dialog that lists three of twenty schemas is lying about the database.
  useEffect(() => {
    void loadAllTables(connectionId);
    void downloadDir()
      .then((dir) => setOptions((o) => (o.directory ? o : { ...o, directory: dir })))
      .catch(() => {
        /* No default folder is not a failure; the picker still works. */
      });
  }, [connectionId, loadAllTables]);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const schema of schemas[connectionId] ?? []) {
      for (const table of tables[`${connectionId}::${schema.name}`] ?? []) {
        // Functions are not in this list at all: there is nothing to dump.
        out.push({
          schema: schema.name,
          name: table.name,
          kind: table.kind,
          key: keyOf(schema.name, table.name),
        });
      }
    }
    return out;
  }, [connectionId, schemas, tables]);

  const needle = filter.trim().toLowerCase();
  const groups = useMemo(() => {
    const bySchema = new Map<string, Entry[]>();
    for (const entry of entries) {
      if (needle && !entry.name.toLowerCase().includes(needle)) continue;
      const list = bySchema.get(entry.schema) ?? [];
      list.push(entry);
      bySchema.set(entry.schema, list);
    }
    return [...bySchema.entries()];
  }, [entries, needle]);

  const picked = useMemo(
    () => entries.filter((e) => checked.has(e.key)),
    [entries, checked],
  );

  const plan = planExport(options, picked.length);

  // Estimates, not counts: the pager already treats a planner estimate as the
  // honest cheap answer, and walking every selected table to be exact would
  // cost more than the export.
  useEffect(() => {
    if (picked.length === 0 || picked.length > COUNT_LIMIT) return;
    let live = true;
    const t = setTimeout(() => {
      for (const entry of picked) {
        if (counts[entry.key] !== undefined || entry.kind !== "table") continue;
        void ipc
          .estimateRows(connectionId, entry.schema, entry.name)
          .then((r) => live && setCounts((c) => ({ ...c, [entry.key]: r.value })))
          .catch(() => {
            /* A missing estimate must not block the decision. */
          });
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // `counts` is read but deliberately not a trigger: writing into it would
    // otherwise re-run this on every answer that arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, connectionId]);

  // Asked of the backend, because the backend is what names the file.
  useEffect(() => {
    if (!options.directory || !options.fileName.trim()) {
      setOverwrites(false);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void ipc
        .exportTargetExists(
          options.directory,
          options.fileName,
          plan.effective.format,
          plan.effective.layout,
          plan.effective.compress,
        )
        .then((exists) => live && setOverwrites(exists))
        .catch(() => live && setOverwrites(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [
    options.directory,
    options.fileName,
    plan.effective.format,
    plan.effective.layout,
    plan.effective.compress,
  ]);

  const jobId = running?.jobId;
  useEffect(() => {
    if (!jobId) return;
    const stop = listen<ExportProgress>("export://progress", (event) => {
      if (event.payload.jobId !== jobId) return;
      setRunning((r) => (r ? { ...r, ...event.payload } : r));
    });
    return () => {
      void stop.then((off) => off());
    };
  }, [jobId]);

  const toggleOne = useCallback((key: string) => {
    setChecked((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  /** All or none: a half-checked schema row has no third thing to mean. */
  function toggleSchema(members: Entry[]) {
    const all = members.every((m) => checked.has(m.key));
    setChecked((current) => {
      const next = new Set(current);
      for (const m of members) {
        if (all) next.delete(m.key);
        else next.add(m.key);
      }
      return next;
    });
  }

  async function chooseFolder() {
    const folder = await openFolder({ directory: true, multiple: false });
    if (typeof folder === "string") setOptions((o) => ({ ...o, directory: folder }));
  }

  async function run() {
    if (picked.length === 0 || !options.directory) return;
    const objects: ObjectRef[] = picked.map((e) => ({
      schema: e.schema,
      name: e.name,
      kind: e.kind,
    }));
    const id = crypto.randomUUID();
    setError(null);
    setRunning({ jobId: id, table: "", done: 0, total: objects.length });
    try {
      const summary = await ipc.exportObjects(connectionId, id, {
        objects,
        ...plan.effective,
      });
      setToast({
        kind: "info",
        text: `Exported ${summary.tables} ${summary.tables === 1 ? "table" : "tables"} to ${plan.finalName} (${formatBytes(summary.bytes)}).`,
      });
      setExportTarget(null);
    } catch (e) {
      const failure = asDbError(e);
      // Stopping is not failing: nothing was left behind, and the dialog has
      // no news worth keeping the user in front of.
      if (failure.code === "CANCELLED") setExportTarget(null);
      else setError(failure.message);
    } finally {
      setRunning(null);
    }
  }

  const rows = picked.reduce((total, e) => total + (counts[e.key] ?? 0), 0);
  const counted = picked.filter((e) => counts[e.key] !== undefined).length;
  const ready = picked.length > 0 && !!options.directory && !!options.fileName.trim();

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="overlay-anim fixed inset-0 z-40 bg-black/50" />
      <Dialog.Content
        aria-describedby={undefined}
        // While an export runs the dialog is the only way to stop it, so it
        // does not go away by accident. Stop is still one click.
        onEscapeKeyDown={(e) => running && e.preventDefault()}
        onPointerDownOutside={(e) => running && e.preventDefault()}
        onInteractOutside={(e) => running && e.preventDefault()}
        className="sheet-anim fixed top-1/2 left-1/2 z-50 flex h-[min(560px,88vh)] w-[min(780px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-line bg-overlay shadow-2xl shadow-black/50"
      >
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-line-soft px-5">
          <Dialog.Title className="text-[14px] font-semibold text-ink">Export</Dialog.Title>
          <span className="font-mono text-[11px] text-ink-faint">
            {database} · {config?.host ?? ""}
          </span>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Which relations. A scan surface: filter, list, one box a row. */}
          <div className="flex w-64 shrink-0 flex-col border-r border-line-soft">
            <div className="p-2">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter tables"
                spellCheck={false}
                className={INPUT_CLS}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
              {groups.length === 0 ? (
                <p className="px-1.5 py-2 text-[11px] text-ink-faint">
                  {needle ? "No match" : "Reading tables…"}
                </p>
              ) : (
                groups.map(([schema, members]) => {
                  const on = members.filter((m) => checked.has(m.key)).length;
                  const shut = !!collapsed[schema];
                  return (
                    <div key={schema}>
                      <div className="flex items-center gap-1.5 rounded py-1 pr-1.5 pl-1 hover:bg-hover">
                        <button
                          onClick={() => setCollapsed((c) => ({ ...c, [schema]: !shut }))}
                          aria-expanded={!shut}
                          aria-label={`${shut ? "Show" : "Hide"} ${schema}`}
                          className="w-2.5 shrink-0 text-[9px] text-ink-faint"
                        >
                          {shut ? "▸" : "▾"}
                        </button>
                        <Box
                          state={on === 0 ? "off" : on === members.length ? "on" : "some"}
                          label={`Select every table in ${schema}`}
                          onToggle={() => toggleSchema(members)}
                        />
                        <span className="label-eyebrow truncate">{schema}</span>
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint tabular-nums">
                          {on}/{members.length}
                        </span>
                      </div>

                      {!shut &&
                        members.map((entry) => (
                          <button
                            key={entry.key}
                            onClick={() => toggleOne(entry.key)}
                            className="flex w-full items-center gap-2 rounded py-0.5 pr-1.5 pl-5 text-left text-[12px] text-ink-muted hover:bg-hover hover:text-ink"
                          >
                            <Box
                              state={checked.has(entry.key) ? "on" : "off"}
                              label={entry.name}
                              onToggle={() => toggleOne(entry.key)}
                            />
                            <span className="shrink-0 text-[10px] text-ink-faint" aria-hidden="true">
                              {KIND_GLYPH[entry.kind]}
                            </span>
                            <span className="truncate">{entry.name}</span>
                          </button>
                        ))}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* What the file should be. A form, read top to bottom. */}
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            <Field label="Format">
              <Segmented
                label="Format"
                value={options.format}
                onChange={(format) => setOptions((o) => ({ ...o, format }))}
                options={[
                  { value: "sql", label: "SQL" },
                  { value: "csv", label: "CSV" },
                ]}
              />
            </Field>

            <Field label="Include" note={plan.modeNote}>
              <Radio
                name="mode"
                disabled={plan.modeNote !== null}
                value={plan.effective.mode}
                onChange={(mode) => setOptions((o) => ({ ...o, mode }))}
                options={[
                  { value: "structure", label: "Structure only" },
                  { value: "full", label: "Structure and data" },
                  { value: "data", label: "Data only" },
                ]}
              />
              <Check
                checked={plan.effective.dropIfExists}
                disabled={plan.modeNote !== null || plan.dropNote !== null}
                onChange={(dropIfExists) => setOptions((o) => ({ ...o, dropIfExists }))}
                label="Include DROP statements"
              />
              {plan.dropNote && <p className="text-[11px] text-ink-faint">{plan.dropNote}</p>}
            </Field>

            {/* Its own band rather than a line under Include: what it changes
                is not what goes into the file but whether the file can be run
                against a database that already holds some of it. */}
            <Field label="Restore" note={plan.safeNote}>
              <Check
                checked={plan.effective.safe}
                disabled={plan.safeNote !== null}
                onChange={(safe) => setOptions((o) => ({ ...o, safe }))}
                label="Safe export"
              />
              {plan.safeNote === null && (
                <p className="text-[11px] text-ink-faint">
                  Creates only what is missing, brings rows it finds again up to date, and
                  puts the constraints back at the end. One transaction: a restore that
                  fails changes nothing.
                </p>
              )}
            </Field>

            <Field label="Output" note={plan.layoutNote}>
              <Radio
                name="layout"
                disabled={plan.layoutNote !== null}
                value={plan.effective.layout}
                onChange={(layout) => setOptions((o) => ({ ...o, layout }))}
                options={[
                  { value: "single", label: "One file" },
                  { value: "per-table", label: "One file per table" },
                ]}
              />
              <div className="flex items-center justify-between">
                <Check
                  checked={options.compress}
                  onChange={(compress) => setOptions((o) => ({ ...o, compress }))}
                  label="Compress"
                />
                <span className="font-mono text-[11px] text-ink-faint">
                  {plan.suffix || "—"}
                </span>
              </div>
            </Field>

            <Field label="Destination">
              <div className="flex items-center gap-2">
                <span
                  title={options.directory}
                  dir="rtl"
                  className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-ink-muted"
                >
                  {options.directory || "No folder chosen"}
                </span>
                <button
                  onClick={() => void chooseFolder()}
                  className="pressable shrink-0 rounded bg-field px-2.5 py-1 text-[12px] text-ink hover:bg-field-hover"
                >
                  Choose…
                </button>
              </div>

              <div className="flex items-center gap-2">
                <input
                  value={options.fileName}
                  onChange={(e) => setOptions((o) => ({ ...o, fileName: e.target.value }))}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="File name"
                  className={`${INPUT_CLS} font-mono`}
                />
                {/* Shown, never typed: a name typed with `.sql` already on it
                    is how a file ends up called `shop.sql.sql.gz`. */}
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                  {plan.suffix || "/"}
                </span>
              </div>

              {overwrites && (
                <p className="text-[11px] text-warn">
                  {plan.finalName} is already there. Exporting replaces it.
                </p>
              )}
            </Field>

            {error && (
              <p className="mt-1 rounded border border-danger/40 bg-danger/10 px-2.5 py-2 text-[12px] text-danger select-text">
                {error}
              </p>
            )}
          </div>
        </div>

        <div className="relative flex h-12 shrink-0 items-center justify-between border-t border-line-soft px-5">
          <p className="flex items-center gap-1.5 text-[12px] text-ink-muted">
            {running ? (
              <>
                <Spinner size={10} className="text-accent" label="Exporting" />
                Exporting
                {running.table && <span className="font-mono text-ink">{running.table}</span>}·{" "}
                {running.done} of {running.total}
              </>
            ) : picked.length === 0 ? (
              "Nothing selected"
            ) : (
              <>
                {picked.length} {picked.length === 1 ? "table" : "tables"}
                {counted > 0 && (
                  <>
                    {" · "}
                    <span className="font-mono text-ink tabular-nums">
                      ~{rows.toLocaleString()}
                    </span>{" "}
                    rows
                  </>
                )}
              </>
            )}
          </p>

          <div className="flex gap-2">
            {!running && (
              <Dialog.Close className="pressable rounded px-3 py-1.5 text-[12px] text-ink-muted hover:bg-hover hover:text-ink">
                Cancel
              </Dialog.Close>
            )}
            <button
              disabled={!running && !ready}
              onClick={() => (running ? void ipc.cancelExport(running.jobId) : void run())}
              className={[
                "pressable rounded px-3 py-1.5 text-[12px] font-medium disabled:pointer-events-none disabled:opacity-40",
                running ? "bg-field text-ink hover:bg-field-hover" : "bg-accent text-canvas",
              ].join(" ")}
            >
              {running ? "Stop" : "Export"}
            </button>
          </div>

          {/* On the dialog's own edge rather than in the body: the work is the
              whole dialog's, and a bar inside the form would push it about. */}
          {running && (
            <div
              className="absolute right-0 bottom-0 left-0 h-0.5 bg-accent transition-[width] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]"
              style={{ width: `${(running.done / Math.max(1, running.total)) * 100}%` }}
            />
          )}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

/** One labelled band of the form. The label is the only thing that repeats. */
function Field({
  label,
  note,
  children,
}: {
  label: string;
  note?: string | null;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5 flex flex-col gap-2 last:mb-0">
      <h2 className="label-eyebrow">{label}</h2>
      {children}
      {note && <p className="text-[11px] text-ink-faint">{note}</p>}
    </section>
  );
}

/**
 * A checkbox with a third state for "some of what is under this".
 *
 * Drawn rather than native because a native indeterminate box cannot be styled
 * to sit in this palette, and the three states have to be told apart at 13px.
 */
function Box({
  state,
  label,
  onToggle,
  disabled = false,
}: {
  state: "on" | "off" | "some";
  label: string;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <span
      role="checkbox"
      aria-checked={state === "some" ? "mixed" : state === "on"}
      aria-label={label}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          if (!disabled) onToggle();
        }
      }}
      className={[
        "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
        disabled ? "opacity-40" : "",
        state === "off"
          ? "border-line bg-transparent"
          : "border-accent bg-accent text-canvas",
      ].join(" ")}
    >
      {state === "on" && (
        <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
          <path
            d="M1.5 4.5l2 2 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {state === "some" && <span className="h-0.5 w-1.5 rounded-full bg-canvas" />}
    </span>
  );
}

function Check({
  checked,
  label,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  label: string;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={[
        "flex w-fit items-center gap-2 text-[12px]",
        disabled ? "text-ink-faint" : "cursor-default text-ink-muted hover:text-ink",
      ].join(" ")}
    >
      <Box
        state={checked ? "on" : "off"}
        label={label}
        disabled={disabled}
        onToggle={() => onChange(!checked)}
      />
      {label}
    </label>
  );
}

/** Exclusive options that read as a list, for the ones with a third choice. */
function Radio<T extends string>({
  name,
  value,
  options,
  onChange,
  disabled = false,
}: {
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const group = `${name}-${useId()}`;
  return (
    <div role="radiogroup" className="flex flex-col gap-1.5">
      {options.map((option) => {
        const on = option.value === value;
        return (
          <label
            key={option.value}
            className={[
              "flex w-fit items-center gap-2 text-[12px]",
              disabled ? "text-ink-faint" : "cursor-default text-ink-muted hover:text-ink",
            ].join(" ")}
          >
            <input
              type="radio"
              name={group}
              checked={on}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            <span
              aria-hidden="true"
              className={[
                "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                disabled ? "opacity-40" : "",
                on ? "border-accent" : "border-line",
              ].join(" ")}
            >
              {on && <span className="size-1.5 rounded-full bg-accent" />}
            </span>
            <span className={on && !disabled ? "text-ink" : undefined}>{option.label}</span>
          </label>
        );
      })}
    </div>
  );
}
