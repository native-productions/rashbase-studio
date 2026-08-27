import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { useApp } from "@/store/app";

/**
 * A `.sql` file dropped on the window opens the import dialog on it.
 *
 * One listener for the whole window rather than a drop target drawn inside the
 * dialog. Dropping a dump is how someone with the file already in front of them
 * starts, and requiring them to open a dialog first so it has somewhere to land
 * is the wrong way round.
 *
 * The path never becomes a file in the webview. It is handed to the backend,
 * which opens it — a four gigabyte dump read into a JavaScript string is a tab
 * that stops responding before anything has been imported.
 *
 * Anything that is not a dump is ignored without a word. A window that answers
 * a dropped screenshot with an error is a window that is wrong about what the
 * user was doing.
 */
export function useSqlFileDrop() {
  useEffect(() => {
    const stop = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;

      const path = event.payload.paths.find(isDump);
      if (!path) return;

      const state = useApp.getState();
      // The dialog's own connection when it is already open, so a second file
      // dropped on it replaces the first rather than moving it to another
      // server. Otherwise whichever connection the workspace is pointed at.
      const connectionId = state.importTarget?.connectionId ?? state.activeConnectionId;
      if (!connectionId) {
        state.setToast({
          kind: "error",
          text: "Open a connection before importing a file.",
        });
        return;
      }
      state.setImportTarget({ connectionId, path });
    });
    return () => {
      void stop.then((off) => off());
    };
  }, []);
}

/**
 * Whether a path looks like a dump.
 *
 * The name only decides whether the dialog opens. What the file actually is
 * gets decided by the backend, which reads the gzip magic number rather than
 * trusting the suffix.
 */
function isDump(path: string): boolean {
  const name = path.toLowerCase();
  return name.endsWith(".sql") || name.endsWith(".sql.gz");
}
