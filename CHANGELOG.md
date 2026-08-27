# Changelog

What changed for someone using the app. The commit history is the record of
how; this is the record of what.

Releases before 0.3.0 are on the
[releases page](https://github.com/native-productions/rashbase-studio/releases).

## 0.4.0

### `⌘R` refreshes the tree as well as the result

It re-reads the connection list, the active connection's databases where the
sidebar lists them, its schemas, and the contents of the schemas that are open.
Until now the tree was read once when a connection opened, so a table created by
a migration in another window was invisible until the session was closed and
opened again.

Scoped to what is drawn: databases only where they are listed, and only the
schemas that are expanded. The result set still re-runs, so the two halves of
the window cannot end up disagreeing about what exists.

### Import from a `.sql` file

`⌘⇧I`, the connection's context menu, or a `.sql` file dropped on the window.
The file is read and counted first — how many statements of each kind, which
relations in the order the file names them, whether an ORM wrote it — without
opening a connection or running anything.

Four things it does that a plain `psql -f` does not, each a switch with the
reason it exists written under it:

- **Holds foreign keys until the end.** A dump written table by table puts a
  child row on the wire before its parent, and the key refuses it even though
  the file read to the end is consistent. Held with
  `session_replication_role` where the server allows it and by deferring each
  key where it does not; the summary says which, because the server decides.
- **Skips ownership and grants.** `OWNER TO` and `GRANT` name roles on the
  server the dump came from, not this one.
- **Leaves migration history alone.** Prisma's `_prisma_migrations`, Drizzle's
  `__drizzle_migrations` and TypeORM's tables are created but their rows are
  not imported: they are the other server's account of which migrations ran.
- **Resets sequences.** An auto-incrementing column restored with its values
  leaves its sequence where it was, and the *application's* next insert
  collides on the primary key — hours later, looking like a different bug.

The whole file runs in one transaction, including the `COPY … FROM stdin` data
blocks pg_dump writes. A statement the server refuses rolls all of it back and
is reported in the server's own words with the line of the file it was on.
`.sql.gz` is read without unpacking it first, decided by the file's own magic
number rather than its name.

The file's own `BEGIN;` and `COMMIT;` are not run — the import owns the
transaction, and a `COMMIT` inside the file would end it partway through.

## 0.3.0

### BullMQ queues

A Redis connection holding BullMQ queues gets a Queues section in the sidebar,
found by walking the keyspace. Opening one draws its lifecycle as a diagram
carrying the exact count in each state and the measured transition rate on each
edge. A rate that could not be measured — because the event stream was trimmed
past the resume point — reads as absent rather than as zero.

Clicking a state lists its jobs in the grid. Selecting a job shows its history,
built from the queue's event stream where that still reaches and from the job's
own timestamps where it does not. Failed and completed jobs stage and retry with
`⌘S`, or `⇧⌘S` to reset the attempt counter as well; the retry runs BullMQ's own
script, vendored verbatim.

The diagram polls once a second. The job rows are a snapshot that says how far
behind it is and is re-read with `⌘R`.

### Touch ID

A connection can require Touch ID before its credential is read. The check runs
backend-side in `session::connect`, in front of the keystore lookup, so a
refusal means the secret was never read rather than read and then not used. The
policy lives in `security.json`, not in the webview.

macOS only, and the app opens behind a lock screen when any connection requires
it.

### Settings

Theme, text size and what opening an object does to the tab strip, on `⌘,` and
in the macOS app menu.

### Follow a foreign key

Selecting a cell in a column that references another table puts a chevron at the
cell's right edge and names the target in the status bar — `→ public.users.id`.
Clicking the chevron opens that table filtered to the row the value names, so
the rest of the table stays one click away instead of being a dead end.

Single-column keys only. Half of a composite key names nothing, so those show no
chevron.

### SQL editor

The editor now tells a keyword, a table and a column apart. Keywords are the
accent and bold; a relation name takes its own colour, worked out from where the
identifier sits rather than from a list of names, so a column called `users`
stays a column.

Completion reads the connected schema at the two places where that is a real
question. After `join`, the list is built from the schema's own foreign keys —
picking `orders` under `select * from users u` writes
`orders ON orders.user_id = u.id`. Both directions of a key are offered and a
composite key joins on every column pair. After `where` — or `and`, `on`,
`select`, `order by` — it is the columns of whatever the statement has already
named, with their types, qualified by alias once more than one table is in
scope. Both stay quiet until the statement names a relation.

`⌘S` on a query tab keeps the statement as a chip under the editor, named after
the statement itself unless a name is typed into the field that opens with it.
The five most recent are shown; the rest are behind `View all`. A tab remembers
which query it came from, so a dot on the chip says the editor has moved on from
what is saved and `⌘S` updates that query rather than keeping a near-identical
second copy. `⇧⌘S` is the way to keep both.

### Fixed

- **The editor showed an arrow pointer and its text could not be selected.**
  `body` sets `user-select: none` and `cursor: default`, and both reach
  CodeMirror by inheritance — it sets neither itself, relying on the browser's
  defaults for editable content. The editor is now in the opt-in list beside
  `input` and `textarea`, where the comment above that rule already said it was.

- **Clicking in the editor placed the caret several characters from the
  pointer**, at every text size except 100%. Under CSS `zoom`, WebKit answers
  `getBoundingClientRect` in unzoomed layout pixels while a pointer event
  reports itself in zoomed viewport pixels, so anything mapping a click onto
  text lands between the two. Measured on a 45-character line: five characters
  off at 90%, twelve at 130%. The editor now cancels the root zoom and scales
  its own type instead, the way the titlebar does.

- **Opening a saved query into the current tab left the editor showing the
  previous statement.** The editor took its document once, on mount, so a
  statement written into the tab by anything other than typing never reached the
  screen — and the next keystroke wrote the stale document back over it.

- **Accepting a keyword completion rewrote what had just been typed**, turning
  `SELECT` into `select`. Keyword case is now read from the keystroke rather
  than fixed when the editor is built.

### Docs

`README.md` covers Redis and BullMQ; `DESIGN.md` carries the editor's identifier
hierarchy, the relation colour, and the measurements behind the zoom decision.
