/**
 * The rules that decide which keys a filter reaches, and which cell holds what.
 *
 * Every case here is one where getting it wrong is silent: a glob that stops
 * matching returns an empty keyspace rather than an error, and a column that
 * shifts by one puts a TTL under the size header. The grid draws whatever this
 * layer produces without checking it, which is exactly why it is checked here.
 */
import { expect, test } from "bun:test";
import {
  KEY_COL,
  KEY_COLUMNS,
  deletePreview,
  escapeGlob,
  formatTtl,
  keyEditableReason,
  keyFilterFrom,
  keyPageToResult,
  keyRowIdentity,
  parseTtl,
  stagedKeysIn,
} from "@/lib/utils/redis";
import type { Filter, KeyEntry, KeyPage } from "@/lib/types";

let seq = 0;
const filter = (column: string | null, op: Filter["op"], ...values: string[]): Filter => ({
  id: `f-${++seq}`,
  column,
  op,
  values,
});

const entry = (over: Partial<KeyEntry> = {}): KeyEntry => ({
  key: "nvp:na:user:1",
  kind: "hash",
  ttl: -1,
  size: 4,
  preview: '{"name":"dwi"}',
  ...over,
});

const page = (keys: KeyEntry[], over: Partial<KeyPage> = {}): KeyPage => ({
  keys,
  cursor: 0,
  scanned: keys.length,
  exhausted: true,
  total: null,
  ...over,
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * The gesture the whole feature was asked for. A glob typed by hand has to
 * reach the server exactly as typed: escape it and `nvp:na:*` matches one key
 * literally named with an asterisk, which is an empty result and no error.
 */
test("a matches filter sends the glob verbatim", () => {
  expect(keyFilterFrom([filter("key", "matches", "nvp:na:*")])).toEqual({
    pattern: "nvp:na:*",
    contains: null,
    caseSensitive: false,
  });
});

test("a prefix filter supplies the trailing star", () => {
  expect(keyFilterFrom([filter("key", "prefix", "nvp:na:")]).pattern).toBe("nvp:na:*");
});

/**
 * The mirror of `matches`: here the value is literal text, so a `*` inside it
 * is part of the key name and not a wildcard.
 */
test("prefix and contains escape glob metacharacters, matches does not", () => {
  expect(keyFilterFrom([filter("key", "prefix", "rate*limit")]).pattern).toBe(
    "rate\\*limit*",
  );
  expect(keyFilterFrom([filter("key", "contains", "a?b")]).pattern).toBe("*a\\?b*");
  expect(keyFilterFrom([filter("key", "matches", "a?b")]).pattern).toBe("a?b");
});

/**
 * The two fields cost differently, which is the reason they are two fields: a
 * pattern is pushed down and nearly free, a value search reads everything the
 * walk touches.
 */
test("a value filter becomes contains and leaves the pattern alone", () => {
  expect(keyFilterFrom([filter("value", "contains", "dwi")])).toEqual({
    pattern: null,
    contains: "dwi",
    caseSensitive: false,
  });
});

test("a key pattern and a value search travel together", () => {
  const f = keyFilterFrom([
    filter("key", "prefix", "nvp:na:"),
    filter("value", "contains", "dwi"),
  ]);
  expect(f.pattern).toBe("nvp:na:*");
  expect(f.contains).toBe("dwi");
});

/**
 * The server takes exactly one MATCH. Two key conditions cannot both be sent,
 * so the last one typed wins — visibly, in the chip that is still on the bar —
 * rather than being ANDed into something the server cannot express.
 */
test("the last key condition wins, because the server takes one glob", () => {
  const f = keyFilterFrom([
    filter("key", "prefix", "a:"),
    filter("key", "prefix", "b:"),
  ]);
  expect(f.pattern).toBe("b:*");
});

/** A filter with nothing typed narrows nothing, and must not become `**`. */
test("an empty filter value is ignored rather than sent as a wildcard", () => {
  expect(keyFilterFrom([filter("key", "prefix", "")])).toEqual({
    pattern: null,
    contains: null,
    caseSensitive: false,
  });
  expect(keyFilterFrom([])).toEqual({ pattern: null, contains: null, caseSensitive: false });
});

/** An unnamed column means the key: the filter you reach for knowing nothing. */
test("a filter with no column named is about the key", () => {
  expect(keyFilterFrom([filter(null, "contains", "session")]).pattern).toBe("*session*");
});

test("escapeGlob leaves ordinary key characters untouched", () => {
  expect(escapeGlob("nvp:na:user-1@host.id")).toBe("nvp:na:user-1@host.id");
  expect(escapeGlob("a[b]c")).toBe("a\\[b\\]c");
});

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

/**
 * `-1` and `-2` are Redis sentinels, not durations. Printed raw, a column of
 * `-1`s reads as an error in the one column whose job is to be scannable.
 */
test("the TTL sentinels are printed as words", () => {
  expect(formatTtl(-1)).toBe("never");
  expect(formatTtl(-2)).toBe("gone");
  // Not read is not the same as no expiry, and stays distinct all the way out.
  expect(formatTtl(null)).toBeNull();
});

test("a TTL is shown to two units, largest first", () => {
  expect(formatTtl(45)).toBe("45s");
  expect(formatTtl(90)).toBe("1m 30s");
  expect(formatTtl(3600)).toBe("1h");
  expect(formatTtl(187_200)).toBe("2d 4h");
});

/** The editor has to take back what the column printed, or the value has to be
 *  retyped from scratch every time it is touched. */
test("parseTtl accepts what formatTtl prints", () => {
  expect(parseTtl("never")).toBeNull();
  expect(parseTtl("")).toBeNull();
  expect(parseTtl("900")).toBe(900);
  expect(parseTtl("1m 30s")).toBe(90);
  expect(parseTtl("2d 4h")).toBe(187_200);
});

/** A typo must not become a duration: half-parsing "15 minutes" into 15 would
 *  set an expiry nobody asked for. */
test("parseTtl refuses text that is only partly a duration", () => {
  expect(parseTtl("soon")).toBeUndefined();
  expect(parseTtl("15 minutes")).toBeUndefined();
  expect(parseTtl("1h and a bit")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Page to result
// ---------------------------------------------------------------------------

/**
 * The conversion the whole feature rests on. A column out of order here puts a
 * TTL under the size header, and nothing downstream would notice.
 */
test("a key page becomes the five columns the grid draws, in order", () => {
  const result = keyPageToResult(page([entry()]));
  expect(result.columns.map((c) => c.name)).toEqual(["key", "type", "ttl", "size", "value"]);
  expect(result.rows[0]).toEqual(["nvp:na:user:1", "hash", "never", "4", '{"name":"dwi"}']);
  expect(result.columns[KEY_COL.ttl]!.typeClass).toBe("number");
  expect(result.columns[KEY_COL.value]!.typeClass).toBe("json");
});

/** A value that was not read is NULL, drawn in italics — not the text "null". */
test("an unread value stays null rather than becoming a string", () => {
  const result = keyPageToResult(page([entry({ preview: null, size: null, ttl: null })]));
  expect(result.rows[0]![KEY_COL.value]).toBeNull();
  expect(result.rows[0]![KEY_COL.size]).toBeNull();
  expect(result.rows[0]![KEY_COL.ttl]).toBeNull();
});

test("an empty page still carries its columns, so the grid draws headers", () => {
  const result = keyPageToResult(page([]));
  expect(result.rows).toHaveLength(0);
  expect(result.columns).toHaveLength(KEY_COLUMNS.length);
});

// ---------------------------------------------------------------------------
// Identity, staging, preview
// ---------------------------------------------------------------------------

/** A key is its own identity, which is stronger than the primary key the SQL
 *  path has to go looking for. */
test("a row is identified by its key alone", () => {
  const result = keyPageToResult(page([entry({ key: "a:1" })]));
  expect(keyRowIdentity(result, 0)).toEqual([{ column: "key", value: "a:1" }]);
  expect(keyRowIdentity(result, 9)).toBeNull();
});

test("staged keys come back in the order they appear on screen", () => {
  const result = keyPageToResult(
    page([entry({ key: "a" }), entry({ key: "b" }), entry({ key: "c" })]),
  );
  expect(stagedKeysIn(result, new Set(["c", "a"]))).toEqual(["a", "c"]);
  expect(stagedKeysIn(result, new Set())).toEqual([]);
});

/**
 * The status bar prints this, and it is the whole confirmation for a delete.
 * It has to be something that could be pasted into the console and run.
 */
test("the delete preview quotes only keys that need it", () => {
  expect(deletePreview(["user:1", "user:2"])).toBe("DEL user:1 user:2");
  expect(deletePreview(["a b"])).toBe('DEL "a b"');
});

/** Elided in the middle, not the end: the first and last key are what say which
 *  range was marked. */
test("a long delete preview keeps the first and last key", () => {
  const preview = deletePreview(["a", "b", "c", "d", "e", "f"]);
  expect(preview).toBe("DEL a b c … f");
});

/**
 * Refusing in silence is the worst version of this: the user double-clicks a
 * set and nothing happens with nothing on screen saying why.
 */
test("only strings and hashes are editable, and the rest say why", () => {
  expect(keyEditableReason("string", "value")).toBeNull();
  expect(keyEditableReason("hash", "value")).toBeNull();
  expect(keyEditableReason("zset", "value")).toContain("console");
  // TTL is editable whatever the type holds.
  expect(keyEditableReason("list", "ttl")).toBeNull();
  expect(keyEditableReason("string", "key")).toContain("cannot be renamed");
  expect(keyEditableReason("string", "size")).toContain("describes the key");
});
