import { useEffect, useRef, useState } from "react";
import { Logo } from "@/components/Logo";
import { Spinner } from "@/components/ui/Spinner";
import { asDbError } from "@/lib/utils/errors";
import { useApp } from "@/store/app";

/**
 * The launch gate.
 *
 * What it is, stated where the code is rather than only in the docs: this
 * screen is a lock on the window, not on the data. Nothing behind it is
 * encrypted, and anything with filesystem access reads `connections.json`
 * without ever meeting it. What it stops is the person who walks up to an
 * unlocked machine and finds this app already open on a production replica.
 *
 * It prompts itself on mount, because arriving here means the user has already
 * decided: making them click once to ask for the sheet they turned on is a
 * click that answers nothing. The button is the retry, and it is what the
 * screen shows once the first attempt comes back refused.
 *
 * No password field. The policy evaluated backend-side is
 * `DeviceOwnerAuthentication`, so the system's own prompt already carries "Use
 * Password…" — a second one here would be a login form this app has no
 * business drawing.
 */
export function LockScreen() {
  const unlock = useApp((s) => s.unlock);
  const [busy, setBusy] = useState(true);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** StrictMode mounts twice in development, and two Touch ID sheets stack. */
  const asked = useRef(false);

  async function ask() {
    setBusy(true);
    setRefusal(null);
    try {
      await unlock();
    } catch (e) {
      // The platform's own words. "User canceled authentication" and "Biometry
      // is locked out" are different situations and only one of them is fixed
      // by pressing the button again.
      setRefusal(asDbError(e).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void ask();
    // Once, on mount. `ask` closes over nothing that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-base px-8">
      <Logo size={44} className="text-accent" />

      <div className="text-center">
        <h1 className="text-[15px] font-semibold text-ink">Rashbase Studio is locked</h1>
        <p className="mt-1 text-[12px] text-ink-muted">
          Confirm it is you to reach your connections.
        </p>
      </div>

      <button
        onClick={() => void ask()}
        disabled={busy}
        className="pressable flex h-7 items-center gap-2 rounded-md bg-accent-fill px-3 text-[12px] font-medium text-on-accent disabled:opacity-50"
      >
        {busy && <Spinner size={11} label="Waiting for Touch ID" />}
        {busy ? "Waiting for Touch ID" : refusal ? "Try again" : "Unlock with Touch ID"}
      </button>

      {/* Held below the button rather than replacing anything, so the layout
          does not jump between the attempt and its answer. */}
      {refusal && <p className="max-w-72 text-center text-[11px] text-danger">{refusal}</p>}
    </div>
  );
}
