# Rashbase Studio

A free, AI-native database client. Tauri v2, React 19, Rust.

Source-available under the [PolyForm Noncommercial 1.0.0](LICENSE) licence: read
it, fork it, change it, use it for anything noncommercial. Commercial use — including
shipping it, or anything derived from it, as part of a product — is not granted.

See [PRODUCT.md](PRODUCT.md) for what this is and [DESIGN.md](DESIGN.md) for the
design system.

## Screenshots

Connections grouped by environment, schema on the left, editor on the right. The
env tag is the safety feature: a `PROD` connection never looks like a local one.

![Connection list and SQL editor](assets/screenshots/home-database.png)

A connection is a URL paste or a filled form, either way. Leaving the database
blank treats the connection as a server and lists every database the role can
open.

![New connection sheet](assets/screenshots/new-connection.png)

Table contents in the virtualized grid. Column types are stated in the header,
the footer carries the row count and the timings, and each open table is a tab.

![Table contents in the result grid](assets/screenshots/database-content.png)

Query results in the same grid. Results of a query are not editable, and the
panel says so rather than failing on save.

![Query results](assets/screenshots/database-query.png)

One row read in the side panel, every column at full width, JSONB expanded in
place.

![Row detail panel](assets/screenshots/data-viewer.png)

A JSONB cell opened on its own, as a tree or as raw text.

![JSON viewer](assets/screenshots/json-viewer.png)

## Database support

| Database | Status |
| --- | --- |
| PostgreSQL | Supported |

Not supported yet. Each needs a driver under `src-tauri/src/drivers/`; see
[Adding a database](#adding-a-database).

- MySQL / MariaDB
- SQLite
- Microsoft SQL Server
- CockroachDB
- ClickHouse
- DuckDB
- MongoDB
- Redis

Postgres-wire-compatible servers (Supabase, Neon, Timescale, Yugabyte) connect
through the PostgreSQL driver, but nothing specific to them is handled.

## Requirements

- [Bun](https://bun.sh)
- Rust stable
- Xcode Command Line Tools (macOS)

## Development

```sh
bun install
bun run tauri dev
```

## Build

```sh
bun run tauri build
```

## Tests

```sh
bun test                   # frontend, in src/__tests__/
cd src-tauri && cargo test # backend
```

The performance gate needs a real Postgres and is skipped without one:

```sh
cd src-tauri
RASHBASE_PG_PASSWORD=... cargo test --test perf_gate --release -- --nocapture
```

It seeds nothing. Create the fixture first:

```sql
create table perf_test (
  id bigserial primary key, uid uuid not null default gen_random_uuid(),
  email text not null, full_name text, score numeric(10,2),
  attempts integer not null, ratio double precision, is_active boolean not null,
  created_at timestamptz not null, expires_on date, payload jsonb, tags text[]
);
insert into perf_test (email, full_name, score, attempts, ratio, is_active, created_at, expires_on, payload, tags)
select 'user' || g || '@example.com',
       case when g % 17 = 0 then null else 'Person Number ' || g end,
       round((random() * 10000)::numeric, 2), (random() * 500)::int, random(),
       g % 3 = 0, now() - (g || ' minutes')::interval,
       case when g % 11 = 0 then null else (now() + (g || ' days')::interval)::date end,
       jsonb_build_object('n', g, 'bucket', g % 7),
       array['tag' || (g % 5), 'group' || (g % 3)]
from generate_series(1, 100000) g;
```

## Architecture

```
src/                     React 19 + TypeScript
  __tests__/             Every frontend test
  lib/types.ts           Every shape the app passes around
  lib/ipc.ts             Typed wrappers over the Tauri command surface
  lib/constants/         Lookup tables, class strings, shared metrics
  lib/utils/             Pure functions: SQL builders, filters, row identity
  lib/commands.ts        Command registry: one source for hotkeys and palette
  lib/hotkeys.ts         Single keydown listener resolving against the registry
  components/grid/       Virtualized result grid
  components/editor/     CodeMirror 6 SQL editor
  store/app.ts           Zustand state

src-tauri/src/
  commands/              IPC surface, split by concern
  drivers/
    mod.rs               Driver and Session traits, Capabilities
    types.rs             Wire types every driver speaks
    registry.rs          Driver registry and open sessions
    postgres/            The PostgreSQL driver
  ssh.rs                 SSH tunnel, with known_hosts enforcement
  keychain.rs            OS keystore wrapper
  error.rs               One serializable error shape
```

### Adding a database

A driver is a folder under `src-tauri/src/drivers/` implementing `Driver` and
`Session`, plus one line in `DbState::default`. Every catalogue method on
`Session` defaults to refusing, so a driver only implements what its server
actually has — a key-value store has no schemas, and saying so is a valid
answer rather than a gap. `Capabilities` is how a driver states which of them
it means to answer.

Connections carry a `driver` field naming which one opens them. It defaults to
`postgres` when absent, so a `connections.json` written before drivers existed
keeps loading.

### Two query paths

**Reads** run user SQL over Postgres' *simple query protocol*
(`sqlx::raw_sql`). Multi-statement scripts and session commands (`SET`,
`BEGIN`) work as typed, and every value arrives in text format, so arrays,
enums, jsonb, ranges, and user-defined types decode without a per-OID table.
Verified by `tests/perf_gate.rs`.

**Writes** (the generated `UPDATE` behind inline cell editing) use bound
parameters over the extended protocol. The simple protocol is never used to
interpolate user data.

Every parameter is bound as text and cast in the statement, so one code path
carries every column type: `cast(text as <type>)` runs that type's own input
function, and `returning` casts back to text so the grid shows what Postgres
stored rather than what was typed. The row is identified by the table's own
primary key, read from `pg_catalog` backend-side; the frontend cannot compose a
`where` clause. Verified by `tests/write_path.rs`.

### Editor results are bounded two ways

A query tab keeps 1000 rows by default (a table page keeps 200). How that bound
is reached depends on the statement, because rewriting SQL a person typed is
only safe some of the time.

**Wrapped, when it can be.** A single read-only `SELECT` or `WITH` that sets no
limit of its own is run as `select * from (<statement>) _ limit n offset m`, so
the footer gets a real pager. `unpageableReason` in `lib/utils/statement.ts`
decides, working on a copy of the SQL with comments and literals masked out, and
refuses on anything it is not sure about — a script, a write (including a
data-modifying CTE, where paging would re-run the `DELETE` on every click), a
statement with its own `LIMIT`, `FOR UPDATE`, or `SELECT INTO`.

**Capped, otherwise.** The statement runs exactly as typed and the backend stops
keeping rows past `maxRows`. Rows past the cap are still read off the socket —
the stream has to reach `CommandComplete` for the connection to stay usable, and
that tag carries the true row count — but nothing is allocated for them. The
result reports `truncated`, and `rowsAffected` still says what the statement
really produced, so the footer reads "1,000 of 38,412" rather than pretending
there were 1,000.

The editor's own text is never rewritten either way.

### One connection per session, not a pool

`SET`, `BEGIN`, temp tables, and `search_path` must survive between statements
in the same tab. A pool would hand out a different backend each time and break
all of it silently.

### Credentials

Stored via the `keyring` crate: macOS Keychain, Windows Credential Manager,
Linux Secret Service. One API, no per-platform branching. Passwords never
travel back to the webview; the frontend holds a connection id and the backend
resolves the secret.

## Status

Connect, browse schema, run queries, read results, filter and sort a table,
read one row in the side panel, and edit cells inline.

A connection that names no database is treated as a server: the sidebar lists
the databases the role can open, and picking one derives a connection named
after it, nested under the server and authenticating with the server's stored
credential. ⌘⇧K reaches the same picker from any open connection.

SSH tunnelling works: a connection can dial through a jump host, authenticating
with a key or a password. Unknown host keys are refused rather than trusted on
first use.

Not built yet: insert and delete rows, query history, export, and AI. For
databases, see [Database support](#database-support).

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Permitted: personal use, study, hobby
projects, research, and use by nonprofits, schools, and government. Not
permitted: any commercial purpose, which includes selling it, running it as part
of a paid product or service, and forking it into a commercial product.

This is source-available, not open source: it does not meet the OSI definition,
because the noncommercial restriction discriminates against a field of use.

For a commercial licence, open an issue.
