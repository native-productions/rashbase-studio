import { useEffect, useState } from "react";
import { QueueFlow } from "@/components/queue/QueueFlow";
import { QueueJobs } from "@/components/queue/QueueJobs";
import { POLL_MS } from "@/lib/constants/bullmq";
import type { QueryTab } from "@/lib/types";
import { useApp } from "@/store/app";

/**
 * A queue tab: the lifecycle above, the jobs of the open state below.
 *
 * Split rather than tabbed, because the two answer different halves of one
 * question and looking at either usually means glancing at the other — the
 * diagram says where work is piling up, the grid says which jobs those are.
 *
 * The divider is dragged, not configured, and the split resets when the tab is
 * reopened. Nothing here is worth a preference: which half you want more of
 * changes between one look and the next.
 */

/** Both halves stay usable. Below this a pane is a scrollbar with a hint of
 *  content, which is worse than not having dragged at all. */
const FLOOR = 120;

export function QueueView({ tab }: { tab: QueryTab }) {
  const [jobsHeight, setJobsHeight] = useState(300);
  const open = tab.queue?.state != null;
  const live = tab.queue?.live ?? false;

  usePoll(tab.id, live);

  const onDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = jobsHeight;
    const container = e.currentTarget.parentElement;

    const move = (ev: PointerEvent) => {
      const max = (container?.clientHeight ?? 800) - FLOOR;
      setJobsHeight(Math.min(max, Math.max(FLOOR, startH - (ev.clientY - startY))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <QueueFlow tab={tab} />
      </div>

      {open && (
        <>
          <div
            onPointerDown={onDrag}
            role="separator"
            aria-orientation="horizontal"
            className="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-accent/30"
          />
          <div className="flex min-h-0 shrink-0 flex-col" style={{ height: jobsHeight }}>
            <QueueJobs tab={tab} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Polls while the tab is live and the window has focus.
 *
 * Focus is half the rule and not an optimisation. A queue monitor left open on
 * another desktop would otherwise spend a round trip a second forever against
 * a production Redis nobody is looking at, and the first poll after coming back
 * catches up anyway — the event stream is read from where the last one stopped,
 * not from now.
 *
 * The interval, not a chain of timeouts: a poll that hangs must not stop the
 * next one, and `pollQueue` is safe to overlap because it writes only what came
 * back and re-reads the tab before it does.
 */
function usePoll(tabId: string, live: boolean) {
  const pollQueue = useApp((s) => s.pollQueue);

  useEffect(() => {
    if (!live) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      void pollQueue(tabId);
      timer = setInterval(() => void pollQueue(tabId), POLL_MS);
    };
    const clear = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    // Guarded, because `blur` from an element inside the page can reach a
    // window listener. Without this, clicking a cell in the grid would stop the
    // polling until the window was focused again — which looks exactly like the
    // queue going quiet.
    const stop = () => {
      if (document.hasFocus() && !document.hidden) return;
      clear();
    };

    // `visibilitychange` covers a minimised window and a background tab;
    // blur and focus cover the window losing the foreground with the app still
    // visible, which on a desktop is the common one.
    const sync = () => (document.hidden ? stop() : start());
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", start);
    window.addEventListener("blur", stop);

    return () => {
      clear();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", start);
      window.removeEventListener("blur", stop);
    };
  }, [tabId, live, pollQueue]);
}
