/**
 * What the export dialog's controls mean once the format has had its say.
 *
 * Two formats do not offer the same choices, and the dialog has to show that
 * without the controls appearing and vanishing under the pointer: a control
 * that disappears teaches nothing, a control that is off and says why teaches
 * the constraint. So the rules live here as data — which control is locked, to
 * what, and in what words — and the component only renders the answer.
 *
 * The file name is computed here too, and mirrors `final_name` in
 * `src-tauri/src/commands/export.rs`. The backend is the authority; this side
 * exists so the name shown is the name written.
 */

import type { ExportFormat, ExportLayout, ExportMode } from "@/lib/types";

export interface ExportOptions {
  format: ExportFormat;
  mode: ExportMode;
  dropIfExists: boolean;
  layout: ExportLayout;
  compress: boolean;
  directory: string;
  /** Without an extension. The suffix below is what gets appended. */
  fileName: string;
}

export interface ExportPlan {
  /** The options as they will be sent, after the format's rules are applied. */
  effective: ExportOptions;
  /** Why the include control is off, in the words shown under it. */
  modeNote: string | null;
  /** Why the layout control is fixed, in the words shown under it. */
  layoutNote: string | null;
  /** What is appended to the typed name. `/` means a folder, not a file. */
  suffix: string;
  /** The finished name, as it will appear in the chosen folder. */
  finalName: string;
}

/** `shop_2026-08-18`: the database, and the day, which is what a dump is. */
export function defaultFileName(database: string, today: Date): string {
  const iso = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");
  return `${database || "export"}_${iso}`;
}

/** Mirrors `final_name` in the backend, which decides the real one. */
export function finalName(
  stem: string,
  format: ExportFormat,
  layout: ExportLayout,
  compress: boolean,
): string {
  const body = format === "csv" ? "csv" : "sql";
  if (layout === "single") return compress ? `${stem}.${body}.gz` : `${stem}.${body}`;
  // A directory of loose files has no extension; compressing one archives it.
  return compress ? `${stem}.tar.gz` : stem;
}

/**
 * Applies the format's own constraints and says what it changed.
 *
 * CSV is rows and nothing else, and one table per file. Both facts are the
 * format's, not the user's, so the controls that no longer apply are held at
 * the only value that makes sense rather than being quietly ignored on send.
 */
export function planExport(options: ExportOptions, tableCount: number): ExportPlan {
  const csv = options.format === "csv";

  // Several tables in one CSV would be several header rows glued together,
  // which no reader can take apart again.
  const forcePerTable = csv && tableCount > 1;

  const effective: ExportOptions = {
    ...options,
    mode: csv ? "data" : options.mode,
    dropIfExists: csv ? false : options.dropIfExists,
    layout: forcePerTable ? "per-table" : options.layout,
  };

  const stem = options.fileName.trim();
  const name = finalName(stem, effective.format, effective.layout, effective.compress);

  return {
    effective,
    modeNote: csv ? "CSV carries rows only." : null,
    layoutNote: forcePerTable ? "CSV holds one table per file." : null,
    suffix: effective.layout === "per-table" && !effective.compress ? "/" : name.slice(stem.length),
    finalName: name,
  };
}

/** `2.4 MB`. Deliberately decimal: it is what the file manager will say. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
