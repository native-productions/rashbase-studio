import { expect, test } from "bun:test";
import { parseConnectionString, sslModeThroughTunnel, tildePath } from "@/lib/utils/connections";

test("parses a full connection string", () => {
  const r = parseConnectionString("postgresql://ada:s3cret@db.example.com:6543/shop?sslmode=require");
  expect(r?.patch).toEqual({
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
  expect(r?.patch).toEqual({ host: "localhost", port: 5432, user: "postgres", database: "postgres" });
  expect(r?.password).toBe("");
});

test("percent-decodes credentials", () => {
  const r = parseConnectionString("postgres://us%40er:p%40ss%2Fword@localhost/db");
  expect(r?.patch.user).toBe("us@er");
  expect(r?.password).toBe("p@ss/word");
});

test("leaves sslMode unset when the URL does not name a valid one", () => {
  expect(parseConnectionString("postgres://localhost/db?sslmode=banana")?.patch.sslMode).toBeUndefined();
});

test("rejects anything that is not a Postgres URL", () => {
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
