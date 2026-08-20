# AGENTS.md

Instructions for AI agents working in this repository. Human-facing docs are
[README.md](README.md) (what exists and how it works), [PRODUCT.md](PRODUCT.md)
(why it exists), and [DESIGN.md](DESIGN.md) (the design system). Read the
relevant one before changing the surface it covers; this file does not repeat
them.

## What this is

Rashbase Studio — a free, AI-native database client for macOS, Windows and
Linux. Tauri v2 shell, React 19 + TypeScript frontend, Rust backend. PostgreSQL
and Redis drivers ship today. Source-available under PolyForm Noncommercial
1.0.0.

The goal is TablePlus' keyboard density and craft at no cost, with the schema
treated as something the tool reasons about rather than a panel bolted to the
side. The user is one developer who lives in a database client for hours and
switches between a local Docker Postgres and a production replica in the same
session — telling those two apart at a glance is a safety feature.

## Commands

```sh
bun install
bun run tauri dev          # full app
bun run dev                # frontend only, port 1420
bun run build              # tsc --noEmit && vite build
bun test                   # frontend tests, src/__tests__/
cd src-tauri && cargo test  # backend tests
```

There is no linter or formatter configured. `tsc` is strict, with
`noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess` and
`noFallthroughCasesInSwitch` on; `bun run build` is the type gate and must pass
before anything is called done.

Three backend suites need a real server and skip without one — a Redis instance
for `redis_keyspace.rs` and `bull_retry.rs`, and a seeded Postgres for
`perf_gate.rs`. Setup for all three is in README's Tests section. The two Redis
suites take different databases on purpose: `redis_keyspace.rs` begins with
`FLUSHDB` and needs `--test-threads=1`, and `bull_retry.rs` flushes nothing.

Releases go through `./scripts/release.sh <version>`, which bumps
`package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` together
and dispatches the release workflow. Do not bump those three by hand and do not
run it without being asked.

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
  drivers/redis/bull.rs   BullMQ, read as a lens over that keyspace
  drivers/redis/lua/  BullMQ's own scripts, vendored verbatim
  ssh.rs              SSH tunnel, known_hosts enforced
  keychain.rs         OS keystore wrapper
  biometric.rs        Touch ID via LocalAuthentication, macOS only
  error.rs            One serializable error shape
```

Imports use the `@/` alias for `src/`. Tauri commands are registered in
`src-tauri/src/lib.rs`; adding one means touching that list and `src/lib/ipc.ts`.

## Invariants

Break these and the change is wrong regardless of whether it compiles.

1. **AI never executes.** Generated or AI-authored statements are shown to a
   human and approved before they run. No auto-execute path, ever.
2. **Destructive intent is never guessed.** A generated write is visible before
   it runs. Staged Redis deletions and the pending `UPDATE` preview are the two
   existing shapes of that bargain; follow one of them rather than inventing a
   third.
3. **Credentials never reach the webview.** Passwords live in the OS keystore
   via `keychain.rs`. The frontend holds a connection id; the backend resolves
   the secret.
4. **User data is never interpolated into SQL.** Writes bind parameters over the
   extended protocol. The simple protocol carries user-typed SQL only, and the
   frontend never composes a `where` clause — row identity comes from the
   table's own primary key read backend-side.
5. **Redis keys travel as arguments.** A key is arbitrary bytes; anything built
   by joining names into a command string breaks on a key holding a space.
6. **One connection per session, not a pool.** `SET`, `BEGIN`, temp tables and
   `search_path` have to survive between statements in a tab.
7. **Errors keep the database's own words.** Message, code, detail, hint and
   position cross IPC as one flat shape. Never paraphrase or soften what the
   server said.
8. **Honest reporting.** Row counts, scan counts and timings state what actually
   happened — `12 keys · scanned 50,000`, `1,000 of 38,412`. A bound that was
   hit is reported as a bound, not hidden behind a number that looks complete.
9. **A keybinding is registered exactly once**, in `lib/commands.ts`. The
   palette, the keyboard layer and the macOS menu all read that list, so a
   shortcut can never be advertised that does not work.
10. **A vendored script says where it came from and what to re-check.**
    `drivers/redis/lua/reprocess_job.lua` is BullMQ's own, flattened. Its header
    names the upstream files and the one thing that will not fail loudly on an
    upgrade: the KEYS order is positional and nothing complains when it drifts.
11. **A preference that gates a secret is enforced backend-side, in front of
    the read.** Appearance and layout live in `localStorage` (`lib/prefs.ts`,
    `translucency.ts`, `pinnedTabs.ts`, `erdPrefs.ts`) because nothing on the
    Rust side needs them. The Touch ID policy does not: it lives in
    `security.json` and on `ConnectionConfig.require_biometric`, and the gate
    runs in `session::connect` *before* the keystore lookup. A gate the webview
    drew is a gate a compromised webview skips, and a refusal has to mean the
    secret was never read rather than read and then not used.
12. **A rate is measured or it is absent.** Never zero for "we could not tell".
    The queue diagram reads transitions off the event stream and reports `null`
    when that stream was trimmed past the resume point, because a rate derived
    from a gapped window is a number that looks like a measurement.

## Conventions

**Comments explain the decision, not the code.** This codebase's comments say
why a thing is the way it is and what breaks if it changes — the `!important` in
the editor theme, the dispatch-only release workflow, the refusing defaults on
`Session`. Match that. Do not add comments that restate the line below them, and
do not delete an existing one as tidying without understanding what it is
holding down.

**Prose is direct and quiet**, in docs and in UI copy alike. No celebration, no
encouragement, no marketing voice. State facts.

**No cards, no nested containers.** Panels are separated by 1px lines. Nothing
is wrapped in a container unless the container does something.

**Colour comes from `styles/theme.css`.** Never write a raw colour in a
component. Two palettes share one set of names: `@theme` declares
`--color-*` as references to `--t-*`, and the `[data-theme]` blocks hold the
values, so a palette can be applied to any element rather than only `:root`.
Anything filled with the accent takes `bg-accent-fill` and `text-on-accent`,
not `bg-accent` and `text-canvas` — on light those are two different yellows
and near-white text on one of them. The accent covers under 10% of surface area and appears on exactly
five things (active tab, focus ring, selected cell, primary button, SQL
keywords).

**Motion is decided by frequency.** Anything done hundreds of times a day gets
none. Only `transform`, `opacity` and `filter` animate; never `ease-in`, never
`transition: all`. Exit is faster than entry.

**The grid and the editor never take part in translucency.** They paint
`--color-canvas`, which has no alpha. Legibility of a dense scan surface may not
depend on the user's wallpaper.

**Backend additions go behind the driver seam.** A new database is a folder
under `src-tauri/src/drivers/` implementing `Driver` and `Session`, plus one
line in `DbState::default`. Every catalogue method defaults to refusing, so
implement only what the server actually has and declare it in `Capabilities`.
Do not widen the traits to fit one driver.

A feature belonging to one driver's *ecosystem* rather than to databases is not
a catalogue method at all. BullMQ is the case: it is a key layout one Node
library writes into Redis, so its commands are inherent methods on
`RedisSession`, reached through `Session::as_any` and a downcast in the
registry. That is the escape hatch, and it is deliberately one method rather
than a family — `retry_jobs` on the trait Postgres also implements would be a
method about a JavaScript queue in the vtable of every database, forever.

**Frontend code should not learn a driver's vocabulary.** `keyPageToResult` in
`lib/utils/redis.ts` turns a page of Redis keys into the `QueryResult` the grid
already draws, which is why the grid, row panel, JSON viewer and virtualizer
needed no changes. Convert at the seam; do not branch downstream of it.

## Testing

Frontend tests are `bun:test`, colocated in `src/__tests__/`, and cover pure
logic in `lib/utils/` — the layers where a mistake is silent rather than loud.
Backend integration tests are in `src-tauri/tests/`.

Non-trivial logic gets a test. A silent failure mode (a filter that quietly
matches nothing, a column that shifts by one, a paging rewrite that changes what
a statement means) gets a test naming that failure mode in the file header, the
way the existing suites do.

## Scope

`README.md` Status names what is built and what is not. Do not implement the
unbuilt items unless asked. Do not add dependencies for what a few lines solve —
the dependency list is short on purpose, and every entry in `Cargo.toml` carries
a comment explaining why it is there.
