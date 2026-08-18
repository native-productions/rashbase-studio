import {
  DEFAULT_DATABASE,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_USER,
  SSL_MODES,
  TUNNELLED_SSL_FALLBACK,
} from "@/lib/constants/connection";
import type { ConnectionConfig, SslMode } from "@/lib/types";

/**
 * The SSL mode a connection ends up on once it goes through a tunnel.
 *
 * `verify-ca` and `verify-full` check the server's certificate against the
 * hostname the client dialled. Through a tunnel that is `127.0.0.1`, never
 * what the certificate says, so they fail every time with a message about a
 * bad certificate rather than about the tunnel. Moved rather than left to
 * fail, and moved in one place so the form and anything that later builds a
 * tunnelled connection cannot disagree about it.
 */
export function sslModeThroughTunnel(mode: SslMode): SslMode {
  return mode.startsWith("verify") ? TUNNELLED_SSL_FALLBACK : mode;
}

/**
 * The path as the user would have typed it: `~/.ssh/id_ed25519` rather than
 * the absolute path the file picker returns.
 *
 * Cosmetic on the machine that picked it, but the connection list is a file a
 * user copies between machines, and `~` is the only spelling of a key path
 * that survives the trip. The backend expands `~` either way, so nothing here
 * depends on this having run.
 */
export function tildePath(path: string, home: string): string {
  const root = home.replace(/\/+$/, "");
  return root && path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path;
}

/**
 * A connection that named no database.
 *
 * Postgres answers a blank database name with one named after the connecting
 * role, so the session opens against something arbitrary. Treated as a server
 * to pick a database from rather than as a database.
 */
export const isServerOnly = (c: ConnectionConfig): boolean => c.database.trim() === "";

/**
 * Servers first, each followed by the databases picked off it.
 *
 * A dozen databases listed flat beside the servers they came from reads as a
 * dozen unrelated connections, which is exactly the thing the nesting exists to
 * prevent. Any connection whose parent has been deleted falls to the end rather
 * than disappearing.
 */
export function nestConnections(
  connections: ConnectionConfig[],
): { config: ConnectionConfig; child: boolean }[] {
  const byParent = new Map<string, ConnectionConfig[]>();
  for (const c of connections) {
    if (!c.parentId) continue;
    byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
  }
  const placed = new Set<string>();
  const out = connections
    .filter((c) => !c.parentId)
    .flatMap((parent) => {
      placed.add(parent.id);
      const children = byParent.get(parent.id) ?? [];
      children.forEach((c) => placed.add(c.id));
      return [
        { config: parent, child: false },
        ...children.map((config) => ({ config, child: true })),
      ];
    });
  return [
    ...out,
    ...connections.filter((c) => !placed.has(c.id)).map((config) => ({ config, child: false })),
  ];
}

/**
 * Pulls host/user/database out of a libpq URL so a connection string copied
 * from a hosting dashboard becomes a filled-in form instead of six retypings.
 * Returns null when the string is not a Postgres URL at all.
 */
export function parseConnectionString(
  raw: string,
): { patch: Partial<ConnectionConfig>; password: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;

  const sslMode = url.searchParams.get("sslmode");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));

  return {
    patch: {
      host: url.hostname || DEFAULT_HOST,
      port: url.port ? Number(url.port) : DEFAULT_PORT,
      user: decodeURIComponent(url.username) || DEFAULT_USER,
      database: database || DEFAULT_DATABASE,
      ...(SSL_MODES.includes(sslMode as SslMode) ? { sslMode: sslMode as SslMode } : {}),
    },
    password: url.password ? decodeURIComponent(url.password) : "",
  };
}
