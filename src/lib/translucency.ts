/**
 * Whether the window lets the desktop through.
 *
 * `localStorage` rather than the Rust side, for the same reason as
 * `pinnedTabs.ts`: this is a window appearance preference, not data.
 *
 * Two halves have to agree. The OS side is a compositor effect behind a
 * transparent window; the CSS side is `--surface-alpha`, which every chrome
 * surface multiplies into its own colour. Turning on one without the other
 * gives either a window you can see straight through or an effect nothing
 * reveals, so both are switched from here and nowhere else.
 */
const KEY = "rashbase.translucency.v1";

/**
 * Pure, so the default can be tested without a window.
 *
 * A stored answer always wins, including a stored "off" on a platform that
 * supports the effect. With nothing stored, on for macOS and Windows and off
 * for Linux, where there is nothing to switch on.
 */
export function resolveTranslucency(stored: string | null, userAgent: string): boolean {
  if (stored === "on") return true;
  if (stored === "off") return false;
  return /Macintosh|Mac OS X|Windows/.test(userAgent);
}

export function loadTranslucency(): boolean {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    /* A disabled store costs the user the preference, nothing more. */
  }
  // Guarded: this runs at store construction, which is also what the test
  // runner does when it imports anything that reaches the store.
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return resolveTranslucency(stored, ua);
}

export function saveTranslucency(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* Same: the window still looks right for this session. */
  }
}

/**
 * The effect call is allowed to fail. Outside Tauri, or on a platform with no
 * supported effect, the attribute alone is already correct: every surface
 * paints solid at `--surface-alpha: 1` and the window reads as an ordinary
 * opaque one.
 */
export async function applyTranslucency(on: boolean) {
  document.documentElement.dataset.translucent = on ? "on" : "off";
  try {
    const { getCurrentWindow, Effect, EffectState } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (on) {
      await win.setEffects({
        // First supported effect wins, so one list covers every platform:
        // `UnderWindowBackground` blurs what is actually behind the window on
        // macOS, Mica on Windows 11, Acrylic on Windows 10. Linux supports
        // none of them and falls through to the opaque path.
        effects: [Effect.UnderWindowBackground, Effect.Mica, Effect.Acrylic],
        // Not `FollowsWindowActiveState`: an unfocused window that goes flat
        // reads as the app having lost something, and this app is read while
        // the focus is in a terminal next to it.
        state: EffectState.Active,
      });
    } else {
      await win.clearEffects();
    }
  } catch {
    /* No effect available. The CSS half already covers this case. */
  }
}
