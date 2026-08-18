import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { COMMANDS, runCommand } from "@/lib/commands";
import { fuzzyScore } from "@/lib/utils/fuzzy";
import type { DbObject } from "@/lib/types";
import { Spinner } from "@/components/ui/Spinner";
import { busyKey, useApp } from "@/store/app";

/**
 * Deliberately unanimated.
 *
 * ⌘K fires dozens of times a day. Any entrance transition, however short,
 * reads as the app being slow at exactly the moment the user is watching most
 * closely. Instant in, instant out.
 *
 * One surface, three lists: ⌘K searches commands, ⌘P searches tables, ⌘⇧K
 * searches databases. They look and behave identically on purpose — the muscle
 * memory is the point.
 */
interface PaletteItem {
  id: string;
  group: string;
  label: string;
  keys?: string;
  /** Same slot as `keys`, for a word rather than a shortcut. */
  hint?: string;
  run: () => void;
}

const PLACEHOLDER = {
  commands: "Type a command",
  tables: "Search tables",
  databases: "Search databases",
};
const NOTHING = {
  commands: "No matching command",
  tables: "No matching table",
  databases: "No matching database",
};

export function CommandPalette() {
  const mode = useApp((s) => s.palette);
  const setPalette = useApp((s) => s.setPalette);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const connections = useApp((s) => s.connections);
  const sessions = useApp((s) => s.open);
  const databases = useApp((s) => s.databases);
  const schemas = useApp((s) => s.schemas);
  const tables = useApp((s) => s.tables);
  const functions = useApp((s) => s.functions);
  const openObjectTab = useApp((s) => s.openObjectTab);
  const openDatabase = useApp((s) => s.openDatabase);
  /**
   * ⌘P fetches the schemas the sidebar never expanded. Until it lands the list
   * is genuinely short, and "No matching table" would be the palette claiming
   * a table is missing when it has simply not been read yet.
   */
  const loading = useApp(
    (s) =>
      !!s.activeConnectionId &&
      !!s.busy[
        s.palette === "databases"
          ? busyKey.databases(s.activeConnectionId)
          : busyKey.tables(s.activeConnectionId)
      ],
  );

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const open = mode !== null;

  const items = useMemo<PaletteItem[]>(() => {
    if (mode === "databases") {
      if (!activeConnectionId) return [];
      const from = connections.find((c) => c.id === activeConnectionId);
      if (!from) return [];
      // Grouped by the server, named as the user named it. A derived connection
      // is called after its database, so its own name would say nothing here.
      const root = connections.find((c) => c.id === (from.parentId ?? from.id));
      const server = root?.name ?? `${from.user}@${from.host}`;
      const here = sessions[activeConnectionId]?.currentDatabase;
      return (databases[activeConnectionId] ?? []).map((name) => ({
        id: `database:${name}`,
        group: server,
        label: name,
        hint: name === here ? "current" : undefined,
        run: () => void openDatabase(activeConnectionId, name),
      }));
    }

    if (mode === "tables") {
      if (!activeConnectionId) return [];
      // Everything in the schema, not only its tables: a view or a function is
      // just as likely to be what you are reaching for.
      return (schemas[activeConnectionId] ?? []).flatMap((schema) => {
        const key = `${activeConnectionId}::${schema.name}`;
        const objects: DbObject[] = [
          ...(tables[key] ?? []).map((t) => ({
            schema: schema.name,
            name: t.name,
            kind: t.kind,
          })),
          ...(functions[key] ?? []).map((f) => ({
            schema: schema.name,
            name: f.name,
            kind: "function" as const,
            oid: f.oid,
          })),
        ];
        return objects.map((object) => ({
          id: `${object.kind}:${schema.name}.${object.name}:${object.oid ?? ""}`,
          group: schema.name,
          label: object.name,
          run: () => openObjectTab(activeConnectionId, object),
        }));
      });
    }
    return COMMANDS.filter((c) => !c.enabled || c.enabled()).map((c) => ({
      id: c.id,
      group: c.group,
      label: c.label,
      keys: c.keys,
      run: () => runCommand(c.id),
    }));
  }, [
    mode,
    activeConnectionId,
    connections,
    sessions,
    databases,
    schemas,
    tables,
    functions,
    openObjectTab,
    openDatabase,
  ]);

  /**
   * Ranked, not filtered.
   *
   * Postgres names things with underscores and nobody types them, so `aiproj`
   * has to reach `ai_project`. A subsequence match does that; the ranking is
   * what keeps it useful, because on its own a subsequence match would put
   * every table containing those six letters in some order above the one meant.
   *
   * The name is matched first and the schema-qualified form second, one point
   * behind, so `public` never outranks a table actually called that.
   */
  const results = useMemo(() => {
    const needle = query.trim();
    if (!needle) return items;
    return items
      .map((item) => {
        const own = fuzzyScore(needle, item.label);
        const qualified = fuzzyScore(needle, `${item.group}.${item.label}`);
        const score = Math.max(own ?? -Infinity, qualified === null ? -Infinity : qualified - 1);
        return { item, score };
      })
      .filter((r) => Number.isFinite(r.score))
      .sort((a, b) => b.score - a.score)
      .map((r) => r.item);
  }, [items, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open, mode]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  function choose(i: number) {
    const item = results[i];
    if (!item) return;
    setPalette(null);
    item.run();
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && setPalette(null)}>
      <Dialog.Portal>
        {/* Above the result grid, whose sticky header carries its own z-index
            and would otherwise paint straight through the palette. */}
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[18vh] left-1/2 z-50 w-[min(560px,90vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-overlay shadow-2xl shadow-black/50"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(index);
            }
          }}
        >
          <Dialog.Title className="sr-only">
            {mode === "tables"
              ? "Table picker"
              : mode === "databases"
                ? "Database picker"
                : "Command palette"}
          </Dialog.Title>

          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            placeholder={PLACEHOLDER[mode ?? "commands"]}
            className="w-full border-b border-line-soft bg-transparent px-4 py-3 text-[14px] text-ink placeholder:text-ink-faint focus:outline-none"
          />

          <div ref={listRef} className="max-h-[46vh] overflow-y-auto py-1">
            {results.length === 0 && (
              <p className="flex items-center justify-center gap-2 px-4 py-6 text-center text-[12px] text-ink-faint">
                {loading && <Spinner size={10} className="text-accent" label="Loading" />}
                {loading ? "Reading…" : NOTHING[mode ?? "commands"]}
              </p>
            )}
            {results.map((item, i) => (
              <button
                key={item.id}
                data-index={i}
                onMouseMove={() => setIndex(i)}
                onClick={() => choose(i)}
                className={[
                  "flex w-full items-center gap-3 px-4 py-1.5 text-left text-[13px]",
                  i === index ? "bg-accent-wash text-ink" : "text-ink-muted",
                ].join(" ")}
              >
                <span className="w-20 shrink-0 truncate text-[11px] text-ink-faint">
                  {item.group}
                </span>
                <span className="truncate">{item.label}</span>
                {item.keys && (
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-faint">
                    {item.keys}
                  </span>
                )}
                {item.hint && (
                  <span className="ml-auto shrink-0 text-[11px] text-ink-faint">{item.hint}</span>
                )}
              </button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
