import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type OnNodeDrag,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ErdPanel } from "@/components/erd/ErdPanel";
import { TableNode, type TableNodeData } from "@/components/erd/TableNode";
import { Spinner } from "@/components/ui/Spinner";
import { autoLayout, buildEdges, fkColumnSet, fkTargets, tableNames } from "@/lib/erd";
import { DEFAULT_PREFS, loadErdPrefs, prefsKey, saveErdPrefs } from "@/lib/erdPrefs";
import type { QueryTab, SchemaGraph } from "@/lib/types";

/**
 * The schema as a picture.
 *
 * Four things here are load-bearing for how this performs, and all four are
 * easy to undo by accident:
 *
 *  1. `nodeTypes` is a module constant. An object literal in the render body is
 *     a new identity every frame, and React Flow responds by remounting every
 *     node — which turns a drag into a full rebuild of the canvas.
 *  2. Node positions live in this component's state, not in the app store.
 *     Dragging emits a change per pointer move; routing that through the store
 *     would re-render the sidebar and the tab strip sixty times a second for a
 *     gesture neither of them can see. The store learns nothing about layout.
 *  3. Positions are written to storage on drag *stop*, not on drag.
 *  4. Nodes render collapsed. See `TableNode`.
 *
 * `onlyRenderVisibleElements` is conditional rather than always on: the culling
 * pass runs on every viewport change and costs more than it saves until there
 * are enough nodes offscreen to be worth skipping.
 */

const nodeTypes: NodeTypes = { table: TableNode };
const CULL_ABOVE = 40;

/**
 * `ink-faint`, not `line`. `line` is the border token: right for the edge of a
 * box that is already there, too dark for a thread the eye has to follow
 * across a canvas.
 */
const EDGE_STYLE = { stroke: "var(--color-ink-faint)", strokeWidth: 1.5 };

/**
 * The arrowhead is not decoration. A foreign key is directional — this table
 * points at that one — and an undecorated line says only that the two are
 * related, which is the half of the fact you could already get from a list.
 */
const EDGE_MARKER = {
  type: MarkerType.ArrowClosed,
  width: 16,
  height: 16,
  color: "var(--color-ink-faint)",
} as const;

export function ErdView({ tab }: { tab: QueryTab }) {
  const { graph, object, connectionId } = tab;

  if (!graph || !object || !connectionId) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-ink-faint">
        <Spinner size={11} className="text-accent" label="Reading schema" />
        Reading schema…
      </div>
    );
  }

  // Keyed on the schema so switching to a different diagram rebuilds rather
  // than trying to reconcile one schema's nodes against another's.
  return (
    <Canvas
      key={`${connectionId}::${object.schema}`}
      graph={graph}
      schema={object.schema}
      connectionId={connectionId}
    />
  );
}

function Canvas({
  graph,
  schema,
  connectionId,
}: {
  graph: SchemaGraph;
  schema: string;
  connectionId: string;
}) {
  const key = prefsKey(connectionId, schema);
  const initial = useRef(loadErdPrefs(key)).current;

  const [dots, setDots] = useState(initial.dots);
  const [expanded, setExpanded] = useState(initial.expanded);
  const [selected, setSelected] = useState<string | null>(null);

  // Positions are the one piece of state that survives the component, so they
  // are tracked in a ref as well: reading them back out of `nodes` inside a
  // callback would close over a stale copy.
  const positions = useRef<Record<string, { x: number; y: number }>>({ ...initial.positions });

  // Only what the user moved is stored, and a stored position is therefore the
  // record of a decision. Everything else is the automatic layout, which is
  // deterministic — so an untouched diagram comes back looking identical
  // without a byte of it being written down, and is free to be laid out again
  // when the node bodies change size under it.
  const dragged = useRef(new Set(Object.keys(initial.positions)));

  const { fks, targets, edges } = useMemo(() => {
    const fks = fkColumnSet(graph.relations);
    return {
      fks,
      targets: fkTargets(graph.relations),
      edges: buildEdges(graph.relations, tableNames(graph)).map(
        (e): Edge => ({
          id: e.id,
          source: e.source,
          target: e.target,
          // A self reference has nowhere to go between two node-level handles,
          // so it is drawn as a curve rather than a zero-length line.
          type: e.source === e.target ? "default" : "smoothstep",
          style: EDGE_STYLE,
          markerEnd: EDGE_MARKER,
          data: { label: e.label },
        }),
      ),
    };
  }, [graph]);

  /**
   * Positions for a first look, laid out for whatever the node bodies are
   * showing now. Recomputed when that changes, because a node that has grown by
   * twenty columns no longer fits the gap the layout left for it.
   */
  const layout = useMemo(
    () => autoLayout(graph.tables, graph.relations, fks, expanded),
    [graph, fks, expanded],
  );

  const initialNodes = useMemo(
    () =>
      layout.map((placed): Node => {
        const table = graph.tables.find((t) => t.name === placed.name)!;
        return {
          id: table.name,
          type: "table",
          position: positions.current[table.name] ?? { x: placed.x, y: placed.y },
          data: {
            table,
            fks,
            targets,
            expanded: initial.expanded,
            selected: false,
          } satisfies TableNodeData,
        };
      }),
    // Built once. Later changes to `expanded` and `selected` are pushed through
    // `setNodes` rather than by rebuilding this list, so a dragged node keeps
    // where the user put it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);

  /** Rewrites only the two data fields the chrome owns. */
  const patchData = useCallback(
    (next: { expanded?: boolean; selected?: string | null }) =>
      setNodes((ns) =>
        ns.map((n) => ({
          ...n,
          data: {
            ...(n.data as TableNodeData),
            ...(next.expanded === undefined ? {} : { expanded: next.expanded }),
            ...(next.selected === undefined ? {} : { selected: n.id === next.selected }),
          },
        })),
      ),
    [setNodes],
  );

  const persist = useCallback(
    (patch: Partial<{ dots: boolean; expanded: boolean }> = {}) =>
      saveErdPrefs(key, {
        ...DEFAULT_PREFS,
        dots,
        expanded,
        ...patch,
        positions: positions.current,
      }),
    [key, dots, expanded],
  );

  const onNodeDragStop = useCallback<OnNodeDrag>(
    (_e, node) => {
      positions.current[node.id] = node.position;
      dragged.current.add(node.id);
      persist();
    },
    [persist],
  );

  // Showing every column makes each node taller, which the layout the nodes
  // were placed by no longer accounts for. Only the ones nobody has moved are
  // re-placed: a table the user dragged somewhere is there because they put it
  // there, and tidying it away would be the app overruling them.
  const firstLayout = useRef(true);
  useEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    setNodes((ns) =>
      ns.map((n) => {
        if (dragged.current.has(n.id)) return n;
        const placed = layout.find((p) => p.name === n.id);
        return placed ? { ...n, position: { x: placed.x, y: placed.y } } : n;
      }),
    );
  }, [layout, setNodes]);

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_e, node) => {
      setSelected(node.id);
      patchData({ selected: node.id });
    },
    [patchData],
  );

  const closePanel = useCallback(() => {
    setSelected(null);
    patchData({ selected: null });
  }, [patchData]);

  const toggleExpanded = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    patchData({ expanded: next });
    persist({ expanded: next });
  }, [expanded, patchData, persist]);

  const toggleDots = useCallback(() => {
    const next = !dots;
    setDots(next);
    persist({ dots: next });
  }, [dots, persist]);

  const relayout = useCallback(() => {
    positions.current = {};
    dragged.current.clear();
    setNodes((ns) =>
      ns.map((n) => {
        const placed = layout.find((p) => p.name === n.id);
        return placed ? { ...n, position: { x: placed.x, y: placed.y } } : n;
      }),
    );
    persist();
  }, [layout, setNodes, persist]);

  if (graph.tables.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-ink-faint">
        {schema} has no relations to draw.
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0">
      <div className="min-w-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
          onPaneClick={closePanel}
          onlyRenderVisibleElements={graph.tables.length > CULL_ABOVE}
          // Nothing here connects nodes by hand: the edges are the database's,
          // and a diagram that let you draw one would be claiming otherwise.
          nodesConnectable={false}
          elementsSelectable={false}
          colorMode="dark"
          minZoom={0.15}
          maxZoom={2}
          fitView
          // Trackpad convention rather than React Flow's default: two fingers
          // pan and pinch zooms, which is what every other canvas on this
          // platform does. Ctrl+wheel still zooms, for a mouse.
          panOnScroll
          zoomOnScroll={false}
          zoomOnPinch
          proOptions={{ hideAttribution: true }}
        >
          {dots && (
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--color-line)" />
          )}
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor="var(--color-line)" maskColor="rgb(0 0 0 / 0.6)" />

          <Panel position="top-left" className="flex gap-1">
            <ToolbarButton on={dots} onClick={toggleDots}>
              Dots
            </ToolbarButton>
            <ToolbarButton on={expanded} onClick={toggleExpanded}>
              All columns
            </ToolbarButton>
            <ToolbarButton on={false} onClick={relayout}>
              Reset layout
            </ToolbarButton>
          </Panel>
        </ReactFlow>
      </div>

      {selected && (
        <ErdPanel
          connectionId={connectionId}
          schema={schema}
          table={selected}
          relations={graph.relations}
          onClose={closePanel}
        />
      )}
    </div>
  );
}

const ToolbarButton = ({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    onClick={onClick}
    aria-pressed={on}
    className={[
      "pressable rounded border border-line bg-raised px-2 py-1 text-[11px]",
      on ? "text-accent" : "text-ink-muted hover:text-ink",
    ].join(" ")}
  >
    {children}
  </button>
);
