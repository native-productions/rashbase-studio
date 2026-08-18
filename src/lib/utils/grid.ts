import { CH, MAX_AUTO_COL, MIN_COL, WIDTH_SAMPLE } from "@/lib/constants/grid";
import type { ColumnMeta } from "@/lib/types";

/**
 * Widths are measured once per result set from a sample of rows. Scanning all
 * 100k would cost more than it improves the fit, and rows past the first few
 * hundred rarely change the answer.
 */
export function autoWidths(columns: ColumnMeta[], rows: (string | null)[][]): number[] {
  const sample = rows.slice(0, WIDTH_SAMPLE);
  return columns.map((col, i) => {
    let longest = col.name.length + 4;
    for (const row of sample) {
      const v = row[i];
      if (v && v.length > longest) longest = v.length;
    }
    return Math.min(MAX_AUTO_COL, Math.max(MIN_COL, Math.round(longest * CH) + 20));
  });
}
