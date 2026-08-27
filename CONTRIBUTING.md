# Contributing

Thanks for looking. This file has everything needed to get the app running,
change it, and open a pull request that can be merged without a round trip.

Read [PRODUCT.md](PRODUCT.md) before proposing a feature and
[DESIGN.md](DESIGN.md) before changing anything visual. They state what this
tool is for and what it looks like, and a change that argues with either of them
is a discussion, not a patch.

## Getting set up

```sh
bun install
bun run app                # the full app, as a development build
bun run dev                # frontend only, port 1420
bun run build              # tsc --noEmit && vite build
```

Requirements: [Bun](https://bun.sh), Rust stable, and Xcode Command Line Tools
on macOS.

`bun run build` is the type gate. It must pass before a change is done —
`tsc` runs strict, with `noUnusedLocals`, `noUnusedParameters`,
`noUncheckedIndexedAccess` and `noFallthroughCasesInSwitch` on. There is no
linter or formatter configured; match the file you are editing.

## Layout

```
src/
  lib/types.ts        Every shape the app passes around
  lib/ipc.ts          Typed wrappers over the Tauri command surface
  lib/commands.ts     Command registry: one source for hotkeys, palette, menu
  lib/hotkeys.ts      Single keydown listener resolving against the registry
  lib/prefs.ts        Theme, text size, tab behaviour — localStorage
  lib/security.ts     Touch ID: platform support and the read-only mirror
  lib/constants/      Lookup tables, class strings, shared metrics
  lib/utils/          Pure functions: SQL builders, filters, row identity
  lib/utils/redis.ts  A key page as a QueryResult, so the grid needs no changes
  store/app.ts        Zustand state, and where IPC calls are made from
  components/         UI, grouped by surface
  styles/theme.css    Tailwind v4 @theme block — the design token source
  __tests__/          Every frontend test

src-tauri/src/
  commands/           IPC surface, split by concern
  drivers/mod.rs      Driver and Session traits, Capabilities
  drivers/types.rs    Wire types every driver speaks
  drivers/registry.rs Driver registry and open sessions
  drivers/postgres/   PostgreSQL driver
  drivers/redis/      Redis driver: keyspace walk, console, writes
  drivers/redis/bull.rs  BullMQ, read as a lens over that keyspace
  drivers/redis/lua/  BullMQ's own scripts, vendored verbatim
  ssh.rs              SSH tunnel, known_hosts enforced
  keychain.rs         OS keystore wrapper
  biometric.rs        Touch ID via LocalAuthentication, macOS only
  error.rs            One serializable error shape
```

Imports use the `@/` alias for `src/`. Adding a Tauri command means touching
both `src-tauri/src/lib.rs` and `src/lib/ipc.ts`.

## Invariants

Break one of these and the change is wrong regardless of whether it compiles.

1. **AI never executes.** Generated or AI-authored statements are shown to a
   human and approved before they run. There is no auto-execute path, and there
   will not be one.
2. **Destructive intent is never guessed.** A generated write is visible before
   it runs. Staged Redis deletions and the pending `UPDATE` preview are the two
   existing shapes of that bargain — follow one rather than inventing a third.
3. **Credentials never reach the webview.** Passwords live in the OS keystore
   via `keychain.rs`. The frontend holds a connection id; the backend resolves
   the secret.
4. **User data is never interpolated into SQL.** Writes bind parameters over the
   extended protocol. The simple protocol carries user-typed SQL only, and the
   frontend never composes a `where` clause — row identity comes from the
   table's own primary key, read backend-side.

Two smaller rules that come up often:

- **Honest performance and honest counts.** If a number could not be measured,
  it reads as absent, not as zero. If a filter walked 609 keys to match one, the
  footer says so.
- **One registry for shortcuts.** A hotkey is registered once in
  `lib/commands.ts` so the palette can never advertise a binding that does not
  work.

## Tests

```sh
bun test                    # frontend, src/__tests__/
cd src-tauri && cargo test  # backend
```

Three backend suites need a real server and skip without one.

### Redis: `redis_keyspace` and `bull_retry`

`redis_keyspace` checks that the cursor walk visits every key exactly once, that
a value search matching nothing stops on its budget and reports honestly, that
writes read back, and that a key whose name holds a space survives being
deleted. It begins with `FLUSHDB`, so point it at a database you do not mind
losing, and run it single-threaded — its cases share one database. It refuses to
run against a database holding any key it did not write, so pointing
`RASHBASE_REDIS_DB` (default `9`) at real data fails loudly instead of
destroying it; `RASHBASE_REDIS_FORCE=1` says it on purpose.

`bull_retry` checks that a retry does what BullMQ's own retry does: the failed
reason cleared, the marker set so a blocked worker wakes, a second retry of the
same job refused rather than queued twice, `attemptsMade` kept unless the reset
was asked for, `lifo` putting the job on the end that runs next, and a job
belonging to a flow put back among its parent's dependencies. It flushes
nothing, and takes its own database only to stay clear of the other suite's
`FLUSHDB`.

```sh
docker run -d -p 6379:6379 redis:7
cd src-tauri

RASHBASE_REDIS_HOST=127.0.0.1 RASHBASE_REDIS_DB=12 \
  cargo test --test redis_keyspace -- --test-threads=1 --nocapture

RASHBASE_REDIS_HOST=127.0.0.1 RASHBASE_REDIS_BULL_DB=10 \
  cargo test --test bull_retry -- --nocapture
```

### Postgres: `perf_gate`

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

## Adding a database

The most useful contribution this project can take. A driver is a folder under
`src-tauri/src/drivers/` implementing `Driver` and `Session`, plus one line in
`DbState::default`.

Every catalogue method on `Session` defaults to refusing, so a driver only
implements what its server actually has — a key-value store has no schemas, and
saying so is a valid answer rather than a gap. `Capabilities` is how a driver
states which of them it means to answer, and the UI reads that rather than
branching on a driver name.

Connections carry a `driver` field naming which one opens them. It defaults to
`postgres` when absent, so a `connections.json` written before drivers existed
keeps loading. Keep that true.

The Redis driver is the reference for a non-relational store: a key page is
converted into the `QueryResult` the grid already draws, so the grid, the row
panel, the JSON tree and the virtualizer needed no second implementation. Aim
for the same — new surfaces are the last resort, not the first move.

### Two query paths

**Reads** run user SQL over Postgres' *simple query protocol*
(`sqlx::raw_sql`). Multi-statement scripts and session commands (`SET`, `BEGIN`)
work as typed, and every value arrives in text format, so arrays, enums, jsonb,
ranges and user-defined types decode without a per-OID table.

**Writes** — the generated `UPDATE` behind inline cell editing — use bound
parameters over the extended protocol. The simple protocol is never used to
interpolate user data. A new driver keeps this split.

## Pull requests

- Open an issue first for anything larger than a fix. A driver, a new surface or
  a change to one of the invariants is worth agreeing on before it is written.
- One concern per pull request. A driver and a grid refactor are two.
- `bun run build`, `bun test` and `cargo test` pass.
- Describe the change the way [CHANGELOG.md](CHANGELOG.md) does: what is
  different for someone using the app, not which files moved.
- Screenshots for anything visual, in both themes if the change touches colour.
- Do not bump versions. Releases go through `./scripts/release.sh`, which bumps
  `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`
  together, and only a maintainer runs it.

Commit subjects are short and in the imperative — `redis support`,
`foreign key direction`, `exporting data & table structure`. Match that.

## Reporting a bug

Include the platform, the app version, the database and its version, and the
exact error text the app showed. Error messages carry the database's own words
and the position it blamed; paste them as they appear rather than paraphrasing.

For anything touching credentials, the keystore, SSH or Touch ID, report it
privately to the maintainer rather than opening a public issue.

## Licence of contributions

The project is [PolyForm Noncommercial 1.0.0](LICENSE). By opening a pull
request you agree your contribution is licensed on those terms.
