# Changelog

What changed for someone using the app. The commit history is the record of
how; this is the record of what.

Releases before 0.3.0 are on the
[releases page](https://github.com/native-productions/rashbase-studio/releases).

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
