import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { busyKey, useApp } from "@/store/app";
import type {
  ConnectionConfig,
  DbObject,
  FunctionEntry,
  QueryTab,
  SchemaEntry,
  TableEntry,
} from "@/lib/types";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { Spinner } from "@/components/ui/Spinner";
import { DestructiveDialog, type PendingAction } from "@/components/table/DestructiveDialog";
import { DeleteConnectionDialog } from "@/components/connection/DeleteConnectionDialog";
import { objectMenuItems, runObjectMenuAction } from "@/components/shell/objectMenu";
import { KIND_GLYPH, OBJECT_GROUPS, type SidebarMember } from "@/lib/constants/sidebar";
import { CLUSTER_OBJECTS, CLUSTER_SCHEMA } from "@/lib/constants/cluster";
import { isKeyspaceDriver } from "@/lib/constants/connection";
import { DEFAULT_PREFIX } from "@/lib/constants/bullmq";
import { findEnvironment } from "@/lib/utils/environments";
import { asDbError } from "@/lib/utils/errors";
import { isServerOnly, nestConnections } from "@/lib/utils/connections";

/**
 * How wide the tree is, kept across launches.
 *
 * `localStorage` for the same reason as `translucency.ts` and `erdPrefs.ts`:
 * this is window layout, not data, so it belongs to the window and not to the
 * connection store on the Rust side.
 */
const WIDTH_KEY = "rashbase.sidebarWidth.v1";
const MIN_WIDTH = 180;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 240;

function clampWidth(px: number) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px));
}

function loadWidth(): number {
  try {
    const px = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(px) && px > 0) return clampWidth(px);
  } catch {
    /* A disabled store costs the user the preference, nothing more. */
  }
  return DEFAULT_WIDTH;
}

/**
 * How tall the connection list is. `null` means "as tall as it needs to be",
 * which is the right answer until the user says otherwise: a two-connection
 * list should not reserve a pane's worth of empty space.
 */
const CONN_HEIGHT_KEY = "rashbase.sidebarConnHeight.v1";
const MIN_PANE = 72;

function loadConnHeight(): number | null {
  try {
    const raw = localStorage.getItem(CONN_HEIGHT_KEY);
    if (raw === null) return null;
    const px = Number(raw);
    if (Number.isFinite(px) && px > 0) return px;
  } catch {
    /* A disabled store costs the user the preference, nothing more. */
  }
  return null;
}

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
  onContextMenu,
}: {
  label: string;
  open: boolean;
  /** Set while what is under this row is being read off the server. */
  busy?: boolean;
  indent: string;
  labelClass?: string;
  onToggle: () => void;
  /** Absent on the group rows, which have nothing of their own to act on. */
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onToggle}
      onContextMenu={onContextMenu}
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

/**
 * BullMQ queues on a Redis connection.
 *
 * Collapsed until asked, and that is the whole reason it is a disclosure rather
 * than a list: finding queues means matching `<prefix>:*:meta` across the
 * keyspace, and on an instance holding millions of session keys that is a walk
 * nobody should pay for by connecting.
 *
 * One number per row, chosen rather than totalled. A sidebar row is too narrow
 * for seven counts and nobody scans seven numbers anyway: what is worth seeing
 * at this width is whether anything has failed, and failing that, whether
 * anything is waiting. The rest is one click away on the diagram.
 */
function QueuesSection({
  connectionId,
  needle,
  viewedTable,
}: {
  connectionId: string;
  needle: string;
  viewedTable: string | null;
}) {
  const [open, setOpen] = useState(false);
  const queues = useApp((s) => s.queues[connectionId] ?? null);
  const scan = useApp((s) => s.queueScan[connectionId] ?? null);
  const loadQueues = useApp((s) => s.loadQueues);
  const openObjectTab = useApp((s) => s.openObjectTab);
  const busy = useApp((s) => !!s.busy[busyKey.queues(connectionId)]);

  const shown = useMemo(
    () => (queues ?? []).filter((q) => q.name.toLowerCase().includes(needle)),
    [queues, needle],
  );

  return (
    <div className="mt-1 border-t border-line-soft pt-1">
      <div className="flex items-center">
        <div className="min-w-0 flex-1">
          <DisclosureRow
            label="Queues"
            open={open}
            busy={busy}
            indent="pl-1.5"
            labelClass="label-eyebrow"
            onToggle={() => {
              const next = !open;
              setOpen(next);
              // Cached on reopen. The walk is the expensive part and reopening a
              // section is not a request for a fresh one — the control beside
              // this is, and the queue being watched keeps its own row true.
              if (next) void loadQueues(connectionId);
            }}
          />
        </div>
        {open && (
          <button
            onClick={() => void loadQueues(connectionId, true)}
            disabled={busy}
            title="Walk for queues again"
            aria-label="Refresh queues"
            className="mr-1 shrink-0 rounded px-1 text-[10px] text-ink-faint hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40"
          >
            <span aria-hidden="true">⟳</span>
          </button>
        )}
      </div>

      {open &&
        (queues === null ? null : shown.length === 0 ? (
          <p className="py-1.5 pl-4 text-[11px] text-ink-faint">
            {needle ? (
              "No match"
            ) : (
              <>
                {/* What was looked for, where, and what the look cost. An
                    empty state that only said "none" would leave a wrong
                    prefix indistinguishable from an idle server. */}
                No queues under prefix{" "}
                <span className="font-mono text-ink-muted">{DEFAULT_PREFIX}</span>
                {scan && <> · scanned {scan.scanned.toLocaleString()}</>}
              </>
            )}
          </p>
        ) : (
          <>
            {shown.map((q) => {
              const failed = q.counts.failed ?? 0;
              const pending =
                (q.counts.wait ?? 0) +
                (q.counts.active ?? 0) +
                (q.counts.delayed ?? 0) +
                (q.counts.prioritized ?? 0);
              const viewing = `${connectionId}::${q.name}.${q.name}` === viewedTable;

              return (
                <button
                  key={q.name}
                  onClick={() =>
                    openObjectTab(connectionId, {
                      schema: q.name,
                      name: q.name,
                      kind: "queue",
                    })
                  }
                  className={[
                    "flex w-full items-center gap-2 rounded py-1 pr-1.5 pl-4 text-left text-[12px]",
                    viewing ? "bg-accent-wash text-ink" : "text-ink-muted hover:bg-hover hover:text-ink",
                  ].join(" ")}
                >
                  <span className="truncate font-mono">{q.name}</span>
                  {q.paused && (
                    <span className="shrink-0 text-[10px] text-ink-faint">paused</span>
                  )}
                  <span
                    className={[
                      "ml-auto shrink-0 font-mono text-[10px] tabular-nums",
                      failed > 0 ? "text-danger" : "text-ink-faint",
                    ].join(" ")}
                    title={
                      failed > 0
                        ? `${failed} failed`
                        : `${pending} waiting, active, delayed or prioritized`
                    }
                  >
                    {failed > 0 ? failed.toLocaleString() : pending.toLocaleString()}
                  </span>
                </button>
              );
            })}

            {/* A bound that was hit is reported as a bound. Without this the
                list looks like every queue there is. */}
            {scan && !scan.exhausted && (
              <p className="py-1 pl-4 text-[10px] text-ink-faint">
                Stopped after scanning {scan.scanned.toLocaleString()} keys. There may be more.
              </p>
            )}
          </>
        ))}
    </div>
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
 * click cannot: drawing a schema, closing the session, and removing the
 * connection.
 *
 * The diagram lives here and not only on the schema row because the schema row
 * is not always drawn: a database with a single schema has no choice to make,
 * so it gets no row — which is exactly the shape most Postgres databases have,
 * and would leave the gesture unreachable on all of them. With more than one
 * schema the entry becomes a submenu, because then there is a question to
 * answer and the menu is where to answer it.
 *
 * A derived row under a server is a database — `nestConnections` puts each one
 * under the server it was picked off — so this is also the menu for a database,
 * and export and import belong on it for that reason.
 *
 * `active` decides whether the shortcuts are shown, and it has to. Both
 * commands act on the *active* connection; this menu acts on the row that was
 * right-clicked, and right-clicking does not make a row active. On any other
 * row the hint would name a key that runs the same action against a different
 * database, which is worse than advertising one that does nothing.
 */
function connectionMenuItems(
  live: boolean,
  active: boolean,
  keyspace: boolean,
  schemas: SchemaEntry[],
): ContextMenuItem[] {
  const diagram: ContextMenuItem[] = !live
    ? []
    : schemas.length === 1
      ? [{ kind: "item", id: `${DIAGRAM_PREFIX}${schemas[0]!.name}`, label: "Show diagram" }]
      : schemas.length > 1
        ? [
            {
              kind: "submenu",
              label: "Show diagram",
              items: schemas.map((schema) => ({
                id: `${DIAGRAM_PREFIX}${schema.name}`,
                label: schema.name,
              })),
            },
          ]
        : [];

  return [
    // First, and not gated on a live connection: editing is what a
    // double-click on the row already does, and this is the second door to it.
    // A connection that will not connect is exactly the one worth editing.
    { kind: "item", id: "edit", label: "Edit connection…" },
    { kind: "separator" },
    ...diagram,
    ...(diagram.length > 0 ? ([{ kind: "separator" }] as ContextMenuItem[]) : []),
    // Two gates, for two different reasons. `live`, because both dialogs list
    // what is in a database and there is nothing to list without a session.
    // `!keyspace`, because a flat keyspace has no relations to dump and no
    // statements to run back in — `Capabilities` says so and the driver would
    // refuse, and a menu entry that opens a dialog the driver will not serve is
    // worse than no entry at all.
    ...(live && !keyspace
      ? ([
          {
            kind: "item",
            id: "export",
            // Not "Export database…": the dialog opens with nothing picked,
            // and a label promising the whole database would be a promise the
            // first thing the user sees does not keep.
            label: "Export tables…",
            ...(active ? { hint: "⌘⇧E" } : {}),
          },
          {
            kind: "item",
            id: "import",
            label: "Import SQL file…",
            ...(active ? { hint: "⌘⇧I" } : {}),
          },
          { kind: "separator" },
        ] as ContextMenuItem[])
      : []),
    ...(live
      ? ([
          { kind: "item", id: "disconnect", label: "Disconnect" },
          { kind: "separator" },
        ] as ContextMenuItem[])
      : []),
    { kind: "item", id: "delete", label: "Delete connection…", danger: true },
  ];
}

/** A schema name can be anything, so the id carries it behind a fixed prefix. */
const DIAGRAM_PREFIX = "diagram:";

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
  /**
   * The database row a menu was opened on.
   *
   * Its own state rather than a third field on one: the three menus are about
   * three different things, and a single nullable object holding whichever was
   * last clicked is how a menu ends up acting on the row before it.
   */
  const [dbMenu, setDbMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [width, setWidth] = useState(loadWidth);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const onResizeMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setWidth(clampWidth(d.startW + (e.clientX - d.startX)));
  }, []);

  const onResizeUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onResizeMove);
    window.removeEventListener("pointerup", onResizeUp);
  }, [onResizeMove]);

  const onResizeDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startW: width };
      window.addEventListener("pointermove", onResizeMove);
      window.addEventListener("pointerup", onResizeUp);
    },
    [width, onResizeMove, onResizeUp],
  );

  // Written on every settled width rather than on pointer-up, so a
  // double-click reset and a drag both persist through the one path.
  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      /* Same: the window is still the right width for this session. */
    }
  }, [width]);

  const [connHeight, setConnHeight] = useState<number | null>(loadConnHeight);
  const asideRef = useRef<HTMLElement>(null);
  const connRef = useRef<HTMLDivElement>(null);
  const rowDragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onRowMove = useCallback((e: PointerEvent) => {
    const d = rowDragRef.current;
    const aside = asideRef.current;
    if (!d || !aside) return;
    // The floor for the schema tree below is the same one the list itself
    // gets, so neither side can be dragged out of existence.
    const max = Math.max(MIN_PANE, aside.clientHeight - MIN_PANE);
    setConnHeight(Math.min(max, Math.max(MIN_PANE, d.startH + (e.clientY - d.startY))));
  }, []);

  const onRowUp = useCallback(() => {
    rowDragRef.current = null;
    window.removeEventListener("pointermove", onRowMove);
    window.removeEventListener("pointerup", onRowUp);
  }, [onRowMove]);

  const onRowDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      // Measured rather than read off state: until the first drag the list is
      // auto-height, and the drag has to start from whatever that came out as.
      rowDragRef.current = {
        startY: e.clientY,
        startH: connRef.current?.clientHeight ?? MIN_PANE,
      };
      window.addEventListener("pointermove", onRowMove);
      window.addEventListener("pointerup", onRowUp);
    },
    [onRowMove, onRowUp],
  );

  useEffect(() => {
    try {
      if (connHeight === null) localStorage.removeItem(CONN_HEIGHT_KEY);
      else localStorage.setItem(CONN_HEIGHT_KEY, String(connHeight));
    } catch {
      /* Same: the pane is still the right height for this session. */
    }
  }, [connHeight]);

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
  const setImportTarget = useApp((s) => s.setImportTarget);

  const needle = filter.trim().toLowerCase();
  const activeSchemas = activeConnectionId ? (schemas[activeConnectionId] ?? []) : [];
  const schemaOpen = !!activeConnectionId && !!open[activeConnectionId];

  // A connection that named no database is a server, so what it has to show is
  // its databases, not the schema of whichever one Postgres substituted.
  const activeConfig = connections.find((c) => c.id === activeConnectionId);
  /**
   * A key-value store is always a list of databases plus one namespace: they
   * are numbered rather than named, so there is no "the one I asked for" and
   * nothing is gained by hiding the rest.
   */
  const keyspace = !!activeConfig && isKeyspaceDriver(activeConfig.driver);
  const serverOnly = !keyspace && !!activeConfig && isServerOnly(activeConfig);
  const soleSchema = !serverOnly && !keyspace && activeSchemas.length === 1;

  // With no schema row there is nothing to press, so the one schema has to open
  // itself — and it is the fetch behind that toggle the groups need.
  useEffect(() => {
    const only = soleSchema && !keyspace ? activeSchemas[0] : undefined;
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
    if (!activeConnectionId || serverOnly || keyspace) return [];
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
    keyspace,
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
    // ⌥ is "beside what I am looking at", the way it opens a second view
    // everywhere else. Plain click replaces; this one adds.
    openObjectTab(activeConnectionId, object, e.altKey ? "split" : "main");
  }

  /** Right-clicking outside the selection resets it, as a file list does. */
  function openMenu(e: React.MouseEvent, object: DbObject) {
    e.preventDefault();
    // A schema is not part of the object selection, so right-clicking one must
    // not clear what the user had picked out of the tree.
    if (activeConnectionId && object.kind !== "function" && object.kind !== "diagram") {
      const key = `${object.schema}.${object.name}`;
      if (!selectedKeys.has(key)) anchorSelection(activeConnectionId, key);
    }
    setMenu({ x: e.clientX, y: e.clientY, object });
  }

  function chooseConnection(id: string) {
    const target = connMenu?.config;
    setConnMenu(null);
    if (!target) return;
    if (id.startsWith(DIAGRAM_PREFIX)) {
      const schema = id.slice(DIAGRAM_PREFIX.length);
      openObjectTab(target.id, { schema, name: schema, kind: "diagram" });
      return;
    }
    if (id === "edit") {
      setSheet(true, target);
      return;
    }
    // Both act on the row that was right-clicked, not on the active
    // connection: the export dialog reads the tree of whichever connection it
    // is given, so a database two rows down needs no switching to first.
    if (id === "export") {
      setExportTarget({ connectionId: target.id, keys: [] });
      return;
    }
    if (id === "import") {
      setImportTarget({ connectionId: target.id, path: null });
      return;
    }
    if (id === "disconnect") void disconnect(target.id);
    // Deleting takes the stored password and any derived connection with it,
    // so it goes in front of the user first.
    if (id === "delete") setDeleting(target);
  }

  function chooseDatabase(id: string) {
    const name = dbMenu?.name;
    setDbMenu(null);
    if (!name || !activeConnectionId) return;
    if (id === "export") void exportDatabase(activeConnectionId, name);
  }

  /**
   * Exports a database that may not be the one this session is in.
   *
   * The export dialog lists the schemas and tables the store holds, and the
   * store holds the *open* database's. So the database is opened first, which
   * is a second connection to the same server and the same thing clicking the
   * row does — there is no cheaper way to know what is in a database than to
   * open it.
   *
   * Opening derives its own connection id, so the dialog is pointed at
   * whichever connection came out of it rather than at the row that was
   * right-clicked. Read after the await, because everything above this closed
   * over the state as it was before.
   */
  async function exportDatabase(fromConnectionId: string, name: string) {
    if (open[fromConnectionId]?.currentDatabase !== name) {
      await openDatabase(fromConnectionId, name);
    }
    const state = useApp.getState();
    const id = state.activeConnectionId;
    // Opening reports its own failure. Putting a dialog in front of a database
    // that never opened would list the tables of the one still connected.
    if (!id || state.open[id]?.currentDatabase !== name) return;
    // Nothing preselected: the dialog carries the whole tree, and "everything
    // in this database" is a decision to make there rather than to assume.
    setExportTarget({ connectionId: id, keys: [] });
  }

  async function choose(id: string) {
    const target = menu?.object;
    setMenu(null);
    if (!target || !activeConnectionId) return;

    // Handled here rather than in `runObjectMenuAction`, which knows about
    // statements and clipboards and nothing about the workspace.
    if (id === "diagram.open") {
      openObjectTab(activeConnectionId, target);
      return;
    }

    if (id === "open.split") {
      openObjectTab(activeConnectionId, target, "split");
      return;
    }

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
    <aside
      ref={asideRef}
      style={{ width }}
      className="relative flex shrink-0 flex-col border-r border-line-soft bg-raised"
    >
      {/* Sits on the border itself and is wider than it, so the grab area is
          reachable without the border having to be thick enough to see. */}
      <div
        onPointerDown={onResizeDown}
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        className="group absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize"
      >
        <div className="h-full w-px translate-x-1 group-hover:bg-accent/40" />
      </div>

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

      <div
        ref={connRef}
        /* Only worth pinning when there is a second half to make room for. */
        style={{ height: schemaOpen ? (connHeight ?? undefined) : undefined }}
        className="shrink-0 overflow-y-auto px-1.5 pb-1"
      >
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

      {schemaOpen && (
        <>
          {/* Doubles as the rule between the two halves: the border this
              replaces was already drawn exactly here. */}
          <div
            onPointerDown={onRowDown}
            onDoubleClick={() => setConnHeight(null)}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize connection list"
            className="group relative mt-2 h-px shrink-0 cursor-row-resize bg-line-soft"
          >
            <div className="absolute -top-1 h-2 w-full group-hover:bg-accent/30" />
          </div>

          <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
            <span className="label-eyebrow">
              {serverOnly || keyspace ? "Databases" : "Schema"}
            </span>
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
              placeholder={
                keyspace ? "Filter databases" : serverOnly ? "Filter server" : "Filter tables"
              }
              className="w-full rounded border border-line-soft bg-base px-2 py-1 text-[11px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
            {keyspace ? (
              /* A key-value store's whole tree: numbered databases, each of
                 which is one flat namespace. No schemas, no object groups, and
                 no disclosure — there is nothing under a database except the
                 keys, and a caret hiding one row is a caret for its own sake.

                 Queues hang below it rather than inside a database, because
                 that is where they are: BullMQ writes into whichever database
                 the application connected to, and the section describes this
                 session's. */
              <>
              {visibleDatabases === null ? (
                <p className="flex items-center gap-1.5 py-2 pl-1.5 text-[11px] text-ink-faint">
                  <Spinner size={9} className="text-accent" label="Reading databases" />
                  Reading databases…
                </p>
              ) : visibleDatabases.length === 0 ? (
                <p className="py-2 pl-1.5 text-[11px] text-ink-faint">
                  {needle ? "No match" : "No databases."}
                </p>
              ) : (
                visibleDatabases.map((name) => {
                  const here = name === open[activeConnectionId]?.currentDatabase;
                  const opening = !!busy[busyKey.database(activeConnectionId, name)];
                  // The tab this row would open, so the row can show that it is
                  // the one on screen rather than leaving the grid unattributed.
                  const viewing = `${activeConnectionId}::${name}.${name}` === viewedTable;
                  return (
                    <button
                      key={name}
                      disabled={opening}
                      aria-busy={opening || undefined}
                      onClick={() =>
                        here
                          ? openObjectTab(activeConnectionId, {
                              schema: name,
                              name,
                              kind: "keyspace",
                            })
                          : // Another database is another session, exactly as it
                            // is on the SQL side: derived, credential inherited,
                            // and the tabs already open stay pointed where they
                            // were.
                            void openDatabase(activeConnectionId, name)
                      }
                      className={[
                        "flex w-full items-center gap-2 rounded py-1 pr-1.5 pl-1.5 text-left text-[12px]",
                        viewing
                          ? "bg-accent-wash text-ink"
                          : "text-ink-muted hover:bg-hover hover:text-ink",
                      ].join(" ")}
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
                      <span className="truncate font-mono">{name}</span>
                      {here && (
                        <span
                          aria-hidden="true"
                          className="ml-auto shrink-0 text-[10px] text-ink-faint"
                        >
                          {KIND_GLYPH.keyspace}
                        </span>
                      )}
                    </button>
                  );
                })
              )}

              <QueuesSection
                connectionId={activeConnectionId}
                needle={needle}
                viewedTable={viewedTable}
              />
              </>
            ) : serverOnly ? (
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
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setDbMenu({ x: e.clientX, y: e.clientY, name });
                          }}
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
                      onContextMenu={(e) =>
                        openMenu(e, { schema: s.name, name: s.name, kind: "diagram" })
                      }
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
          items={connectionMenuItems(
            !!open[connMenu.config.id],
            connMenu.config.id === activeConnectionId,
            isKeyspaceDriver(connMenu.config.driver),
            schemas[connMenu.config.id] ?? [],
          )}
          onSelect={chooseConnection}
          onClose={() => setConnMenu(null)}
        />
      )}

      {dbMenu && (
        <ContextMenu
          x={dbMenu.x}
          y={dbMenu.y}
          // No shortcut hint on this one. ⌘⇧E exports whatever connection is
          // active, which is not this row until the database has been opened.
          items={[{ kind: "item", id: "export", label: "Export tables…" }]}
          onSelect={chooseDatabase}
          onClose={() => setDbMenu(null)}
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
