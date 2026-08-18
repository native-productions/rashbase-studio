import type { SidebarMember } from "@/lib/constants/sidebar";

/**
 * Server-wide things worth looking at, and where Postgres keeps them.
 *
 * Every one of these is an ordinary relation in `pg_catalog`, so opening one
 * needs nothing the app does not already do for a table: it becomes a tab with
 * the same grid, paging, sorting, and filtering. They are listed as `other`
 * rather than `table` so no cell in the system catalogue is ever writable —
 * this is a window onto the server, not a way to edit it.
 *
 * Cluster-wide unless noted: extensions are per database, and are here because
 * "what is installed" is the same question the rest of this list answers.
 */
export const CLUSTER_OBJECTS: (SidebarMember & { label: string })[] = [
  { label: "Roles", name: "pg_roles", kind: "other" },
  { label: "Users", name: "pg_user", kind: "other" },
  { label: "Databases", name: "pg_database", kind: "other" },
  { label: "Tablespaces", name: "pg_tablespace", kind: "other" },
  { label: "Settings", name: "pg_settings", kind: "other" },
  { label: "Activity", name: "pg_stat_activity", kind: "other" },
  { label: "Locks", name: "pg_locks", kind: "other" },
  { label: "Extensions", name: "pg_extension", kind: "other" },
  { label: "Replication slots", name: "pg_replication_slots", kind: "other" },
];

export const CLUSTER_SCHEMA = "pg_catalog";
