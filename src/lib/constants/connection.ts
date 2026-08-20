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

export const DEFAULT_DRIVER = "postgres";

/**
 * What each driver is called, and what the form should assume about it.
 *
 * One entry per supported server, so adding a third is a change to this list
 * rather than a hunt through the form for hardcoded strings. Everything the
 * connection sheet varies by driver is a field here; nothing about a driver is
 * decided by a comparison against its id somewhere else.
 */
export interface DriverSpec {
  /** Matches `ConnectionConfig.driver` and the backend's `Driver::id`. */
  id: string;
  label: string;
  port: number;
  /** URL schemes a pasted connection string may use. */
  schemes: string[];
  /** What the `database` field is called and means for this driver. */
  database: {
    label: string;
    placeholder: string;
    /** Shown under the field. Blank means something different per driver. */
    hint: string;
    default: string;
  };
  /** SSL modes worth offering. A store with one transport has fewer answers. */
  sslModes: SslMode[];
  /** Whether this driver has schemas, tables, and SQL, or a flat keyspace. */
  keyspace: boolean;
}

export const DRIVERS: DriverSpec[] = [
  {
    id: "postgres",
    label: "PostgreSQL",
    port: 5432,
    schemes: ["postgres:", "postgresql:"],
    database: {
      label: "Database",
      placeholder: "Choose after connecting",
      hint: "Blank lists every database on the server",
      default: "postgres",
    },
    sslModes: ["disable", "prefer", "require", "verify-ca", "verify-full"],
    keyspace: false,
  },
  {
    id: "redis",
    label: "Redis",
    port: 6379,
    schemes: ["redis:", "rediss:"],
    database: {
      label: "DB",
      placeholder: "0",
      // Numbered rather than named, and there are always sixteen of them, so
      // "blank lists every database" would be describing a different product.
      hint: "Blank starts at db0. Pick another from the sidebar.",
      default: "",
    },
    // A tunnel is already encrypted by SSH and a direct connection to Redis is
    // usually on a private network. The verifying modes are Postgres-shaped
    // answers to a question this driver does not ask.
    sslModes: ["disable", "require"],
    keyspace: true,
  },
];

export const driverSpec = (id: string): DriverSpec =>
  DRIVERS.find((d) => d.id === id) ?? DRIVERS[0]!;

/** Whether a connection's driver browses a flat keyspace rather than tables. */
export const isKeyspaceDriver = (driver: string): boolean => driverSpec(driver).keyspace;

/** The connection form's starting state, which is also a working local one. */

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
  requireBiometric: false,
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
