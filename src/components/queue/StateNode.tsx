import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { QueueStateSpec } from "@/lib/constants/bullmq";

/**
 * One state of the lifecycle.
 *
 * The second line is the whole reason this is not a labelled box. Someone
 * opening a queue for the first time should not have to already know what
 * BullMQ calls things, and a legend off to one side is a thing nobody reads.
 * One quiet sentence under the name, and then it stays out of the way.
 *
 * Colour carries one fact and one only: `failed` is the state you are looking
 * for. Giving each state its own hue would be seven colours competing in a
 * surface whose job is to be glanced at, and would spend the accent — which in
 * this app already means "the thing you are pointed at" — on something that is
 * not about focus.
 */

export interface StateNodeData extends Record<string, unknown> {
  spec: QueueStateSpec;
  /** Null on `added`, which is a source rather than somewhere jobs sit. */
  count: number | null;
  selected: boolean;
  /** Whether the queue as a whole is paused. Shown on `wait`, where it is the
   *  reason nothing is moving. */
  paused: boolean;
  handles: { bottomSource?: boolean; bottomTarget?: boolean };
}

const DOT = "!h-1.5 !w-1.5 !border-0 !bg-line";

function StateNodeImpl({ data }: NodeProps & { data: StateNodeData }) {
  const { spec, count, selected, paused, handles } = data;
  const danger = spec.id === "failed" && (count ?? 0) > 0;

  return (
    <div
      style={{ width: 176 }}
      // `bg-canvas` rather than `bg-raised`, matching `TableNode`: the canvas
      // is the one surface whose legibility may not depend on the desktop
      // showing through the window.
      className={[
        "rounded-md border bg-canvas px-2.5 py-2 shadow-lg shadow-black/30",
        selected ? "border-accent" : danger ? "border-danger/50" : "border-line",
      ].join(" ")}
    >
      <Handle type="target" position={Position.Left} className={DOT} />
      <Handle type="source" position={Position.Right} className={DOT} />
      {handles.bottomSource && (
        <Handle id="down" type="source" position={Position.Bottom} className={DOT} />
      )}
      {handles.bottomTarget && (
        <Handle id="up" type="target" position={Position.Bottom} className={DOT} />
      )}

      <div className="flex items-baseline gap-2">
        <span className="truncate text-[12px] font-medium text-ink">{spec.label}</span>
        {count !== null && (
          <span
            // Keyed on the value so a changed count re-runs the tick. The tick
            // is 160ms of opacity and nothing else: this is a surface someone
            // watches for minutes, and a number that jumps every second would
            // be the one thing on screen you cannot stop looking at.
            key={count}
            className={[
              "count-tick ml-auto font-mono text-[13px] tabular-nums",
              danger ? "text-danger" : count > 0 ? "text-ink" : "text-ink-faint",
            ].join(" ")}
          >
            {count.toLocaleString()}
          </span>
        )}
      </div>

      <div className="mt-0.5 truncate text-[10px] text-ink-faint">
        {paused && spec.id === "wait" ? "queue is paused, nothing is picked up" : spec.blurb}
      </div>
    </div>
  );
}

export const StateNode = memo(StateNodeImpl);
