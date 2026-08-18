import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { runCommand } from "@/lib/commands";

/**
 * The native menu bar, wired to the same registry as everything else.
 *
 * A menu item carries nothing but the id of a command, so picking one is the
 * same call the palette and the keyboard layer make. Ids that belong to a
 * predefined item — Copy, Minimize, Enter Full Screen — arrive here too and are
 * handled natively; `runCommand` ignores what it does not know, which is
 * cheaper than keeping a second list of what to skip and one more thing to
 * forget to update.
 */
const MENU_EVENT = "menu://command";

export function useAppMenu() {
  useEffect(() => {
    const stop = listen<string>(MENU_EVENT, (event) => runCommand(event.payload));
    return () => {
      void stop.then((off) => off());
    };
  }, []);
}
