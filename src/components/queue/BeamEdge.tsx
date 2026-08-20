import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

/**
 * An edge that moves at the speed the queue is actually moving.
 *
 * The beam is a measurement, not decoration, and everything here follows from
 * that one commitment:
 *
 *  - **No rate, no beam.** An edge nothing crossed in the last five seconds
 *    draws a plain line. A queue that has stopped looks stopped, which is the
 *    single most useful thing this surface can say.
 *  - **Unknown is not zero.** When the event stream was trimmed past the resume
 *    point the rate is `null`, and a `null` draws no beam and no number.
 *    Drawing a zero would claim the queue is idle at the exact moment we
 *    cannot tell.
 *  - **The number is on the edge.** Speed alone cannot separate four a second
 *    from four hundred, and this app states facts rather than implying them.
 *    The beam is for the glance, the label is for the answer.
 *
 * Drawn as a dashed overlay whose `stroke-dashoffset` animates, rather than as
 * particles travelling a path. One extra `<path>` per edge instead of one
 * element per dot, no `offset-path` support question across three webviews, and
 * a rate of two hundred a second costs exactly what a rate of two does.
 */

export interface BeamEdgeData extends Record<string, unknown> {
  /** Transitions per second. `null` means the window had a gap in it. */
  rate: number | null;
}

/** Where the speed mapping saturates. Above this the beam stops getting
 *  faster and only the label keeps counting. */
const RATE_CEILING = 200;

const MIN_SPEED = 14; // px/s at the slowest rate that still draws
const MAX_SPEED = 190; // px/s at the ceiling

/** The dash pattern, in px. Kept constant so density reads as one thing and
 *  speed reads as another; both varying at once is a rate nobody can compare. */
const DASH = 3;
const GAP = 13;

/**
 * Log rather than linear.
 *
 * A queue doing one a second and a queue doing eighty are both ordinary, and on
 * a linear scale the first is indistinguishable from stopped. What the eye
 * needs to separate here is orders of magnitude.
 */
function intensity(rate: number): number {
  return Math.min(1, Math.log10(1 + rate) / Math.log10(1 + RATE_CEILING));
}

function BeamEdgeImpl({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
  });

  const rate = (data as BeamEdgeData | undefined)?.rate ?? null;
  const moving = rate !== null && rate > 0;
  const t = moving ? intensity(rate) : 0;
  const seconds = moving ? (DASH + GAP) / (MIN_SPEED + t * (MAX_SPEED - MIN_SPEED)) : 0;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        // `ink-faint`, not `line`: `line` is the border token, right for the
        // edge of a box that is already there and too dark for a thread the eye
        // has to follow across a canvas. An edge nothing is crossing recedes
        // further still.
        style={{
          stroke: "var(--color-ink-faint)",
          strokeWidth: 1.5,
          opacity: moving ? 0.5 : 0.28,
        }}
      />

      {moving && (
        <path
          className="beam"
          d={path}
          fill="none"
          style={{
            stroke: "var(--color-ink)",
            strokeWidth: 1.5 + t * 1.5,
            strokeDasharray: `${DASH} ${GAP}`,
            opacity: 0.35 + t * 0.55,
            animationDuration: `${seconds}s`,
          }}
        />
      )}

      {moving && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            className="pointer-events-none absolute rounded bg-canvas px-1 font-mono text-[10px] tabular-nums text-ink-muted"
          >
            {/* Two significant figures below one a second, none above it. A
                queue doing 0.4/s and one doing 0/s are different facts; a queue
                doing 12/s and one doing 12.4/s are not. */}
            {rate < 1 ? rate.toFixed(1) : Math.round(rate)}/s
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const BeamEdge = memo(BeamEdgeImpl);
