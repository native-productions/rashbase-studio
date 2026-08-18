import { expect, test } from "bun:test";
import { rangeBetween, toggle } from "@/lib/utils/selection";
import {
  defaultFileName,
  finalName,
  formatBytes,
  planExport,
  type ExportOptions,
} from "@/lib/utils/exportPlan";

const ORDER = ["public.users", "public.orders", "public.carts", "public.jobs"];

const OPTIONS: ExportOptions = {
  format: "sql",
  mode: "full",
  dropIfExists: false,
  safe: false,
  layout: "single",
  compress: false,
  directory: "/tmp",
  fileName: "shop",
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test("a range covers everything between the anchor and the row clicked", () => {
  expect(rangeBetween(ORDER, "public.users", "public.carts")).toEqual([
    "public.users",
    "public.orders",
    "public.carts",
  ]);
});

test("a range read upward is the same range", () => {
  expect(rangeBetween(ORDER, "public.carts", "public.users")).toEqual([
    "public.users",
    "public.orders",
    "public.carts",
  ]);
});

test("a shift-click with no anchor picks the one row rather than nothing", () => {
  // Selecting nothing would look like the modifier being ignored.
  expect(rangeBetween(ORDER, null, "public.orders")).toEqual(["public.orders"]);
});

test("an anchor filtered off the screen falls back to the row clicked", () => {
  expect(rangeBetween(ORDER, "public.gone", "public.jobs")).toEqual(["public.jobs"]);
});

test("a row that is not on screen selects nothing", () => {
  expect(rangeBetween(ORDER, "public.users", "public.gone")).toEqual([]);
});

test("toggling adds and removes one row and leaves the rest alone", () => {
  expect(toggle(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  expect(toggle(["a", "b", "c"], "b")).toEqual(["a", "c"]);
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

test("the file name is the database and the day", () => {
  expect(defaultFileName("shop", new Date(2026, 7, 18))).toBe("shop_2026-08-18");
  // Month and day are padded, or the name sorts wrong in a folder listing.
  expect(defaultFileName("shop", new Date(2026, 0, 3))).toBe("shop_2026-01-03");
});

test("every destination gets the extension the backend will write", () => {
  expect(finalName("shop", "sql", "single", false)).toBe("shop.sql");
  expect(finalName("shop", "sql", "single", true)).toBe("shop.sql.gz");
  expect(finalName("shop", "csv", "single", false)).toBe("shop.csv");
  expect(finalName("shop", "csv", "single", true)).toBe("shop.csv.gz");
  // A folder of loose files has no extension; compressing one archives it.
  expect(finalName("shop", "sql", "per-table", false)).toBe("shop");
  expect(finalName("shop", "sql", "per-table", true)).toBe("shop.tar.gz");
  expect(finalName("shop", "csv", "per-table", true)).toBe("shop.tar.gz");
});

test("SQL leaves every control to the user", () => {
  const plan = planExport({ ...OPTIONS, mode: "structure", dropIfExists: true }, 4);
  expect(plan.effective.mode).toBe("structure");
  expect(plan.effective.dropIfExists).toBe(true);
  expect(plan.modeNote).toBeNull();
  expect(plan.layoutNote).toBeNull();
  expect(plan.suffix).toBe(".sql");
});

test("CSV carries rows only, and says so where the schema control was", () => {
  const plan = planExport({ ...OPTIONS, format: "csv", mode: "structure", dropIfExists: true }, 1);
  expect(plan.effective.mode).toBe("data");
  expect(plan.effective.dropIfExists).toBe(false);
  expect(plan.modeNote).toBe("CSV carries rows only.");
});

test("several tables as CSV is forced to one file each", () => {
  // Glued together they would be several header rows in one file, which no
  // reader can take apart again.
  const plan = planExport({ ...OPTIONS, format: "csv" }, 3);
  expect(plan.effective.layout).toBe("per-table");
  expect(plan.layoutNote).toBe("CSV holds one table per file.");

  // One table is still a file the user can open by double clicking it.
  const single = planExport({ ...OPTIONS, format: "csv" }, 1);
  expect(single.effective.layout).toBe("single");
  expect(single.layoutNote).toBeNull();
});

test("a safe export is held to one file, and says why", () => {
  // Loose per-relation files have no restore order and no transaction around
  // them, which is the whole of what safe mode is buying.
  const plan = planExport({ ...OPTIONS, safe: true, layout: "per-table" }, 4);
  expect(plan.effective.layout).toBe("single");
  expect(plan.layoutNote).toBe("A safe export is one file, in restore order.");
  expect(plan.suffix).toBe(".sql");
});

test("a safe export never drops what it is restoring over", () => {
  // The drop would take the target's rows with it, which is the one outcome
  // the mode exists to rule out.
  const plan = planExport({ ...OPTIONS, safe: true, dropIfExists: true }, 2);
  expect(plan.effective.dropIfExists).toBe(false);
  expect(plan.dropNote).toBe("A safe export never drops what is already there.");
});

test("CSV has no statements to guard, so safe is held off", () => {
  const plan = planExport({ ...OPTIONS, format: "csv", safe: true }, 1);
  expect(plan.effective.safe).toBe(false);
  expect(plan.safeNote).toBe("Safe export applies to SQL.");
  // And CSV's own rule still decides the layout.
  expect(planExport({ ...OPTIONS, format: "csv", safe: true }, 3).effective.layout).toBe(
    "per-table",
  );
});

test("the suffix shown beside the name is the one that gets appended", () => {
  expect(planExport({ ...OPTIONS, compress: true }, 1).suffix).toBe(".sql.gz");
  expect(planExport({ ...OPTIONS, layout: "per-table", compress: true }, 2).suffix).toBe(".tar.gz");
  // A folder, so the name gains nothing but is still not a file.
  expect(planExport({ ...OPTIONS, layout: "per-table" }, 2).suffix).toBe("/");
});

test("a name typed with spaces still names the file it will write", () => {
  const plan = planExport({ ...OPTIONS, fileName: "  shop  " }, 1);
  expect(plan.finalName).toBe("shop.sql");
});

test("sizes read the way the file manager will report them", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2_400_000)).toBe("2.4 MB");
  expect(formatBytes(45_000_000)).toBe("45 MB");
});
