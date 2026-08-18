# Rashbase Studio

A free, AI-native database client. Tauri v2, React 19, Rust.

Source-available under the [PolyForm Noncommercial 1.0.0](LICENSE) licence: read
it, fork it, change it, use it for anything noncommercial. Commercial use — including
shipping it, or anything derived from it, as part of a product — is not granted.

See [PRODUCT.md](PRODUCT.md) for what this is and [DESIGN.md](DESIGN.md) for the
design system.

## Screenshots

<table>
  <tr>
    <td colspan="2" align="center">
      <img src="assets/screenshots/home-database.png" alt="Connection list and SQL editor" width="100%">
      <br>
      <sub><b>Connections and editor.</b> Grouped by environment, so a <code>PROD</code> connection never looks like a local one.</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="assets/screenshots/database-content.png" alt="Table contents in the result grid" width="100%">
      <br>
      <sub><b>Result grid.</b> Virtualized, column types in the header, row count and timings in the footer.</sub>
    </td>
    <td align="center" width="50%">
      <img src="assets/screenshots/database-query.png" alt="Query results" width="100%">
      <br>
      <sub><b>Query results.</b> Same grid, but not editable — the panel says so rather than failing on save.</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="assets/screenshots/new-connection.png" alt="New connection sheet" width="100%">
      <br>
      <sub><b>New connection.</b> Paste a URL or fill the form. A blank database lists every one the role can open.</sub>
    </td>
    <td align="center" width="50%">
      <img src="assets/screenshots/data-viewer.png" alt="Row detail panel" width="100%">
      <br>
      <sub><b>Row detail.</b> One row at full width, JSONB expanded in place.</sub>
    </td>
  </tr>
  <tr>
    <td colspan="2" align="center">
      <img src="assets/screenshots/json-viewer.png" alt="JSON viewer" width="100%">
      <br>
      <sub><b>JSON viewer.</b> A JSONB cell on its own, as a tree or as raw text.</sub>
    </td>
  </tr>
</table>

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

## Install

Prebuilt installers for every tagged release are on the
[releases page](https://github.com/native-productions/rashbase-studio/releases).
The scripts below pick the right artifact for your platform and install it.

**macOS and Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/native-productions/rashbase-studio/main/scripts/install.sh | bash
```

macOS gets the `.dmg` for your architecture copied into `/Applications`. Linux
gets the `.deb` or `.rpm` if your distro uses one, and the `.AppImage`
otherwise.

**Windows**

```powershell
irm https://raw.githubusercontent.com/native-productions/rashbase-studio/main/scripts/install.ps1 | iex
```

Runs the NSIS installer. Pass `-Installer msi` to the script for the MSI
instead.

### These builds are not signed

There is no Apple Developer or Windows code-signing certificate yet, so both
operating systems warn you the first time you open the app. The install scripts
above handle macOS for you. If you downloaded an installer by hand instead:

- **macOS** quarantines the app and refuses to launch it ("damaged and can't be
  opened"). Clear the flag once, after moving the app into `/Applications`:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Rashbase Studio.app"
  ```

- **Windows** shows a SmartScreen prompt ("Windows protected your PC"). Click
  **More info**, then **Run anyway**.

- **Linux** does not warn; there is nothing to do.

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

## Releasing

```sh
./scripts/release.sh 0.2.0                  # all platforms
./scripts/release.sh 0.2.0 linux,windows    # only those two
./scripts/release.sh 0.2.0 macos --dry-run  # show the bump, change nothing
```

Platforms are `macos` (builds both Apple Silicon and Intel), `windows`, and
`linux`; the default is all three.

The script bumps the version in `package.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml`, pushes a `v0.2.0` tag, then triggers the
[release workflow](.github/workflows/release.yml) with `gh workflow run`. The
workflow builds the selected platforms and attaches the artifacts to a **draft**
release. Review the draft on GitHub, then publish it.

Requires the [GitHub CLI](https://cli.github.com) to be installed and
authenticated. The workflow is dispatch-only — pushing a tag by hand does not
build anything, because a push trigger would fire a second, unfiltered build for
the same tag.

If one platform fails, re-run just that leg against the tag that already exists.
`release.sh` refuses to reuse a tag, so dispatch the workflow directly; the new
artifacts are added to the same draft release:

```sh
gh workflow run release.yml -f tag=v0.2.0 -f platforms=windows
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
