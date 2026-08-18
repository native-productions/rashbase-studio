/**
 * The palette is how tables are opened, so a scoring drift shows up as "the
 * app cannot find my table" rather than as a ranking that is slightly off.
 */
import { expect, test } from "bun:test";
import { fuzzyScore } from "@/lib/utils/fuzzy";

/** Ranks `names` best first, dropping the ones that do not match at all. */
const rank = (needle: string, names: string[]) =>
  names
    .map((name) => ({ name, score: fuzzyScore(needle, name) }))
    .filter((r): r is { name: string; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.name);

test("an underscore in the name is not something the user has to type", () => {
  // The bug this whole module exists for.
  expect(fuzzyScore("aiproj", "ai_project")).not.toBeNull();
  expect(fuzzyScore("aip", "ai_project")).not.toBeNull();
});

test("the query may be typed with any separator, or none", () => {
  const target = "ai_project";
  const scores = ["aiproj", "ai proj", "ai_proj", "ai-proj"].map((q) => fuzzyScore(q, target));
  expect(new Set(scores).size).toBe(1);
  expect(scores[0]).not.toBeNull();
});

test("a character not in the name at all is no match", () => {
  expect(fuzzyScore("zzz", "ai_project")).toBeNull();
  // Order matters: the letters are all there, in the wrong sequence.
  expect(fuzzyScore("jorp", "ai_project")).toBeNull();
});

test("an empty query matches everything rather than nothing", () => {
  expect(fuzzyScore("", "ai_project")).toBe(0);
  expect(fuzzyScore("  ", "ai_project")).toBe(0);
});

test("word starts outrank letters scattered through the name", () => {
  // Both contain a-p-i in order. Only one of them is what "api" means.
  expect(rank("api", ["ai_project", "api_key"])[0]).toBe("api_key");
});

test("the shorter of two equally good names comes first", () => {
  expect(rank("user", ["users", "user_session_audit_log"])[0]).toBe("users");
});

test("case is not something the user has to get right", () => {
  expect(fuzzyScore("AIPROJ", "ai_project")).toBe(fuzzyScore("aiproj", "AI_PROJECT"));
});
