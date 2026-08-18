import { useEffect, useMemo, useState } from "react";
import { busyKey, useApp } from "@/store/app";
import type {
  ConnectionConfig,
  DbObject,
  FunctionEntry,
  QueryTab,
  TableEntry,
} from "@/lib/types";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { Spinner } from "@/components/ui/Spinner";
import { DestructiveDialog, type PendingAction } from "@/components/table/DestructiveDialog";
import { DeleteConnectionDialog } from "@/components/connection/DeleteConnectionDialog";
import { objectMenuItems, runObjectMenuAction } from "@/components/shell/objectMenu";
import { KIND_GLYPH, OBJECT_GROUPS, type SidebarMember } from "@/lib/constants/sidebar";
import { CLUSTER_OBJECTS, CLUSTER_SCHEMA } from "@/lib/constants/cluster";
import { findEnvironment } from "@/lib/utils/environments";
import { asDbError } from "@/lib/utils/errors";
import { isServerOnly, nestConnections } from "@/lib/utils/connections";

/**
 * A row that opens and closes what is under it.
 *
 * The schema and each object group are the same gesture, so they are the same
 * control: a caret that means "there is more here", at whatever depth the tree
 * has put it.
 */
function DisclosureRow({
  label,
  open,
  busy = false,
  indent,
  labelClass = "",
  onToggle,
}: {
  label: string;
  open: boolean;
  /** Set while what is under this row is being read off the server. */
  busy?: boolean;
  indent: string;
  labelClass?: string;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      aria-busy={busy || undefined}
      className={`flex w-full items-center gap-1 rounded py-1 pr-1.5 text-left text-[12px] text-ink-muted hover:bg-hover ${indent}`}
    >
      {/* In the caret's own slot, not next to it: the row must not widen the
          moment it is clicked. */}
      <span className="flex w-2.5 shrink-0 justify-center text-[9px] text-ink-faint">
        {busy ? (
          <Spinner size={9} className="text-accent" label={`Reading ${label}`} />
        ) : (
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        )}
      </span>
      <span className={`truncate ${labelClass}`}>{label}</span>
    </button>
  );
}

function ObjectRow({
  object,
  viewing,
  open,
  selected = false,
  indent,
  onOpen,
  onContextMenu,
}: {
  object: SidebarMember & { schema: string };
  viewing: boolean;
  open: boolean;
  /** Picked as part of a multi-row gesture, which is not the same as viewed. */
  selected?: boolean;
  indent: string;
  /** Carries the event: the modifiers are what separate picking from opening. */
  onOpen: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  // Three states share one row and have to stay tellable apart. Viewing keeps
  // the wash it already had; selection is a bar in the gutter, which reads as
  // "marked" rather than "here" and does not move the row the way a border
  // would.
  const tone = viewing
    ? "bg-accent-wash text-ink"
    : selected
      ? "bg-hover text-ink"
      : open
        ? "text-ink hover:bg-hover"
        : "text-ink-muted hover:bg-hover hover:text-ink";

  return (
    <button
      onClick={onOpen}
      onContextMenu={onContextMenu}
      aria-selected={selected || undefined}
      title={object.signature ?? object.comment ?? `${object.kind} ${object.schema}.${object.name}`}
      className={[
        `flex w-full items-center gap-2 rounded py-0.5 pr-1.5 text-left text-[12px] ${indent}`,
        tone,
        selected ? "shadow-[inset_2px_0_0_var(--color-accent)]" : "",
      ].join(" ")}
    >
      <span
        className={["shrink-0 text-[10px]", viewing ? "text-accent" : "text-ink-faint"].join(" ")}
        aria-hidden="true"
      >
        {KIND_GLYPH[object.kind]}
      </span>
      <span className="truncate">{object.label ?? object.name}</span>
    </button>
  );
}

/**
 * What a connection row offers.
 *
 * Connecting is what a click already does, so the menu carries only what a
 * click cannot: closing the session, and removing the connection.
 */
function connectionMenuItems(live: boolean): ContextMenuItem[] {
  return [
    ...(live ? ([{ kind: "item", id: "disconnect", label: "Disconnect" }] as ContextMenuItem[]) : []),
    ...(live ? ([{ kind: "separator" }] as ContextMenuItem[]) : []),
    { kind: "item", id: "delete", label: "Delete connection…", danger: true },
  ];
}

export function Sidebar() {
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; object: DbObject } | null>(null);
  const [connMenu, setConnMenu] = useState<{ x: number; y: number; config: ConnectionConfig } | null>(
    null,
  );
  /**
   * Which object groups are shut, keyed `connection::schema::group`. Local and
   * collapsed-by-exception: this is a fold of the list on screen, not something
   * that costs a round trip like opening a schema does.
   */
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState<ConnectionConfig | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const connections = useApp((s) => s.connections);
  const open = useApp((s) => s.open);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const databases = useApp((s) => s.databases);
  const schemas = useApp((s) => s.schemas);
  const tables = useApp((s) => s.tables);
  const functions = useApp((s) => s.functions);
  const expanded = useApp((s) => s.expandedSchemas);
  const busy = useApp((s) => s.busy);

  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);

  const connect = useApp((s) => s.connect);
  const disconnect = useApp((s) => s.disconnect);
  const setActiveConnection = useApp((s) => s.setActiveConnection);
  const toggleSchema = useApp((s) => s.toggleSchema);
  const setSheet = useApp((s) => s.setSheet);
  const openTab = useApp((s) => s.openTab);
  const openObjectTab = useApp((s) => s.openObjectTab);
  const openDatabase = useApp((s) => s.openDatabase);
  const setToast = useApp((s) => s.setToast);

  const selection = useApp((s) => s.selection);
  const anchorSelection = useApp((s) => s.anchorSelection);
  const toggleSelected = useApp((s) => s.toggleSelected);
  const selectRange = useApp((s) => s.selectRange);
  const setExportTarget = useApp((s) => s.setExportTarget);

  const needle = filter.trim().toLowerCase();
  const activeSchemas = activeConnectionId ? (schemas[activeConnectionId] ?? []) : [];

  // A connection that named no database is a server, so what it has to show is
  // its databases, not the schema of whichever one Postgres substituted.
  const activeConfig = connections.find((c) => c.id === activeConnectionId);
  const serverOnly = !!activeConfig && isServerOnly(activeConfig);
  const soleSchema = !serverOnly && activeSchemas.length === 1;

  // With no schema row there is nothing to press, so the one schema has to open
  // itself — and it is the fetch behind that toggle the groups need.
  useEffect(() => {
    const only = soleSchema ? activeSchemas[0] : undefined;
    if (!only || !activeConnectionId) return;
    if (!expanded[`${activeConnectionId}::${only.name}`]) {
      void toggleSchema(activeConnectionId, only.name);
    }
  }, [soleSchema, activeSchemas, activeConnectionId, expanded, toggleSchema]);

  /** `null` while the list is still being fetched, which is not the same as empty. */
  const visibleDatabases = useMemo(() => {
    const list = activeConnectionId ? databases[activeConnectionId] : undefined;
    if (!list) return null;
    return needle ? list.filter((d) => d.toLowerCase().includes(needle)) : list;
  }, [activeConnectionId, databases, needle]);

  // Which tables are already open, and which one you are actually looking at.
  // Without this the list gives no clue where the grid's contents came from.
  const { openTables, viewedTable } = useMemo(() => {
    const key = (t: QueryTab) =>
      t.object ? `${t.connectionId}::${t.object.schema}.${t.object.name}` : null;
    const active = tabs.find((t) => t.id === activeTabId);
    return {
      openTables: new Set(tabs.map(key).filter((k): k is string => k !== null)),
      viewedTable: active ? key(active) : null,
    };
  }, [tabs, activeTabId]);

  const visibleTables = useMemo(() => {
    const out: Record<string, TableEntry[]> = {};
    if (!activeConnectionId) return out;
    for (const s of activeSchemas) {
      const key = `${activeConnectionId}::${s.name}`;
      const list = tables[key] ?? [];
      out[s.name] = needle ? list.filter((t) => t.name.toLowerCase().includes(needle)) : list;
    }
    return out;
  }, [activeConnectionId, activeSchemas, tables, needle]);

  const databasesKey = `${activeConnectionId}::server::databases`;
  const clusterKey = `${activeConnectionId}::server::cluster`;
  const databasesOpen = !collapsedGroups[databasesKey];
  const clusterOpen = !collapsedGroups[clusterKey];

  const visibleCluster = useMemo(
    () =>
      needle
        ? CLUSTER_OBJECTS.filter(
            (o) =>
              o.label.toLowerCase().includes(needle) || o.name.toLowerCase().includes(needle),
          )
        : CLUSTER_OBJECTS,
    [needle],
  );

  const visibleFunctions = useMemo(() => {
    const out: Record<string, FunctionEntry[]> = {};
    if (!activeConnectionId) return out;
    for (const s of activeSchemas) {
      const list = functions[`${activeConnectionId}::${s.name}`] ?? [];
      out[s.name] = needle ? list.filter((f) => f.name.toLowerCase().includes(needle)) : list;
    }
    return out;
  }, [activeConnectionId, activeSchemas, functions, needle]);

  /**
   * Which rows are picked, ignored unless they belong to the connection on
   * screen: a selection made in another database names tables that are not here.
   */
  const selectedKeys = useMemo(
    () => new Set(selection.connectionId === activeConnectionId ? selection.keys : []),
    [selection, activeConnectionId],
  );

  /**
   * The selectable rows, top to bottom, exactly as drawn.
   *
   * A range has to follow the eye rather than the catalogue: with a filter
   * typed or a group folded, the rows between two clicks are the visible ones,
   * and a range built from the underlying list would quietly pick up tables the
   * user cannot see.
   */
  const visibleOrder = useMemo(() => {
    if (!activeConnectionId || serverOnly) return [];
    const out: string[] = [];
    for (const schema of activeSchemas) {
      const key = `${activeConnectionId}::${schema.name}`;
      if (!soleSchema && !expanded[key]) continue;
      const list = visibleTables[schema.name] ?? [];
      for (const group of OBJECT_GROUPS) {
        const members = group.pick(list, visibleFunctions[schema.name] ?? []);
        if (members.length === 0 || collapsedGroups[`${key}::${group.label}`]) continue;
        for (const member of members) {
          // Functions are in the tree but not in a selection: there is nothing
          // to export, so including them would let a range pick up rows the
          // export then silently drops.
          if (member.kind !== "function") out.push(`${schema.name}.${member.name}`);
        }
      }
    }
    return out;
  }, [
    activeConnectionId,
    serverOnly,
    activeSchemas,
    soleSchema,
    expanded,
    visibleTables,
    visibleFunctions,
    collapsedGroups,
  ]);

  /**
   * What a click on an object row means.
   *
   * Plain opens it and marks where a range would start; the modifiers pick
   * instead of opening, the way every file list works. Splitting them is what
   * lets one row be both "the table I am looking at" and "one of four I am
   * about to export".
   */
  function chooseObject(e: React.MouseEvent, object: SidebarMember & { schema: string }) {
    if (!activeConnectionId) return;
    if (object.kind !== "function") {
      const key = `${object.schema}.${object.name}`;
      if (e.metaKey || e.ctrlKey) {
        toggleSelected(activeConnectionId, key);
        return;
      }
      if (e.shiftKey) {
        selectRange(activeConnectionId, visibleOrder, key);
        return;
      }
      anchorSelection(activeConnectionId, key);
    }
    openObjectTab(activeConnectionId, object);
  }

  /** Right-clicking outside the selection resets it, as a file list does. */
  function openMenu(e: React.MouseEvent, object: DbObject) {
    e.preventDefault();
    if (activeConnectionId && object.kind !== "function") {
      const key = `${object.schema}.${object.name}`;
      if (!selectedKeys.has(key)) anchorSelection(activeConnectionId, key);
    }
    setMenu({ x: e.clientX, y: e.clientY, object });
  }

  function chooseConnection(id: string) {
    const target = connMenu?.config;
    setConnMenu(null);
    if (!target) return;
    if (id === "disconnect") void disconnect(target.id);
    // Deleting takes the stored password and any derived connection with it,
    // so it goes in front of the user first.
    if (id === "delete") setDeleting(target);
  }

  async function choose(id: string) {
    const target = menu?.object;
    setMenu(null);
    if (!target || !activeConnectionId) return;

    // Handled here rather than in `runObjectMenuAction`, which knows about
    // statements and clipboards and nothing about the workspace.
    if (id === "export") {
      const keys =
        selectedKeys.size > 0 ? [...selectedKeys] : [`${target.schema}.${target.name}`];
      setExportTarget({ connectionId: activeConnectionId, keys });
      return;
    }

    try {
      const { pending, copied } = await runObjectMenuAction(id, activeConnectionId, target);
      if (pending) setPending(pending);
      if (copied) setToast({ kind: "info", text: copied });
    } catch (e) {
      setToast({ kind: "error", text: asDbError(e).message });
    }
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line-soft bg-raised">
      <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
        <span className="label-eyebrow">Connections</span>
        <button
          onClick={() => setSheet(true, null)}
          title="New connection  ⌘⇧N"
          aria-label="New connection"
          className="pressable rounded p-0.5 text-ink-faint hover:bg-hover hover:text-ink"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="px-1.5 pb-1">
        {connections.length === 0 ? (
          <p className="px-1.5 py-2 text-[11px] leading-relaxed text-ink-faint">
            No connections yet.{" "}
            <button onClick={() => setSheet(true, null)} className="text-accent hover:underline">
              Add one
            </button>{" "}
            to get started.
          </p>
        ) : (
          nestConnections(connections).map(({ config: c, child }) => {
            const live = !!open[c.id];
            const active = c.id === activeConnectionId;
            const connecting = !!busy[busyKey.connect(c.id)];
            const env = findEnvironment(c.environment);
            return (
              <button
                key={c.id}
                disabled={connecting}
                aria-busy={connecting || undefined}
                onClick={() =>
                  live
                    ? setActiveConnection(c.id)
                    : // The store already reports the failure. Catching it here
                      // only keeps a refused connection from surfacing as an
                      // unhandled rejection on top of the toast.
                      void connect(c).catch(() => {})
                }
                onDoubleClick={() => setSheet(true, c)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setConnMenu({ x: e.clientX, y: e.clientY, config: c });
                }}
                className={[
                  "flex w-full items-center gap-2 rounded py-1 pr-1.5 text-left text-[12px]",
                  child ? "pl-5" : "pl-1.5",
                  active ? "bg-accent-wash text-ink" : "text-ink-muted hover:bg-hover",
                ].join(" ")}
              >
                {/* The status dot's own slot. An SSH tunnel can take ten
                    seconds, and ten seconds of a row that looks exactly as it
                    did before the click is the app looking broken. */}
                {connecting ? (
                  <Spinner size={9} className="text-accent" label={`Connecting to ${c.name}`} />
                ) : (
                  <span
                    className={[
                      "size-1.5 shrink-0 rounded-full",
                      live ? "bg-accent" : "bg-ink-faint/40",
                    ].join(" ")}
                  />
                )}
                <span className="truncate">{c.name}</span>
                {env && (
                  <span
                    title={env.label}
                    className={`ml-auto shrink-0 rounded-sm px-1 text-[9px] tracking-wide uppercase ${env.badge}`}
                  >
                    {env.id === "development" ? "dev" : env.id === "production" ? "prod" : env.id}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      {activeConnectionId && open[activeConnectionId] && (
        <>
          <div className="mt-2 flex items-center justify-between border-t border-line-soft px-3 pt-3 pb-1.5">
            <span className="label-eyebrow">{serverOnly ? "Databases" : "Schema"}</span>
            <button
              onClick={() => openTab(activeConnectionId)}
              title="New query  ⌘T"
              aria-label="New query"
              className="pressable rounded p-0.5 text-ink-faint hover:bg-hover hover:text-ink"
            >
              {/* Terminal prompt: this is the way to raw SQL, as opposed to
                  clicking a table, which just shows rows. */}
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none">
                <path
                  d="M2 2.5L5 6l-3 3.5M6.5 9.5H10"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>

          <div className="px-1.5 pb-1.5">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={serverOnly ? "Filter server" : "Filter tables"}
              className="w-full rounded border border-line-soft bg-base px-2 py-1 text-[11px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
            {serverOnly ? (
              <>
                <DisclosureRow
                  label="Databases"
                  open={databasesOpen}
                  indent="pl-1.5"
                  labelClass="label-eyebrow"
                  onToggle={() =>
                    setCollapsedGroups((c) => ({ ...c, [databasesKey]: databasesOpen }))
                  }
                />
                {databasesOpen &&
                  (visibleDatabases === null ? (
                    <p className="flex items-center gap-1.5 py-2 pl-5 text-[11px] text-ink-faint">
                      <Spinner size={9} className="text-accent" label="Reading databases" />
                      Reading databases…
                    </p>
                  ) : visibleDatabases.length === 0 ? (
                    <p className="py-2 pl-5 text-[11px] text-ink-faint">
                      {needle ? "No match" : "No database this role can open."}
                    </p>
                  ) : (
                    visibleDatabases.map((name) => {
                      // The one this session actually landed in. Postgres substitutes
                      // the role's name for a blank database, so it is worth saying
                      // which one that turned out to be.
                      const here = name === open[activeConnectionId]?.currentDatabase;
                      // Opening a database is a second connection to the same
                      // server, so it costs what the first one cost.
                      const opening = !!busy[busyKey.database(activeConnectionId, name)];
                      return (
                        <button
                          key={name}
                          disabled={opening}
                          aria-busy={opening || undefined}
                          onClick={() => void openDatabase(activeConnectionId, name)}
                          className="flex w-full items-center gap-2 rounded py-1 pr-1.5 pl-5 text-left text-[12px] text-ink-muted hover:bg-hover hover:text-ink"
                        >
                          {opening ? (
                            <Spinner size={9} className="text-accent" label={`Opening ${name}`} />
                          ) : (
                            <span
                              className={[
                                "size-1.5 shrink-0 rounded-full",
                                here ? "bg-accent" : "bg-ink-faint/40",
                              ].join(" ")}
                            />
                          )}
                          <span className="truncate">{name}</span>
                        </button>
                      );
                    })
                  ))}

                {/* The rest of the server. Same rows, same tabs as a table:
                    these are catalogue relations, so nothing here is special
                    except that it is worth being able to find. */}
                <DisclosureRow
                  label="Cluster"
                  open={clusterOpen}
                  indent="pl-1.5"
                  labelClass="label-eyebrow"
                  onToggle={() => setCollapsedGroups((c) => ({ ...c, [clusterKey]: clusterOpen }))}
                />
                {clusterOpen &&
                  (visibleCluster.length === 0 ? (
                    <p className="py-2 pl-5 text-[11px] text-ink-faint">No match</p>
                  ) : (
                    visibleCluster.map((object) => (
                      <ObjectRow
                        key={object.name}
                        object={{ ...object, schema: CLUSTER_SCHEMA }}
                        indent="pl-5"
                        viewing={
                          `${activeConnectionId}::${CLUSTER_SCHEMA}.${object.name}` === viewedTable
                        }
                        open={openTables.has(
                          `${activeConnectionId}::${CLUSTER_SCHEMA}.${object.name}`,
                        )}
                        onOpen={(e) => chooseObject(e, { ...object, schema: CLUSTER_SCHEMA })}
                        onContextMenu={(e) =>
                          openMenu(e, { ...object, schema: CLUSTER_SCHEMA })
                        }
                      />
                    ))
                  ))}
              </>
            ) : (
              activeSchemas.map((s) => {
              const key = `${activeConnectionId}::${s.name}`;
              // The sole schema of a database is not a choice the user makes,
              // so it is not a row they have to open: its groups are the tree.
              const isOpen = soleSchema || !!expanded[key];
              const list = visibleTables[s.name] ?? [];
              return (
                <div key={s.name}>
                  {!soleSchema && (
                    <DisclosureRow
                      label={s.name}
                      open={isOpen}
                      busy={!!busy[busyKey.schema(activeConnectionId, s.name)]}
                      indent="pl-1.5"
                      onToggle={() => void toggleSchema(activeConnectionId, s.name)}
                    />
                  )}

                  {isOpen && (
                    <>
                      {OBJECT_GROUPS.map((group) => {
                        const members = group.pick(list, visibleFunctions[s.name] ?? []);
                        // An absent group says "this schema has none of those"
                        // more clearly than an empty heading does.
                        if (members.length === 0) return null;
                        const groupKey = `${key}::${group.label}`;
                        // Absent means open: a schema that has just been
                        // expanded should show what is in it.
                        const groupOpen = !collapsedGroups[groupKey];
                        return (
                          <div key={group.label}>
                            <DisclosureRow
                              label={group.label}
                              open={groupOpen}
                              indent={soleSchema ? "pl-1.5" : "pl-5"}
                              labelClass="label-eyebrow"
                              onToggle={() =>
                                setCollapsedGroups((c) => ({ ...c, [groupKey]: groupOpen }))
                              }
                            />
                            {groupOpen &&
                              members.map((object) => (
                              <ObjectRow
                                key={`${object.kind}:${object.name}:${object.oid ?? ""}`}
                                object={{ ...object, schema: s.name }}
                                indent={soleSchema ? "pl-5" : "pl-8"}
                                viewing={
                                  `${activeConnectionId}::${s.name}.${object.name}` === viewedTable
                                }
                                open={openTables.has(`${activeConnectionId}::${s.name}.${object.name}`)}
                                selected={selectedKeys.has(`${s.name}.${object.name}`)}
                                onOpen={(e) => chooseObject(e, { ...object, schema: s.name })}
                                onContextMenu={(e) => openMenu(e, { ...object, schema: s.name })}
                              />
                            ))}
                          </div>
                        );
                      })}

                      {list.length === 0 && (visibleFunctions[s.name]?.length ?? 0) === 0 && (
                        <p className={`py-0.5 text-[11px] text-ink-faint ${soleSchema ? "pl-1.5" : "pl-5"}`}>
                          {needle ? "No match" : "Empty"}
                        </p>
                      )}
                    </>
                  )}
                </div>
              );
              })
            )}
          </div>
        </>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={objectMenuItems(menu.object, Math.max(1, selectedKeys.size))}
          onSelect={(id) => void choose(id)}
          onClose={() => setMenu(null)}
        />
      )}

      {connMenu && (
        <ContextMenu
          x={connMenu.x}
          y={connMenu.y}
          items={connectionMenuItems(!!open[connMenu.config.id])}
          onSelect={chooseConnection}
          onClose={() => setConnMenu(null)}
        />
      )}

      <DeleteConnectionDialog target={deleting} onClose={() => setDeleting(null)} />

      {activeConnectionId && (
        <DestructiveDialog
          connectionId={activeConnectionId}
          pending={pending}
          onClose={() => setPending(null)}
        />
      )}
    </aside>
  );
}
