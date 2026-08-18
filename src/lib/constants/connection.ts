import type { ConnectionConfig, SshConfig, SslMode } from "@/lib/types";

/**
 * Every SSL mode the app offers, in the order the form lists them.
 *
 * One list, because there are two readers: the connection form draws a button
 * per entry, and the connection-string parser accepts a `sslmode=` parameter
 * only if it appears here. Two copies of this would let a mode be offered in
 * the form and rejected from a pasted URL, or the reverse.
 */
export const SSL_MODES: SslMode[] = [
  "disable",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
];

/** What Postgres assumes when a connection string omits the part. */
export const DEFAULT_HOST = "localhost";
export const DEFAULT_PORT = 5432;
export const DEFAULT_USER = "postgres";
export const DEFAULT_DATABASE = "postgres";

/** The connection form's starting state, which is also a working local one. */
/** The only driver so far. Named rather than assumed, so adding a second one
 *  is a change to this list and not a hunt for hardcoded strings. */
export const DEFAULT_DRIVER = "postgres";

export const BLANK_CONNECTION: ConnectionConfig = {
  id: "",
  driver: DEFAULT_DRIVER,
  name: "",
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  user: DEFAULT_USER,
  database: DEFAULT_DATABASE,
  sslMode: "prefer",
  environment: null,
  parentId: null,
  ssh: null,
};

export const DEFAULT_SSH_PORT = 22;

/** What switching the tunnel on starts from. */
export const BLANK_SSH: SshConfig = {
  host: "",
  port: DEFAULT_SSH_PORT,
  user: "",
  auth: "key",
  keyPath: "",
};

/**
 * The SSL modes that still mean something through a tunnel.
 *
 * `verify-ca` and `verify-full` check the server's certificate against the
 * hostname the client dialled, and through a tunnel that hostname is
 * `127.0.0.1` — never what the certificate says. They do not fail in a way
 * that explains itself, so they are not offered. The hop is already encrypted
 * by SSH; `require` keeps the database's own encryption on top of it.
 */
export const TUNNELLED_SSL_MODES: SslMode[] = SSL_MODES.filter((m) => !m.startsWith("verify"));

/** Where a tunnelled connection lands when it was on a verifying mode. */
export const TUNNELLED_SSL_FALLBACK: SslMode = "require";
