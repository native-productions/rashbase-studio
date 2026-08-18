/**
 * Switching database derives a connection, and deriving the same one twice is
 * the failure that leaves a sidebar full of entries nobody can tell apart.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import type { ConnectionConfig } from "@/lib/types";

const calls: { name: string; args: Record<string, unknown> }[] = [];

/** What `delete_connection` reports as still existing. Set per test. */
let remaining: unknown[] = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    switch (name) {
      case "connect":
        return Promise.resolve({
          id: "",
          serverVersion: "PostgreSQL 16.2",
          backendPid: 1,
          currentDatabase: "",
        });
      case "delete_connection":
        return Promise.resolve(remaining);
      default:
        return Promise.resolve([]);
    }
  },
}));

const { useApp } = await import("@/store/app");

const server: ConnectionConfig = {
  id: "server",
  driver: "postgres",
  name: "localhost",
  host: "localhost",
  port: 5432,
  user: "postgres",
  database: "",
  sslMode: "prefer",
  environment: "production",
  parentId: null,
};

const saved = () => calls.filter((c) => c.name === "save_connection");
const connected = () => calls.filter((c) => c.name === "connect");

beforeEach(() => {
  calls.length = 0;
  remaining = [];
  useApp.setState({
    connections: [server],
    open: {},
    databases: {},
    schemas: {},
    tabs: [],
    activeTabId: null,
  });
});

test("picking a database derives a connection named after it", async () => {
  await useApp.getState().openDatabase("server", "myapp");

  const config = saved()[0]?.args.config as ConnectionConfig;
  expect(config.name).toBe("myapp");
  expect(config.database).toBe("myapp");
  // The credential stays on the server, and the tint comes with it.
  expect(config.parentId).toBe("server");
  expect(config.environment).toBe("production");
  // A database picked off a server is opened by the same driver as the server.
  expect(config.driver).toBe("postgres");
  expect(saved()[0]?.args.password).toBeNull();
  expect(connected()).toHaveLength(1);
});

test("a database that already has a connection is reused, not duplicated", async () => {
  const existing: ConnectionConfig = { ...server, id: "child", name: "myapp", database: "myapp", parentId: "server" };
  useApp.setState({ connections: [server, existing] });

  await useApp.getState().openDatabase("server", "myapp");

  expect(saved()).toHaveLength(0);
  expect((connected()[0]?.args.config as ConnectionConfig).id).toBe("child");
});

test("deleting a server forgets the sessions and tabs of its databases too", async () => {
  const child: ConnectionConfig = { ...server, id: "child", name: "myapp", database: "myapp", parentId: "server" };
  const other: ConnectionConfig = { ...server, id: "other", name: "elsewhere", parentId: null };
  useApp.setState({
    connections: [server, child, other],
    open: {
      server: { id: "server", serverVersion: "", backendPid: 1, currentDatabase: "postgres" },
      child: { id: "child", serverVersion: "", backendPid: 2, currentDatabase: "myapp" },
      other: { id: "other", serverVersion: "", backendPid: 3, currentDatabase: "postgres" },
    },
    databases: { server: ["myapp"] },
    schemas: { child: [{ name: "public" }] },
    tables: { "child::public": [] },
    activeConnectionId: "child",
  });
  useApp.getState().openTab("child");
  useApp.getState().openTab("other");

  // The backend takes the children with the parent, so the returned list is
  // what decides who is gone.
  remaining = [other];
  await useApp.getState().deleteConnection("server");

  const s = useApp.getState();
  expect(Object.keys(s.open)).toEqual(["other"]);
  expect(s.databases).toEqual({});
  expect(s.schemas).toEqual({});
  expect(s.tables).toEqual({});
  expect(s.tabs.map((t) => t.connectionId)).toEqual(["other"]);
  expect(s.activeTabId).toBe(s.tabs[0]!.id);
  expect(s.activeConnectionId).toBeNull();
});

test("a database derived from a derived connection points back at the server", async () => {
  const child: ConnectionConfig = { ...server, id: "child", name: "myapp", database: "myapp", parentId: "server" };
  useApp.setState({ connections: [server, child] });

  await useApp.getState().openDatabase("child", "other");

  expect((saved()[0]?.args.config as ConnectionConfig).parentId).toBe("server");
});
