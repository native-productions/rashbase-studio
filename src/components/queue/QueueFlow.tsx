import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { BeamEdge } from "@/components/queue/BeamEdge";
import { StateNode, type StateNodeData } from "@/components/queue/StateNode";
import { Spinner } from "@/components/ui/Spinner";
import { QUEUE_EDGES, QUEUE_STATES } from "@/lib/constants/bullmq";
import type { QueryTab } from "@/lib/types";
import { busyKey, useApp } from "@/store/app";

/**
 * A queue as its lifecycle.
 *
 * The canvas only. The jobs of whichever state is selected are drawn under it
 * by `QueueView`, in the grid the rest of the app already uses — a nine-column
 * job row does not fit a side panel, and inventing a narrower table for it
 * would be a second grid to keep in step with the first.
 *
 * The layout is a constant, not an algorithm: BullMQ's lifecycle is the same
 * shape for every queue that has ever existed, so there is no dagre pass, no
 * stored positions, no drag to persist and no "reset layout". That is most of
 * what `lib/erd.ts` does, and none of it applies to a graph that cannot change.
 *
 * What does change is what is moving through it, which is the whole point:
 * counts in the nodes, measured rates on the edges. Nothing here animates for
 * its own sake — an edge that saw nothing in the last five seconds draws a
 * still line, so a queue that has stopped looks stopped.
 */

const nodeTypes: NodeTypes = { state: StateNode };
const edgeTypes: EdgeTypes = { beam: BeamEdge };

const MARKER = {
  type: MarkerType.ArrowClosed,
  width: 14,
  height: 14,
  color: "var(--color-ink-faint)",
} as const;

export function QueueFlow({ tab }: { tab: QueryTab }) {
  const { queue, object, connectionId } = tab;

  if (!queue || !object || !connectionId) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-ink-faint">
        <Spinner size={11} className="text-accent" label="Reading queue" />
        Reading queue…
      </div>
    );
  }

  return <Canvas tab={tab} />;
}

function Canvas({ tab }: { tab: QueryTab }) {
  const queue = tab.queue!;
  const name = tab.object!.name;
  const selectQueueState = useApp((s) => s.selectQueueState);
  const setQueueLive = useApp((s) => s.setQueueLive);
  // Only an asked-for refresh, never the poll: an indicator that blinked once a
  // second would say "busy" permanently and therefore say nothing.
  const refreshing = useApp((s) => !!s.busy[busyKey.queue(tab.id)]);

  const { nodes, edges } = useMemo(() => {
    // `prioritized` and `waiting-children` only exist for applications that
    // use priorities or flows. Drawing them empty on every other queue is two
    // boxes of noise in a surface whose whole job is to be glanced at.
    const shown = QUEUE_STATES.filter((s) => s.always || (queue.counts[s.id] ?? 0) > 0);
    const present = new Set(shown.map((s) => s.id));

    const drawn = QUEUE_EDGES.filter(
      (e) => present.has(e.source) && present.has(e.target),
    );
    const feedback = new Set(drawn.filter((e) => e.feedback).map((e) => e.id));

    const nodes = shown.map(
      (spec): Node => ({
        id: spec.id,
        type: "state",
        position: { x: spec.x, y: spec.y },
        data: {
          spec,
          count: spec.id === "added" ? null : (queue.counts[spec.id] ?? 0),
          selected: queue.state === spec.id,
          paused: queue.paused,
          handles: {
            bottomSource: [...feedback].some((id) => id.startsWith(`${spec.id}->`)),
            bottomTarget: [...feedback].some((id) => id.endsWith(`->${spec.id}`)),
          },
        } satisfies StateNodeData,
      }),
    );

    const edges = drawn.map(
      (e): Edge => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "beam",
        markerEnd: MARKER,
        // The retry edge runs right to left against every other edge here.
        // Routed out of the bottom and back in underneath, it reads as a loop
        // returning work; routed through the default side handles it reads as
        // a line drawn across the middle of the diagram by mistake.
        ...(e.feedback
          ? {
              sourceHandle: "down",
              targetHandle: "up",
              sourcePosition: Position.Bottom,
              targetPosition: Position.Bottom,
            }
          : {}),
        data: { rate: queue.rates === null ? null : (queue.rates[e.id] ?? 0) },
      }),
    );

    return { nodes, edges };
  }, [queue.counts, queue.rates, queue.state, queue.paused]);

  const onNodeClick: NodeMouseHandler = (_e, node) => {
    if (node.id === "added") return; // A source, not somewhere jobs sit.
    void selectQueueState(tab.id, node.id);
  };

  return (
    <div className="flex h-full min-w-0">
      <div className="min-w-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={() => void selectQueueState(tab.id, null)}
          // The lifecycle is the database's, not something to rearrange: there
          // is no layout here worth letting someone break.
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          colorMode="dark"
          minZoom={0.3}
          maxZoom={1.75}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          // Trackpad convention, matching the diagram: two fingers pan and
          // pinch zooms, which is what every other canvas on this platform does.
          panOnScroll
          zoomOnScroll={false}
          zoomOnPinch
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--color-line)" />
          <Controls showInteractive={false} />

          <Panel position="top-left" className="flex items-center gap-2">
            <button
              onClick={() => setQueueLive(tab.id, !queue.live)}
              aria-pressed={queue.live}
              className={[
                "pressable rounded border border-line bg-raised px-2 py-1 text-[11px]",
                queue.live ? "text-accent" : "text-ink-muted hover:text-ink",
              ].join(" ")}
            >
              {queue.live ? "Live" : "Paused"}
            </button>
            {refreshing && <Spinner size={10} className="text-accent" label="Refreshing" />}
            <span className="font-mono text-[10px] text-ink-faint">
              {queue.prefix}:{name}
            </span>
            {queue.paused && (
              <span className="rounded border border-line bg-raised px-1.5 py-0.5 text-[10px] text-ink-muted">
                queue paused
              </span>
            )}
            {/* Said out loud rather than shown as an absence. Every beam is off
                and every rate is missing, and without this the diagram looks
                like a queue where nothing is happening. */}
            {queue.rates === null && (
              <span className="rounded border border-danger/40 bg-danger/10 px-1.5 py-0.5 text-[10px] text-danger">
                events trimmed · rate unknown
              </span>
            )}
          </Panel>
        </ReactFlow>
      </div>
    </div>
  );
}
