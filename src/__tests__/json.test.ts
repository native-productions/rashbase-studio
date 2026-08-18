/**
 * These four functions are the whole edit path for a jsonb cell: what the tree
 * writes back is what gets sent to the database. A path write that mutates in
 * place, or a coercion that turns a string into a number, corrupts a document
 * silently and the grid shows the corrupted version as if it were correct.
 */
import { expect, test } from "bun:test";
import { coerce, getAt, parseJson, preview, removeAt, setAt } from "@/lib/utils/json";

const DOC = { shipping: { city: "Jakarta", zip: "12190" }, items: [1, 2, 3], paid: true };

test("only objects and arrays are documents", () => {
  expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  expect(parseJson("[1,2]")).toEqual([1, 2]);

  // Valid JSON, but a tree around one scalar is noise, not structure.
  expect(parseJson("5")).toBeUndefined();
  expect(parseJson('"hi"')).toBeUndefined();
  expect(parseJson("true")).toBeUndefined();
  expect(parseJson("null")).toBeUndefined();
});

test("anything that is not JSON is not a document", () => {
  expect(parseJson("{not json")).toBeUndefined();
  expect(parseJson("")).toBeUndefined();
  expect(parseJson(null)).toBeUndefined();
  // A text column that happens to start mid-sentence must not be probed.
  expect(parseJson("select * from t")).toBeUndefined();
});

test("a write leaves the document it was given untouched", () => {
  const before = JSON.stringify(DOC);
  const after = setAt(DOC, ["shipping", "city"], "Bandung");
  expect(JSON.stringify(DOC)).toBe(before);
  expect(getAt(after, ["shipping", "city"])).toBe("Bandung");
  // Siblings survive the copy.
  expect(getAt(after, ["shipping", "zip"])).toBe("12190");
  expect(getAt(after, ["items", 2])).toBe(3);
});

test("a write past the end of an array appends to it", () => {
  expect(setAt(DOC, ["items", 3], 4)).toMatchObject({ items: [1, 2, 3, 4] });
});

test("a key can be added to a nested object", () => {
  expect(getAt(setAt(DOC, ["shipping", "country"], "ID"), ["shipping", "country"])).toBe("ID");
});

test("removing an array item closes the gap rather than leaving a hole", () => {
  // Leaving `undefined` in the slot would serialize as null and silently
  // change the document.
  expect(getAt(removeAt(DOC, ["items", 1]), ["items"])).toEqual([1, 3]);
});

test("removing a key removes only that key", () => {
  const after = removeAt(DOC, ["shipping", "zip"]);
  expect(getAt(after, ["shipping"])).toEqual({ city: "Jakarta" });
  expect(getAt(after, ["paid"])).toBe(true);
});

test("a typed leaf keeps its JSON type", () => {
  expect(coerce("true")).toBe(true);
  expect(coerce("12")).toBe(12);
  expect(coerce("null")).toBeNull();
  expect(coerce('{"a":1}')).toEqual({ a: 1 });
});

test("a leaf that is not JSON is the string that was typed", () => {
  expect(coerce("Jakarta")).toBe("Jakarta");
  // Quoting is how the literal string "true" stays reachable.
  expect(coerce('"true"')).toBe("true");
});

test("a collapsed container says what it holds", () => {
  expect(preview([1, 2, 3])).toBe("Array(3)");
  expect(preview({ city: "Jakarta" })).toBe('{city: "Jakarta"}');
  expect(preview({})).toBe("{}");
  expect(preview({ a: 1, b: 2, c: 3, d: 4 })).toBe("{a: 1, b: 2, c: 3, …}");
  expect(preview({ nested: { a: 1 } })).toBe("{nested: {…}}");
});
