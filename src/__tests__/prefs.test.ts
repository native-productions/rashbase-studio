/**
 * The failure this guards is silent: a stored blob written by an older build
 * loses one field, and the whole preference set resets to defaults — the user's
 * theme goes back to dark because their font scale was the thing that changed
 * shape. Every field is resolved on its own, and an unknown scale snaps rather
 * than falling through to 1.
 */
import { expect, test } from "bun:test";
import { clampScale, DEFAULT_PREFS, FONT_SCALES, parsePrefs } from "@/lib/prefs";

test("nothing stored is the app as it ships", () => {
  expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
  expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
  expect(parsePrefs("light")).toEqual(DEFAULT_PREFS);
  expect(parsePrefs([1, 2])).toEqual(DEFAULT_PREFS);
});

test("a field the build no longer understands does not take the others with it", () => {
  expect(parsePrefs({ theme: "light", fontScale: "big", tabBehaviour: "recycle" })).toEqual({
    theme: "light",
    fontScale: 1,
    tabBehaviour: "new",
  });
});

test("a partial object keeps what it has", () => {
  expect(parsePrefs({ tabBehaviour: "idle" })).toEqual({ ...DEFAULT_PREFS, tabBehaviour: "idle" });
});

/**
 * A scale off the list would leave every segment of the control unselected,
 * which reads as the preference having been lost.
 */
test("a scale snaps to the nearest offered step", () => {
  expect(clampScale(1.2)).toBe(1.15);
  expect(clampScale(2)).toBe(1.3);
  expect(clampScale(0.1)).toBe(0.9);
  expect(clampScale(Number.NaN)).toBe(1);
  for (const step of FONT_SCALES) expect(clampScale(step)).toBe(step);
});
