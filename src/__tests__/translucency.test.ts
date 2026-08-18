/**
 * The default is the only interesting part: it has to be on where the effect
 * exists and off where it does not, and it has to lose to whatever the user
 * last chose. Getting that backwards ships a Linux build whose chrome is
 * mixed at 72% over nothing.
 */
import { expect, test } from "bun:test";
import { resolveTranslucency } from "@/lib/translucency";

const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)";

test("with nothing stored, it follows what the platform can actually do", () => {
  expect(resolveTranslucency(null, MAC)).toBe(true);
  expect(resolveTranslucency(null, WINDOWS)).toBe(true);
  expect(resolveTranslucency(null, LINUX)).toBe(false);
});

test("a stored answer beats the platform default, both directions", () => {
  expect(resolveTranslucency("off", MAC)).toBe(false);
  expect(resolveTranslucency("on", LINUX)).toBe(true);
});

/** Anything else was written by a version of this app that no longer exists. */
test("a value it does not recognise falls back to the platform default", () => {
  expect(resolveTranslucency("", MAC)).toBe(true);
  expect(resolveTranslucency("yes", LINUX)).toBe(false);
});
