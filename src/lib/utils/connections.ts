import {
  DEFAULT_HOST,
  DEFAULT_USER,
  DRIVERS,
  SSL_MODES,
  TUNNELLED_SSL_FALLBACK,
  driverSpec,
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
 * Pulls host/user/database out of a connection URL so a string copied from a
 * hosting dashboard becomes a filled-in form instead of six retypings.
 *
 * The scheme also picks the driver, which is the point of doing this in one
 * place: pasting a `redis://` URL into a form set to Postgres should switch the
 * form, not fail against the wrong parser. Returns null when the string is not
 * a connection URL for any driver we know.
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

  const spec = DRIVERS.find((d) => d.schemes.includes(url.protocol));
  if (!spec) return null;

  const sslMode = url.searchParams.get("sslmode");
  // `rediss://` is the scheme's own way of saying TLS, and it carries no
  // `sslmode` parameter to read it off.
  const impliedSsl: SslMode | null = url.protocol === "rediss:" ? "require" : null;
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));

  return {
    patch: {
      driver: spec.id,
      host: url.hostname || DEFAULT_HOST,
      port: url.port ? Number(url.port) : spec.port,
      // Redis authenticates as the implicit `default` account when no user is
      // named, and putting "postgres" in the field would be a username that
      // fails on a server with ACLs.
      user: decodeURIComponent(url.username) || (spec.keyspace ? "" : DEFAULT_USER),
      database: database || spec.database.default,
      ...(SSL_MODES.includes(sslMode as SslMode)
        ? { sslMode: sslMode as SslMode }
        : impliedSsl
          ? { sslMode: impliedSsl }
          : {}),
    },
    password: url.password ? decodeURIComponent(url.password) : "",
  };
}

/**
 * The form reset to a driver's own defaults, keeping what the user already
 * typed that still means the same thing.
 *
 * Host, name, environment and the tunnel survive a driver switch because they
 * describe *where* the server is, which the choice of driver does not change.
 * The port and the database do not: those describe what is listening there.
 */
export function forDriver(config: ConnectionConfig, driver: string): ConnectionConfig {
  const from = driverSpec(config.driver);
  const to = driverSpec(driver);
  return {
    ...config,
    driver,
    // Only when it was still the old driver's default. A port someone typed is
    // a decision, and overwriting it would be the form arguing with them.
    port: config.port === from.port ? to.port : config.port,
    database: config.database === from.database.default ? to.database.default : config.database,
    user: config.user === "postgres" && to.keyspace ? "" : config.user,
    // An SSL mode the new driver does not offer would leave the select showing
    // a value that is not in its own list.
    sslMode: to.sslModes.includes(config.sslMode) ? config.sslMode : to.sslModes[0]!,
  };
}
