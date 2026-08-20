/**
 * The IPC surface, and nothing else.
 *
 * One wrapper per backend command, so the command names and argument shapes
 * live in one file rather than being spelled out at each call site. The types
 * these return are in `@/lib/types`; the helpers that work on them are in
 * `@/lib/utils`.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  ColumnInfo,
  EventPage,
  ConnectionConfig,
  ConnectionInfo,
  ExportFormat,
  ExportLayout,
  ExportRequest,
  ExportSummary,
  FunctionEntry,
  IndexInfo,
  JobPage,
  KeyFilter,
  KeyPage,
  QueueEntry,
  QueuePage,
  QueryResult,
  RetryOutcome,
  RetryRequest,
  RowCount,
  RowKey,
  SchemaEntry,
  SchemaGraph,
  TableEntry,
} from "@/lib/types";

export const ipc = {
  listConnections: () => invoke<ConnectionConfig[]>("list_connections"),

  /**
   * `undefined` for either secret means "leave the stored one alone"; the
   * empty string means "forget it". Neither ever comes back out.
   */
  saveConnection: (config: ConnectionConfig, password?: string, sshSecret?: string) =>
    invoke<ConnectionConfig[]>("save_connection", {
      config,
      password: password ?? null,
      sshSecret: sshSecret ?? null,
    }),

  deleteConnection: (id: string) => invoke<ConnectionConfig[]>("delete_connection", { id }),

  /**
   * Both secrets are resolved from the keystore backend-side. They are only
   * passed here when testing credentials that have not been saved yet.
   */
  connect: (config: ConnectionConfig, password?: string, sshSecret?: string) =>
    invoke<ConnectionInfo>("connect", {
      config,
      password: password ?? null,
      sshSecret: sshSecret ?? null,
    }),

  disconnect: (id: string) => invoke<void>("disconnect", { id }),

  openConnectionIds: () => invoke<string[]>("open_connection_ids"),

  /**
   * Runs `sql` as given. `maxRows` caps what comes back to the window, not what
   * the server runs: a capped result says `truncated` and still reports the
   * statement's real row count in `rowsAffected`.
   */
  executeQuery: (id: string, sql: string, maxRows?: number) =>
    invoke<QueryResult[]>("execute_query", { id, sql, maxRows: maxRows ?? null }),

  cancelQuery: (id: string) => invoke<void>("cancel_query", { id }),

  /**
   * Writes one cell and returns what Postgres stored.
   *
   * `value: null` is SQL NULL, not the empty string. `keys` must name the
   * table's primary key; the backend rejects anything else rather than trust a
   * `where` clause composed here.
   */
  updateCell: (
    id: string,
    schema: string,
    table: string,
    column: string,
    value: string | null,
    keys: RowKey[],
  ) => invoke<string | null>("update_cell", { id, schema, table, column, value, keys }),

  /**
   * Removes whole rows and answers with how many went.
   *
   * Each row is named by its primary key, the same identity the cell write
   * uses. The `where` clause is built backend side from the catalogue; this
   * says which rows, never how they are found.
   */
  deleteRows: (id: string, schema: string, table: string, rows: RowKey[][]) =>
    invoke<number>("delete_rows", { id, schema, table, rows }),

  /**
   * Dumps the named relations into `directory`.
   *
   * `jobId` is made here rather than returned, so Stop has something to name
   * before this promise settles. Progress arrives as `export://progress`
   * events carrying the same id; a dump of a large table runs for minutes.
   */
  exportObjects: (id: string, jobId: string, req: ExportRequest) =>
    invoke<ExportSummary>("export_objects", { id, jobId, req }),

  cancelExport: (jobId: string) => invoke<void>("cancel_export", { jobId }),

  /**
   * Whether these settings would replace something already on disk. Asked of
   * the backend because the backend is what decides the final file name.
   */
  exportTargetExists: (
    directory: string,
    fileName: string,
    format: ExportFormat,
    layout: ExportLayout,
    compress: boolean,
  ) =>
    invoke<boolean>("export_target_exists", {
      directory,
      fileName,
      format,
      layout,
      compress,
    }),

  /** Databases on this session's server the connected role can actually open. */
  listDatabases: (id: string) => invoke<string[]>("list_databases", { id }),

  listSchemas: (id: string) => invoke<SchemaEntry[]>("list_schemas", { id }),

  listTables: (id: string, schema: string) => invoke<TableEntry[]>("list_tables", { id, schema }),

  estimateRows: (id: string, schema: string, table: string) =>
    invoke<RowCount>("estimate_rows", { id, schema, table }),

  countRows: (id: string, schema: string, table: string) =>
    invoke<RowCount>("count_rows", { id, schema, table }),

  listColumns: (id: string, schema: string, table: string) =>
    invoke<ColumnInfo[]>("list_columns", { id, schema, table }),

  listIndexes: (id: string, schema: string, table: string) =>
    invoke<IndexInfo[]>("list_indexes", { id, schema, table }),

  /**
   * Every relation in the schema with its columns, plus the foreign keys
   * between them. One call rather than `listColumns` per relation: eighty
   * tables would be eighty round trips serialized behind the session's lock,
   * to draw a single view.
   */
  schemaGraph: (id: string, schema: string) =>
    invoke<SchemaGraph>("schema_graph", { id, schema }),

  listFunctions: (id: string, schema: string) =>
    invoke<FunctionEntry[]>("list_functions", { id, schema }),

  functionDefinition: (id: string, oid: number) =>
    invoke<string>("function_definition", { id, oid }),

  viewDefinition: (id: string, schema: string, name: string) =>
    invoke<string>("view_definition", { id, schema, name }),

  /**
   * One page of a keyspace walk.
   *
   * `cursor` is opaque and comes from the previous page; `0` starts. The reply
   * says where to resume and what the page cost — a value filter is answered by
   * reading, so a page of 12 keys can be a walk of 50,000, and the footer shows
   * both rather than implying the whole namespace was read.
   */
  listKeys: (id: string, filter: KeyFilter, cursor: number, limit: number) =>
    invoke<KeyPage>("list_keys", { id, filter, cursor, limit }),

  /**
   * Removes keys and returns how many existed.
   *
   * Names travel as arguments, never spliced into a command: a key is arbitrary
   * bytes and one holding a space would break anything built by pasting names
   * together.
   */
  deleteKeys: (id: string, keys: string[]) =>
    invoke<number>("delete_keys", { id, keys }),

  // -- BullMQ ---------------------------------------------------------------
  //
  // Redis-only; every other connection answers that it does not support them.
  // `prefix` travels on every call rather than being remembered per session:
  // it belongs to the application that wrote the keys, and one Redis instance
  // can hold queues from more than one.

  listQueues: (id: string, prefix: string, cursor: number, limit: number) =>
    invoke<QueuePage>("list_queues", { id, prefix, cursor, limit }),

  /** One queue's counts, without the discovery walk. What a live tab polls. */
  queueCounts: (id: string, prefix: string, queue: string) =>
    invoke<QueueEntry>("queue_counts", { id, prefix, queue }),

  listJobs: (
    id: string,
    prefix: string,
    queue: string,
    state: string,
    offset: number,
    limit: number,
  ) => invoke<JobPage>("list_jobs", { id, prefix, queue, state, offset, limit }),

  /** `after` is the previous page's `lastId`; absent starts from the recent
   *  end rather than from the beginning of a ten-thousand entry stream. */
  queueEvents: (id: string, prefix: string, queue: string, after: string | null, limit: number) =>
    invoke<EventPage>("queue_events", { id, prefix, queue, after, limit }),

  /**
   * Moves finished jobs back into `wait`, running BullMQ's own script.
   *
   * Reports each job separately: a batch where some ids were already retried
   * elsewhere is a partial result rather than a failure.
   */
  retryJobs: (id: string, req: RetryRequest) =>
    invoke<RetryOutcome[]>("retry_jobs", { id, req }),
};
