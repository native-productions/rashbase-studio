import type { ConnectionConfig, SecurityPolicy } from "@/lib/types";

/**
 * What this window can say about biometrics, and it is deliberately four
 * answers rather than a boolean.
 *
 * "Windows Hello is not built yet" and "this Mac has no Touch ID sensor" and
 * "Linux has nothing to offer here" are three different sentences, and a
 * single disabled switch says none of them. The Settings section prints the
 * one that applies and shows no control at all unless it is `available`.
 */
export type BiometricSupport = "available" | "unenrolled" | "coming-soon" | "unsupported";

export const DEFAULT_POLICY: SecurityPolicy = {
  lockOnLaunch: false,
  requireForAllConnections: false,
};

/**
 * Pure, so the platform branches can be tested without a window.
 *
 * `available` is the backend's answer: on macOS it is whether a sensor exists
 * and someone is enrolled on it. Everywhere else it is false, which is why the
 * platform has to be read here too — false on a Mac and false on Windows mean
 * different things to the person reading the screen.
 */
export function biometricSupport(available: boolean, userAgent: string): BiometricSupport {
  if (/Macintosh|Mac OS X/.test(userAgent)) return available ? "available" : "unenrolled";
  if (/Windows/.test(userAgent)) return "coming-soon";
  return "unsupported";
}

/** The one sentence shown in place of the controls when there are none. */
export const SUPPORT_NOTE: Record<Exclude<BiometricSupport, "available">, string> = {
  unenrolled:
    "This Mac has no Touch ID sensor, or nobody is enrolled on it. Add a fingerprint in System Settings to use these.",
  "coming-soon": "Windows Hello — coming soon. Nothing here is enforced on Windows yet.",
  unsupported: "Touch ID is macOS only. Nothing here is enforced on this platform.",
};

/**
 * Whether opening this connection meets a prompt.
 *
 * A read-only mirror of the backend's own test, for drawing a lock beside a
 * gated connection and for greying the per-connection list when the app-wide
 * switch has already answered for all of them. The gate itself is in
 * `commands/security.rs`; this decides nothing.
 */
export function connectionGated(policy: SecurityPolicy, config: ConnectionConfig): boolean {
  return policy.requireForAllConnections || config.requireBiometric;
}
