/**
 * Two things here fail quietly.
 *
 * The support answer decides which sentence a user on a platform without Touch
 * ID reads. Collapsing it to a boolean shows a Windows user "no sensor found",
 * which sends them into System Settings looking for something that was never
 * going to be there.
 *
 * `connectionGated` mirrors the backend's own test. A mirror that drifts draws
 * a lock on a connection that opens without one, or leaves it off a connection
 * that prompts — and the user only finds out at the moment they connect.
 */
import { expect, test } from "bun:test";
import { biometricSupport, connectionGated, DEFAULT_POLICY } from "@/lib/security";
import type { ConnectionConfig } from "@/lib/types";

const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)";

test("a Mac with a sensor is the only platform that gets controls", () => {
  expect(biometricSupport(true, MAC)).toBe("available");
});

test("no sensor on a Mac is a different answer from no Touch ID on Windows", () => {
  expect(biometricSupport(false, MAC)).toBe("unenrolled");
  expect(biometricSupport(false, WINDOWS)).toBe("coming-soon");
  expect(biometricSupport(false, LINUX)).toBe("unsupported");
});

/** The backend answers false off macOS regardless, so a stray true must not
 *  turn Windows into a platform that claims to enforce anything. */
test("the platform decides before the sensor does", () => {
  expect(biometricSupport(true, WINDOWS)).toBe("coming-soon");
  expect(biometricSupport(true, LINUX)).toBe("unsupported");
});

function conn(requireBiometric: boolean): ConnectionConfig {
  return { id: "c1", name: "prod", requireBiometric } as ConnectionConfig;
}

test("either switch gates a connection, and neither means neither", () => {
  expect(connectionGated(DEFAULT_POLICY, conn(false))).toBe(false);
  expect(connectionGated(DEFAULT_POLICY, conn(true))).toBe(true);
  expect(connectionGated({ ...DEFAULT_POLICY, requireForAllConnections: true }, conn(false))).toBe(
    true,
  );
});
