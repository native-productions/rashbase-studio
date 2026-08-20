import { expect, test } from "bun:test";
import {
  forDriver,
  parseConnectionString,
  siblingSessions,
  sslModeThroughTunnel,
  tildePath,
} from "@/lib/utils/connections";
import { BLANK_CONNECTION } from "@/lib/constants/connection";
import type { ConnectionConfig } from "@/lib/types";

test("parses a full connection string", () => {
  const r = parseConnectionString("postgresql://ada:s3cret@db.example.com:6543/shop?sslmode=require");
  expect(r?.patch).toEqual({
    driver: "postgres",
    host: "db.example.com",
    port: 6543,
    user: "ada",
    database: "shop",
    sslMode: "require",
  });
  expect(r?.password).toBe("s3cret");
});

test("falls back to Postgres defaults for the parts a URL can omit", () => {
  const r = parseConnectionString("postgres://localhost");
  expect(r?.patch).toEqual({
    driver: "postgres",
    host: "localhost",
    port: 5432,
    user: "postgres",
    database: "postgres",
  });
  expect(r?.password).toBe("");
});

/**
 * The scheme picks the driver. Without this, pasting a Redis URL into a form
 * set to Postgres fills in the host and then fails against the wrong server.
 */
test("a redis URL selects the redis driver and its own port", () => {
  const r = parseConnectionString("redis://cache.example.com/3");
  expect(r?.patch.driver).toBe("redis");
  expect(r?.patch.port).toBe(6379);
  expect(r?.patch.database).toBe("3");
  // Redis authenticates as the implicit `default` account when none is named,
  // so "postgres" would be a username that fails on a server with ACLs.
  expect(r?.patch.user).toBe("");
});

/** `rediss://` is the scheme's own way of saying TLS, and carries no sslmode. */
test("rediss implies require", () => {
  expect(parseConnectionString("rediss://cache.example.com")?.patch.sslMode).toBe("require");
  expect(parseConnectionString("redis://cache.example.com")?.patch.sslMode).toBeUndefined();
});

test("a redis URL carries its credentials like any other", () => {
  const r = parseConnectionString("redis://app:s3cret@10.0.0.5:6380/1");
  expect(r?.patch).toMatchObject({ driver: "redis", host: "10.0.0.5", port: 6380, user: "app" });
  expect(r?.password).toBe("s3cret");
});

/**
 * Switching driver must not throw away what the user typed that still means the
 * same thing, nor keep what does not: a 5432 left on a Redis connection is a
 * port nothing answers on.
 */
test("switching driver moves the defaults and keeps the decisions", () => {
  const typed = { ...BLANK_CONNECTION, host: "10.0.0.5", environment: "production" };
  const redis = forDriver(typed, "redis");
  expect(redis.port).toBe(6379);
  expect(redis.database).toBe("");
  expect(redis.user).toBe("");
  // Where the server is does not change because of what is listening on it.
  expect(redis.host).toBe("10.0.0.5");
  expect(redis.environment).toBe("production");

  // A port someone typed is a decision, not a default to overwrite.
  const custom = forDriver({ ...BLANK_CONNECTION, port: 6543 }, "redis");
  expect(custom.port).toBe(6543);
});

/** An SSL mode the new driver does not offer would leave the select showing a
 *  value that is not in its own list. */
test("switching driver drops an SSL mode the new one does not offer", () => {
  const redis = forDriver({ ...BLANK_CONNECTION, sslMode: "verify-full" }, "redis");
  expect(redis.sslMode).toBe("disable");
  // One it does offer survives.
  expect(forDriver({ ...BLANK_CONNECTION, sslMode: "require" }, "redis").sslMode).toBe("require");
});

test("percent-decodes credentials", () => {
  const r = parseConnectionString("postgres://us%40er:p%40ss%2Fword@localhost/db");
  expect(r?.patch.user).toBe("us@er");
  expect(r?.password).toBe("p@ss/word");
});

test("leaves sslMode unset when the URL does not name a valid one", () => {
  expect(parseConnectionString("postgres://localhost/db?sslmode=banana")?.patch.sslMode).toBeUndefined();
});

test("rejects anything that is not a URL for a driver we have", () => {
  expect(parseConnectionString("mysql://localhost/db")).toBeNull();
  expect(parseConnectionString("not a url")).toBeNull();
});

test("moves a verifying SSL mode off a tunnelled connection, and leaves the rest alone", () => {
  // Through a tunnel the driver dials 127.0.0.1, which is never the name on
  // the certificate. Left alone, these two fail every connect with a message
  // about a bad certificate rather than about the tunnel.
  expect(sslModeThroughTunnel("verify-full")).toBe("require");
  expect(sslModeThroughTunnel("verify-ca")).toBe("require");

  // Everything else is still the user's choice, including turning SSL off:
  // SSH already encrypts the hop, and overriding that would be us deciding.
  expect(sslModeThroughTunnel("disable")).toBe("disable");
  expect(sslModeThroughTunnel("prefer")).toBe("prefer");
  expect(sslModeThroughTunnel("require")).toBe("require");
});

test("shortens a picked key path to ~ only when it really is under home", () => {
  expect(tildePath("/Users/ada/.ssh/id_ed25519", "/Users/ada")).toBe("~/.ssh/id_ed25519");
  // A trailing separator on the home path must not eat the one that follows it.
  expect(tildePath("/Users/ada/.ssh/id_ed25519", "/Users/ada/")).toBe("~/.ssh/id_ed25519");
  // A prefix match that is not a path boundary is a different user's home.
  expect(tildePath("/Users/adamson/keys/id_rsa", "/Users/ada")).toBe("/Users/adamson/keys/id_rsa");
  expect(tildePath("/etc/ssh/host_key", "/Users/ada")).toBe("/etc/ssh/host_key");
  expect(tildePath("/anything", "")).toBe("/anything");
});

/**
 * One database at a time per server.
 *
 * The failure this names is the quiet one: a sweep that reaches too far closes
 * the production replica the user was holding open in the other half of the
 * sidebar, or closes the server session that lists the databases and makes
 * going back cost a reconnect. Both look like the app losing a connection for
 * no reason, and neither shows up as an error.
 */
const conn = (id: string, parentId: string | null = null): ConnectionConfig => ({
  ...BLANK_CONNECTION,
  id,
  name: id,
  parentId,
});

const group = [
  conn("local"),
  conn("app", "local"),
  conn("archive", "local"),
  conn("prod"),
  conn("prod-app", "prod"),
];

test("switching database closes the sibling and leaves the server session", () => {
  const open = ["local", "app", "archive"];
  expect(siblingSessions(group, open, "app")).toEqual(["archive"]);
});

test("another server's databases are never swept", () => {
  const open = ["local", "app", "prod", "prod-app"];
  // Holding a local Postgres and a production replica open at once is the
  // point of the nesting, not an accident to clean up.
  expect(siblingSessions(group, open, "app")).toEqual([]);
});

test("focusing the server itself closes the databases picked off it", () => {
  const open = ["local", "app", "archive"];
  expect(siblingSessions(group, open, "local")).toEqual(["app", "archive"]);
});

test("a connection that is not in the list sweeps nothing", () => {
  expect(siblingSessions(group, ["local", "app"], "gone")).toEqual([]);
});
