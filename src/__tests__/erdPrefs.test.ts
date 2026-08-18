import { beforeEach, expect, test } from "bun:test";
import { DEFAULT_PREFS, loadErdPrefs, prefsKey, saveErdPrefs } from "@/lib/erdPrefs";

/**
 * Bun has no DOM, and this module is the one piece of the diagram whose whole
 * job is to survive the window going away. A fake store is enough: what is
 * under test is the read-modify-write and the defensive parse, not the browser.
 */
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

beforeEach(() => store.clear());

test("gives back what was written for that schema", () => {
  const key = prefsKey("conn-1", "public");
  saveErdPrefs(key, { positions: { orders: { x: 10, y: 20 } }, dots: false, expanded: true });

  expect(loadErdPrefs(key)).toEqual({
    positions: { orders: { x: 10, y: 20 } },
    dots: false,
    expanded: true,
  });
});

test("keeps one schema's arrangement out of another's", () => {
  // Both halves of the key matter: two connections to the same server each
  // have a `public`, and one must not inherit the other's layout.
  saveErdPrefs(prefsKey("conn-1", "public"), { ...DEFAULT_PREFS, positions: { a: { x: 1, y: 1 } } });
  saveErdPrefs(prefsKey("conn-2", "public"), { ...DEFAULT_PREFS, positions: { a: { x: 9, y: 9 } } });
  saveErdPrefs(prefsKey("conn-1", "billing"), { ...DEFAULT_PREFS, positions: { a: { x: 5, y: 5 } } });

  expect(loadErdPrefs(prefsKey("conn-1", "public")).positions.a).toEqual({ x: 1, y: 1 });
  expect(loadErdPrefs(prefsKey("conn-2", "public")).positions.a).toEqual({ x: 9, y: 9 });
  expect(loadErdPrefs(prefsKey("conn-1", "billing")).positions.a).toEqual({ x: 5, y: 5 });
});

test("a second write does not drop the first schema", () => {
  // The bug this guards is a plain `setItem` instead of a read-modify-write:
  // opening a second diagram would silently forget the first one's layout.
  saveErdPrefs(prefsKey("c", "one"), { ...DEFAULT_PREFS, positions: { a: { x: 1, y: 2 } } });
  saveErdPrefs(prefsKey("c", "two"), { ...DEFAULT_PREFS, positions: { b: { x: 3, y: 4 } } });

  expect(loadErdPrefs(prefsKey("c", "one")).positions).toEqual({ a: { x: 1, y: 2 } });
});

test("an unknown schema gets the defaults rather than nothing", () => {
  expect(loadErdPrefs(prefsKey("c", "never-opened"))).toEqual(DEFAULT_PREFS);
});

test("junk in the store costs the arrangement, not the diagram", () => {
  store.set("rashbase.erd.v1", "{not json");
  expect(loadErdPrefs(prefsKey("c", "public"))).toEqual(DEFAULT_PREFS);

  store.set("rashbase.erd.v1", JSON.stringify({ "c::public": { positions: "nope" } }));
  expect(loadErdPrefs(prefsKey("c", "public")).positions).toEqual({});
});

test("a record written before a field existed keeps the fields it has", () => {
  store.set("rashbase.erd.v1", JSON.stringify({ "c::public": { positions: { a: { x: 7, y: 8 } } } }));
  const prefs = loadErdPrefs(prefsKey("c", "public"));

  expect(prefs.positions).toEqual({ a: { x: 7, y: 8 } });
  expect(prefs.dots).toBe(DEFAULT_PREFS.dots);
  expect(prefs.expanded).toBe(DEFAULT_PREFS.expanded);
});
