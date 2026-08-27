/**
 * The rules the import dialog draws from, and the two failure modes they hold
 * down.
 *
 * A switch that stays on when the file gives it nothing to do sends a request
 * asking the backend to skip statements that are not there — harmless, and it
 * puts a promise in front of the user that the summary then contradicts.
 *
 * A switch that stays on when the file gives it something *dangerous* to do is
 * the real one: "skip migration history" against a file with no ORM in it would
 * have to guess which table it meant, and the only table it could guess at is
 * one called `migrations`, which is a name anyone might give a real table.
 */

import { expect, test } from "bun:test";
import {
  DEFAULT_OPTIONS,
  describeContents,
  describeSummary,
  importFraction,
  planImport,
  type ImportOptions,
} from "@/lib/utils/importPlan";
import type { ImportPreflight, ImportSummary } from "@/lib/types";

function preflight(over: Partial<ImportPreflight> = {}): ImportPreflight {
  return {
    bytes: 12_400_000,
    compressed: false,
    statements: 1204,
    byKind: [
      ["insert", 1150],
      ["create", 38],
      ["alter", 16],
    ],
    tables: [
      ["public.order_items", 800],
      ["public.orders", 350],
    ],
    tableCount: 2,
    schemas: ["public"],
    usesCopy: false,
    orm: "Prisma",
    ownershipStatements: 12,
    migrationRows: 7,
    parseError: null,
    ...over,
  };
}

const ALL_ON: ImportOptions = { ...DEFAULT_OPTIONS };

const lock = (p: ImportPreflight | null, key: keyof ImportOptions) =>
  planImport(ALL_ON, p).switches.find((s) => s.key === key)?.lockedNote ?? null;

// ---------------------------------------------------------------------------
// What the file locks
// ---------------------------------------------------------------------------

test("a file with no ORM in it cannot have its migration history skipped", () => {
  const plan = planImport(ALL_ON, preflight({ orm: null }));
  expect(lock(preflight({ orm: null }), "skipMigrationHistory")).toBe(
    "No migration table in this file.",
  );
  // And the request that goes out says so, rather than asking the backend to
  // guess which table was meant.
  expect(plan.effective.skipMigrationHistory).toBe(false);
});

test("a file naming no roles cannot have its ownership skipped", () => {
  const p = preflight({ ownershipStatements: 0 });
  expect(lock(p, "skipOwnership")).toBe("This file names no roles.");
  expect(planImport(ALL_ON, p).effective.skipOwnership).toBe(false);
});

test("the two switches nothing can lock stay under the user's hand", () => {
  const p = preflight();
  expect(lock(p, "holdForeignKeys")).toBeNull();
  expect(lock(p, "resetSequences")).toBeNull();
  expect(planImport(ALL_ON, p).effective.holdForeignKeys).toBe(true);
  expect(planImport(ALL_ON, p).effective.resetSequences).toBe(true);
});

test("a switch the user turned off stays off", () => {
  const plan = planImport({ ...ALL_ON, resetSequences: false }, preflight());
  expect(plan.effective.resetSequences).toBe(false);
  expect(plan.effective.holdForeignKeys).toBe(true);
});

test("every switch is shown before a file is chosen, and none is locked", () => {
  const plan = planImport(ALL_ON, null);
  expect(plan.switches).toHaveLength(4);
  expect(plan.switches.every((s) => s.lockedNote === null)).toBe(true);
});

// ---------------------------------------------------------------------------
// What the file says about itself
// ---------------------------------------------------------------------------

test("the file's contents read commonest first", () => {
  expect(describeContents(preflight())).toBe("1,150 insert · 38 create · 16 alter");
});

test("a COPY dump says its rows are not in the statement count", () => {
  const text = describeContents(preflight({ usesCopy: true, byKind: [["copy", 38]] }));
  expect(text).toBe("38 copy · rows in COPY blocks");
});

test("an empty file describes itself as empty rather than as nothing", () => {
  expect(describeContents(preflight({ statements: 0, byKind: [] }))).toBeNull();
  expect(planImport(ALL_ON, preflight({ statements: 0 })).blocked).toBe(
    "This file holds no statements.",
  );
});

test("a file that could not be read is blocked with the reason it stopped", () => {
  const p = preflight({ parseError: "Line 4,182 of this file is not UTF-8." });
  expect(planImport(ALL_ON, p).blocked).toBe("Line 4,182 of this file is not UTF-8.");
  expect(planImport(ALL_ON, p).footer).toBe("This file could not be read to the end");
});

test("nothing chosen is blocked without being an error", () => {
  const plan = planImport(ALL_ON, null);
  expect(plan.blocked).toBe("Choose a file.");
  expect(plan.footer).toBe("No file chosen");
  expect(plan.contents).toBeNull();
});

test("the ORM is named as a fact, not as a guess", () => {
  expect(planImport(ALL_ON, preflight()).written).toBe("Written by Prisma.");
  expect(planImport(ALL_ON, preflight({ orm: null })).written).toBeNull();
});

// ---------------------------------------------------------------------------
// What the import reports afterwards
// ---------------------------------------------------------------------------

function summary(over: Partial<ImportSummary> = {}): ImportSummary {
  return {
    statements: 1204,
    skipped: 19,
    rows: 38_412,
    sequencesReset: 6,
    keyHold: "session_replication_role",
    durationMs: 8_420,
    ...over,
  };
}

test("the summary states only what was counted", () => {
  expect(describeSummary(summary())).toBe(
    "Imported 1,204 statements · 38,412 rows · 19 skipped · 6 sequences reset.",
  );
});

test("a clause with nothing behind it is left out rather than shown as zero", () => {
  expect(describeSummary(summary({ skipped: 0, sequencesReset: 0, rows: 0 }))).toBe(
    "Imported 1,204 statements.",
  );
});

/**
 * Two mechanisms can hold the keys and the server picks. Reporting the one that
 * altered every foreign key and put it back as if it were the one that touched
 * nothing would be a claim rather than a measurement.
 */
test("the fallback mechanism is reported, and the clean one is not", () => {
  expect(describeSummary(summary({ keyHold: "deferred" }))).toContain(
    "Foreign keys were deferred rather than disabled",
  );
  expect(describeSummary(summary({ keyHold: "session_replication_role" }))).not.toContain(
    "Foreign keys",
  );
  expect(describeSummary(summary({ keyHold: null }))).not.toContain("Foreign keys");
});

test("one of a thing is not one of things", () => {
  expect(describeSummary(summary({ statements: 1, rows: 1, skipped: 0, sequencesReset: 1 }))).toBe(
    "Imported 1 statement · 1 row · 1 sequence reset.",
  );
});

/**
 * The file this application's own safe export writes carries `BEGIN;` and
 * `COMMIT;`. Those are not run, and the dialog has to say so — a user who sees
 * `2 transaction` in the counts and no explanation is a user wondering whether
 * their transaction survived.
 */
test("a file that opens its own transaction says what happens to it", () => {
  const plain = planImport(ALL_ON, preflight());
  expect(plain.transactionNote).toBe(
    "The whole file runs in one transaction. If any statement is refused, nothing is applied.",
  );

  const own = planImport(
    ALL_ON,
    preflight({ byKind: [["insert", 1150], ["transaction", 2]] }),
  );
  expect(own.transactionNote).toContain("opens 2 of its own, which are left out");

  const one = planImport(ALL_ON, preflight({ byKind: [["transaction", 1]] }));
  expect(one.transactionNote).toContain("opens one of its own, which is left out");
});

/**
 * A bar at the left is a measurement of no progress. Having nothing to measure
 * against is a different claim, and the dialog has to be able to tell them
 * apart or it draws a bar that never moves.
 */
test("progress with no denominator is absent rather than zero", () => {
  expect(importFraction(0, 0)).toBeNull();
  expect(importFraction(400, 0)).toBeNull();
  expect(importFraction(0, 1204)).toBe(0);
  expect(importFraction(602, 1204)).toBe(0.5);
  // A file that turned out to hold more than the preflight counted still
  // reports a full bar rather than one past its own end.
  expect(importFraction(1300, 1204)).toBe(1);
});
