/**
 * Column fitting runs once per result set and decides the layout of every cell
 * on screen. When it drifts the whole grid is wrong at once, and the failure
 * looks like a rendering bug rather than an arithmetic one.
 */
import { expect, test } from "bun:test";
import { MAX_AUTO_COL, MIN_COL, WIDTH_SAMPLE } from "@/lib/constants/grid";
import { autoWidths } from "@/lib/utils/grid";
import type { ColumnMeta } from "@/lib/types";

const col = (name: string): ColumnMeta => ({ name, typeName: "text", typeClass: "text" });

test("a column narrower than the minimum is widened to it", () => {
  // Nothing may come out under MIN_COL: a column too narrow to hold the resize
  // handle cannot be widened back by hand.
  expect(autoWidths([col("")], [[""]])).toEqual([MIN_COL]);
});

test("a column wider than the maximum is capped at it", () => {
  const [width] = autoWidths([col("x")], [["y".repeat(200)]]);
  expect(width).toBe(MAX_AUTO_COL);
});

test("the header wins when it is longer than every value", () => {
  // 20 characters plus the 4 the sort marker and type label need.
  expect(autoWidths([col("created_at_timestamp")], [["1"]])).toEqual([193]);
});

test("rows past the sample cannot change the answer", () => {
  const rows = Array.from({ length: WIDTH_SAMPLE + 1 }, () => ["aa"]);
  rows[WIDTH_SAMPLE] = ["z".repeat(300)];

  // Scanning every row would have found the long one and hit the cap. The point
  // of the sample is that a 100k-row result costs the same as a 200-row one.
  expect(autoWidths([col("n")], rows)).toEqual([MIN_COL]);
});

test("each column is measured against its own values", () => {
  const widths = autoWidths(
    [col("a"), col("b")],
    [
      ["1", "a much longer value in the second column"],
      ["2", "short"],
    ],
  );
  expect(widths[0]).toBe(MIN_COL);
  expect(widths[1]).toBeGreaterThan(MIN_COL);
});

test("no columns is no widths, not a crash", () => {
  expect(autoWidths([], [])).toEqual([]);
});
