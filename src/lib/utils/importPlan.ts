/**
 * What the import dialog's switches mean once the file has had its say.
 *
 * The mirror of `exportPlan.ts`, and it earns its place the same way: a switch
 * that no longer applies is held off with the reason written where the switch
 * is, rather than removed. "Skip ownership and grants" turned off under the
 * words *this file names no roles* teaches what the switch is for. The same
 * switch quietly missing teaches nothing and reads as a bug.
 *
 * Every number in here was counted off the file itself by the preflight, so
 * what the dialog promises and what the import does cannot drift apart.
 */

import { formatBytes } from "@/lib/utils/exportPlan";
import type { ImportPreflight, ImportSummary, Orm } from "@/lib/types";

export interface ImportOptions {
  /**
   * Whether foreign keys are checked once at the end rather than row by row.
   *
   * The switch this whole feature is about. A dump written table by table puts
   * a child row on the wire before its parent, and the key refuses it even
   * though the file, read to the end, is consistent.
   */
  holdForeignKeys: boolean;
  skipOwnership: boolean;
  skipMigrationHistory: boolean;
  resetSequences: boolean;
}

/** Everything on by default: a file being moved between servers needs all four. */
export const DEFAULT_OPTIONS: ImportOptions = {
  holdForeignKeys: true,
  skipOwnership: true,
  skipMigrationHistory: true,
  resetSequences: true,
};

export interface ImportSwitch {
  key: keyof ImportOptions;
  label: string;
  /** Why the switch exists, in the words shown under it. */
  note: string;
  /** Why it is off and cannot be turned on, or `null` if it can. */
  lockedNote: string | null;
}

export interface ImportPlan {
  /** The options as they will be sent, after the file's own rules apply. */
  effective: ImportOptions;
  switches: ImportSwitch[];
  /** `1,204 inserts · 38 tables`, or `null` before a file is chosen. */
  contents: string | null;
  /** `Written by Prisma.`, or `null` when nothing said so. */
  written: string | null;
  /** What the footer says while nothing is running. */
  footer: string;
  /** Why the file cannot be run, or `null` if it can. */
  blocked: string | null;
  /**
   * The sentence about the transaction, shown under the switches.
   *
   * It grows a clause when the file opens a transaction of its own — which the
   * safe export writes, so it is the common case for a file that came from
   * here. Those statements are not run: the file's `COMMIT` would end the
   * import's transaction partway through.
   */
  transactionNote: string;
}

const count = (n: number) => n.toLocaleString();
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** The bookkeeping table each ORM writes its own history into. */
const HISTORY_TABLE: Record<Orm, string> = {
  Prisma: "_prisma_migrations",
  Drizzle: "__drizzle_migrations",
  TypeORM: "migrations",
};

export function planImport(
  options: ImportOptions,
  preflight: ImportPreflight | null,
): ImportPlan {
  // Nothing chosen yet. The switches still show, at their defaults, so the
  // dialog does not rearrange itself the moment a file lands on it.
  const names = preflight?.orm ? HISTORY_TABLE[preflight.orm] : null;

  const ownershipLocked =
    preflight !== null && preflight.ownershipStatements === 0
      ? "This file names no roles."
      : null;

  const historyLocked =
    preflight === null
      ? null
      : preflight.orm === null
        ? "No migration table in this file."
        : null;

  const switches: ImportSwitch[] = [
    {
      key: "holdForeignKeys",
      label: "Hold foreign keys until the end",
      note: "Rows go in whatever order the file has them and the keys are checked once, at the end. A dump written table by table does not restore at all without this.",
      lockedNote: null,
    },
    {
      key: "skipOwnership",
      label: "Skip ownership and grants",
      note: ownershipLocked
        ? ""
        : preflight
          ? `${count(preflight.ownershipStatements)} ${plural(preflight.ownershipStatements, "statement")} naming a role that exists on the server this dump came from, not on this one.`
          : "`OWNER TO` and `GRANT` name roles that exist on the server the dump came from.",
      lockedNote: ownershipLocked,
    },
    {
      key: "skipMigrationHistory",
      label: "Skip migration history",
      note: historyLocked
        ? ""
        : names
          ? `${count(preflight?.migrationRows ?? 0)} ${plural(preflight?.migrationRows ?? 0, "row")} of ${names}, describing the other server's migrations. The table is still created; its rows are left to this database.`
          : "The ORM's own record of which migrations have run belongs to the server it ran them on.",
      lockedNote: historyLocked,
    },
    {
      key: "resetSequences",
      label: "Reset sequences afterwards",
      note: "An auto-incrementing column restored with its values leaves its sequence where it was, and the application's next insert collides. This moves each one past the highest value imported.",
      lockedNote: null,
    },
  ];

  const effective = { ...options };
  for (const item of switches) {
    if (item.lockedNote) effective[item.key] = false;
  }

  return {
    effective,
    switches,
    contents: describeContents(preflight),
    written: preflight?.orm ? `Written by ${preflight.orm}.` : null,
    footer: describeFooter(preflight),
    blocked: blockedReason(preflight),
    transactionNote: describeTransaction(preflight),
  };
}

const ONE_TRANSACTION =
  "The whole file runs in one transaction. If any statement is refused, nothing is applied.";

function describeTransaction(preflight: ImportPreflight | null): string {
  const own = preflight?.byKind.find(([kind]) => kind === "transaction")?.[1] ?? 0;
  if (own === 0) return ONE_TRANSACTION;
  return `${ONE_TRANSACTION} This file opens ${own === 1 ? "one of its own, which is" : `${count(own)} of its own, which are`} left out — a COMMIT inside the file would end the import's transaction partway through it.`;
}

/** `1,204 inserts · 38 create · 3 alter`, commonest first, at most three kinds. */
export function describeContents(preflight: ImportPreflight | null): string | null {
  if (!preflight || preflight.statements === 0) return null;
  const parts = preflight.byKind
    .slice(0, 3)
    .map(([kind, n]) => `${count(n)} ${kind}`);
  if (preflight.usesCopy) parts.push("rows in COPY blocks");
  return parts.join(" · ");
}

/**
 * The one line under the footer's left edge.
 *
 * States what will run, never what it will achieve. A count that came from
 * counting is the only kind this app puts in front of a number.
 */
function describeFooter(preflight: ImportPreflight | null): string {
  if (!preflight) return "No file chosen";
  if (preflight.parseError) return "This file could not be read to the end";
  if (preflight.statements === 0) return "Nothing to run";
  return `${count(preflight.statements)} ${plural(preflight.statements, "statement")} · ${formatBytes(preflight.bytes)}`;
}

function blockedReason(preflight: ImportPreflight | null): string | null {
  if (!preflight) return "Choose a file.";
  if (preflight.parseError) return preflight.parseError;
  if (preflight.statements === 0) return "This file holds no statements.";
  return null;
}

/**
 * The sentence shown when an import finishes.
 *
 * Every clause is something that was counted. `keyHold` says which of the two
 * mechanisms the server allowed, because the switch asked for an outcome and
 * only the server decides how it is reached — reporting one as if it were the
 * only one would be a claim rather than a measurement.
 */
export function describeSummary(summary: ImportSummary): string {
  const parts = [
    `${count(summary.statements)} ${plural(summary.statements, "statement")}`,
  ];
  if (summary.rows > 0) parts.push(`${count(summary.rows)} ${plural(summary.rows, "row")}`);
  if (summary.skipped > 0) parts.push(`${count(summary.skipped)} skipped`);
  if (summary.sequencesReset > 0) {
    parts.push(
      `${count(summary.sequencesReset)} ${plural(summary.sequencesReset, "sequence")} reset`,
    );
  }
  const sentence = `Imported ${parts.join(" · ")}.`;

  // Said only when the server refused the mechanism that changes nothing. The
  // fallback alters each foreign key to deferrable and puts it back, which is a
  // real thing to have happened to the schema and worth one sentence.
  if (summary.keyHold === "deferred") {
    return `${sentence} Foreign keys were deferred rather than disabled: this server did not allow session_replication_role.`;
  }
  return sentence;
}

/**
 * How far along, as a fraction, or `null` when there is no denominator.
 *
 * `null` rather than zero when the preflight did not run: a bar sitting at the
 * left is a measurement of no progress, which is a different claim from having
 * nothing to measure against.
 */
export function importFraction(statements: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.min(1, statements / total);
}
