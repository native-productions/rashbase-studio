# Rashbase Studio design system

Tokens live in `src/styles/theme.css` as a Tailwind v4 `@theme` block naming
them and two `[data-theme]` blocks holding the values. That file is the source
of truth; this document explains the reasoning behind it.

## The scene that decides the dark palette

> 11pm, warm desk lamp, 14-inch laptop, forty minutes into a result set, hunting
> for a NULL in column 7.

That scene, not the category "database tool", produces the decisions below.

- **Low ground, and the ink came down with it.** The canvas sits at L 0.145.
  What fatigues over a long session is the contrast ratio, not the absolute
  luminance, so the ink dropped from 0.93 to 0.89 alongside it and the ratio
  landed at 12.7:1, near the 11.7:1 it already was. Dropping the ground and
  leaving the ink is how a dark palette becomes the neon-on-black tool
  PRODUCT.md names as an anti-reference.
- **Warm, not blue-black.** Matches the light the user is actually sitting in.
- **Low chroma on every surface.** The data must be the brightest thing on
  screen, which is only possible if the chrome is not competing.
- **The chrome is translucent, the data is not.** See below.

## Two palettes, one set of names

`theme.css` resolves every `--color-*` through a second layer of `--t-*`
variables, and the two `[data-theme]` blocks under the `@theme` block are where
those values are written. The indirection buys one thing: a palette applies to
*any* element, not only `:root`, which is what lets the theme preview tiles in
Settings paint from the real tokens instead of a copied list that goes stale
the first time a colour is tuned.

Dark is what `:root` carries unqualified, so the first paint — before
`applyPrefs` has run — is the dark app rather than an unstyled one.

**The mapping is written twice on purpose**, and deleting the second copy
silently breaks the tiles. A `var()` inside a custom property is substituted
where that property is *declared*, not where it is used: `@theme` declares
`--color-canvas: var(--t-canvas)` on `:root`, so it resolves there against the
root's palette and what inherits down is a finished colour — setting `--t-canvas`
on a descendant after that does nothing at all. The `:root, [data-theme]` block
under the palettes re-declares the same mapping, which moves the substitution
onto the themed element. Values still live in one place each; only the names
repeat, and those carry no decision.

The tiles also pin `--surface-alpha` to 1. `base`, `raised` and `overlay`
multiply it into themselves, so a tile that inherited the translucency
preference would show the desktop through the palette it is trying to show.

### The light scene

> 10am, north-facing window, same 14-inch laptop, twenty minutes into a schema
> someone else wrote, cross-checking a column against a spec in the window next
> to it.

Warm paper, not white, tinted toward the same hue 90 the dark palette is. The
two are one room at two times of day, not two products. Ink lands at 12.6:1 on
canvas, which is where dark sits, so the ratio the eye works against does not
change with the switch.

`--color-ink-faint` is 0.52 rather than the lighter value the eye first
reaches for, because it carries the 10px eyebrow labels and anything higher
falls under 4.5:1 on paper.

### Why the yellow is three tokens

At the lightness that makes it read as yellow, the accent is ~2:1 against paper.
That is neither a readable word nor a visible ring, so on light it splits:

| Token | Job | Dark | Light |
|---|---|---|---|
| `--color-accent` | Text, SQL keywords, focus ring, borders, dots | `oklch(0.70 0.12 88)` | `oklch(0.56 0.14 72)` |
| `--color-accent-fill` | Filled surfaces: primary button, chosen segment | same as accent | `oklch(0.82 0.16 90)` |
| `--color-on-accent` | What sits on that fill | canvas | `oklch(0.26 0.03 80)` |

On dark all three collapse to what they always were, so nothing about the dark
palette moved.

`--color-on-danger` is the same split one colour over. `--color-scrim` is an
opaque colour rather than a baked alpha, so the three strengths the app already
uses (`/40` on the palette, `/50` on most dialogs, `/70` under the connection
sheet) survive the move off `bg-black`.

The editor is rebuilt when the palette changes. CodeMirror's `dark` flag
decides whether its `&dark` or `&light` base rules apply, every colour we do
not override falls through to that set, and the flag cannot be changed on a
live extension.

## Colour strategy: Restrained

Tinted neutrals plus one accent occupying under 10% of surface area.

The yellow appears on exactly five things: the active tab, the focus ring, the
selected cell, the primary button, and SQL keywords. Nowhere else. Yellow across
a large surface is unusable for an eight-hour session.

Every neutral is tinted toward hue 90 at chroma 0.008. There is no pure grey in
the system, no `#000`, and no `#fff`.

| Role | Token | Value |
|---|---|---|
| Data ground (grid, editor) | `--color-canvas` | `oklch(0.145 0.008 90)` |
| App ground | `--color-base` | `oklch(0.145 0.008 90 / var(--surface-alpha))` |
| Raised (sidebar, toolbar) | `--color-raised` | `oklch(0.175 0.008 90 / var(--surface-alpha))` |
| Overlay (menus, palette) | `--color-overlay` | `oklch(0.205 0.009 90 / var(--surface-alpha-solid))` |
| Sheet (dialogs) | `--color-sheet` | `oklch(0.125 0.008 90 / var(--surface-alpha-solid))` |
| Grid zebra | `--color-row-alt` | `oklch(0.168 0.008 90)` |
| Hover film | `--color-hover` | `oklch(0.85 0.01 90 / 0.055)` |
| Border | `--color-line` | `oklch(0.275 0.008 90)` |
| Cell line | `--color-line-soft` | `oklch(0.21 0.008 90)` |
| Text | `--color-ink` | `oklch(0.89 0.006 90)` |
| Secondary text | `--color-ink-muted` | `oklch(0.68 0.006 90)` |
| Tertiary text | `--color-ink-faint` | `oklch(0.56 0.006 90)` |
| Accent | `--color-accent` | `oklch(0.70 0.12 88)` |
| Selection film | `--color-accent-wash` | `oklch(0.70 0.12 88 / 0.17)` |

Those are the dark values. The light column is above, under *Why the yellow is
three tokens*.

`--color-ink-faint` went up, not down. It carries the 10px eyebrow labels,
which sat at 3.7:1 on the old ground; on the lower ground 0.56 buys 4.6:1 and
costs nothing, because it is text and not a surface.

### Semantic colours

Deliberately lower chroma than the accent, so a column of numbers never competes
with the one colour that means "focus".

| Type class | Token | Treatment |
|---|---|---|
| number | `--color-num` | right-aligned, tabular numerals |
| string / json / array | `--color-str` | left-aligned |
| bool | `--color-bool` | |
| relation name | `--color-relation` | editor only, see below |
| temporal / uuid | `--color-ink-muted` | |
| NULL | `--color-null` | italic, deliberately recessive |
| error | `--color-danger` | |

### The editor's three kinds of identifier

`select id from users u` holds a keyword, a column, a table and an alias, and
the SQL grammar reports three of those as the same token. Position is the only
thing that separates them, so `lib/utils/sqlSyntax.ts` works out which
identifiers sit where a relation can sit and the editor paints those.

| Part | Colour | Weight |
|---|---|---|
| Keyword | `--color-accent` | 600 |
| Relation name | `--color-relation` | 400 |
| Column, alias, everything else | `--color-ink` | 400 |

`--color-relation` is a rose, and its own hue rather than a borrowed one. Every
other semantic token already means something inside a statement — `num` and
`str` are literals, `bool` is a cast type, the accent is a keyword — so reusing
one would put two different things in the same colour on the same line, which
is the question the token exists to answer. Rose is the gap left between the
accent at hue 88 and the string green at 145 that is not read as an error:
`danger` sits at 25 and only ever appears as error text.

The accent is not available for this. It already carries five things, and "the
name of a table" is not one of them.

`TypeClass` is assigned in `src-tauri/src/drivers/postgres/types.rs::classify`
from the Postgres type name and travels with every column, so the grid never has
to guess. The class list itself is driver-neutral: a second driver maps its own
type names onto the same nine values, and the grid keeps rendering the way it
already does.

## Translucency

The chrome lets the desktop through: a compositor effect behind a transparent
window, `underWindowBackground` on macOS, Mica or Acrylic on Windows, nothing
on Linux. Tauri applies the first effect in the list that the platform
supports, so one list in `src/lib/translucency.ts` covers all three.

**The grid and the editor never take part.** They paint `--color-canvas`,
which has no alpha at all. A result grid is a dense scan surface read for
forty minutes at a time, and its legibility may not depend on what the user
happens to have as a wallpaper. This is the first principle in PRODUCT.md
applied to a material: the chrome recedes, including into the desktop behind
it, and the data does not move.

Two knobs, because chrome can afford more bleed than a menu can:

```css
:root                          { --surface-alpha: 1;    --surface-alpha-solid: 1; }
:root[data-translucent="on"]   { --surface-alpha: 0.72; --surface-alpha-solid: 0.88; }
```

Opaque is the default value, not a special case. That is also the Linux path
and the path when the preference is off: every surface paints solid, and the
fact that the window itself is transparent never shows.

### Which token a surface takes

Only three surfaces actually bleed: the titlebar, the sidebar, and the status
bar, plus anything rendered over the whole window (menus, the palette,
dialogs). Everything else lives inside `<main>`, which paints `canvas`, so the
footers and the filter bar keep their `raised` colour over an opaque ground
and read exactly as they did.

- `canvas` — the data pane, and anything sitting *inside* an overlay, a sheet,
  or on top of an accent or danger fill. `base` is thinner than the surface
  holding it, so a `base` well inside a dialog reads as a hole punched to the
  desktop, and `base` text on an amber button washes into the button.
- `base` — the app ground, and the surfaces continuous with it: the active
  tab in the titlebar, the sidebar's filter field. These are meant to look
  like the ground showing through the chrome, which is what they are.

### Hover and the selection wash are films, not fills

Both used to be solid colours a few points lighter than the surface under
them. A solid fill on a translucent sidebar punches an opaque hole through the
effect, so the hover state reads as a hole rather than a highlight. As alpha
they tint whatever is behind them, and on the opaque path they land in the
same place they did before.

### The preference

`view.translucency`, persisted to `localStorage` by `src/lib/translucency.ts`,
defaulting on for macOS and Windows and off for Linux. It is reachable from the
command palette and from Settings → Appearance; both call the same command, so
there is one switch with two doors.

Switching it does not animate. It is a configuration change, and one that
happens instantly is the honest reading of it.

Two consequences worth knowing before touching the window config:

- `transparent: true` on macOS requires the `macos-private-api` feature, which
  makes the build ineligible for the Mac App Store. Distribution is direct
  download and Homebrew, so this is not a cost we pay.
- `backgroundColor` was removed from `tauri.conf.json`. It paints an opaque
  ground over the effect, which is exactly the bug that looks like "the
  vibrancy silently does nothing."

## Typography

| Use | Family | Size |
|---|---|---|
| UI | Instrument Sans Variable | 13px base, 12px sidebar |
| Section labels | Instrument Sans, 600 | 10px, 0.08em tracking, uppercase |
| Grid cells, SQL | Geist Mono | 12px / 1.45 |

Both are OFL and self-hosted via `@fontsource`. No CDN, no network fetch, works
offline.

Hierarchy comes from weight and size, never from colour alone.

### Text size

One multiplier on the whole window, as `zoom` on the document root.

Every text size in this app is a hardcoded px while every spacing utility is
already rem, so moving the root font-size would grow the padding and leave the
text where it was. `zoom` moves all of it at once — text, spacing, the grid's
row height, the column widths measured in JS, the editor, the ERD, and the
dialogs, which portal onto `body` and are therefore inside it.

**The titlebar cancels it back out**, with `.titlebar { zoom: calc(1 / var(--ui-scale)) }`.
It has to: `trafficLightPosition.y` places the native buttons in device pixels
and does not scale with a preference, so a strip that scaled would leave the
tabs hanging off a line the lights no longer share. The tab strip is the one
surface this preference does not reach, and that is the cost of keeping the
seam.

Four steps rather than a slider, because each one is a number checked against
that seam: 0.9 Compact, 1.0 Default, 1.15 Large, 1.3 Larger.

## Motion

Frequency decides. An action repeated hundreds of times a day gets no animation,
because any entrance transition reads as the app being slow at exactly the
moment the user is watching most closely.

| Surface | Motion |
|---|---|
| Command palette (⌘K) | none |
| Tab switch, sidebar toggle | none |
| Grid row hover | none, and no transition |
| Connection sheet | 220ms in, 140ms out, `--ease-out-quart` |
| Button `:active` | `scale(0.97)`, 120ms |

```css
--ease-out-quart: cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out-quart: cubic-bezier(0.77, 0, 0.175, 1);
```

### The `!important` in the editor theme is load bearing

`EditorView.theme` prefixes our selectors with one generated class;
`EditorView.baseTheme` scopes its `&dark` rules with two, and its focused
selection rule runs six deep. So every editor colour that CodeMirror also
defines for dark mode — selection, caret, active line, active-line gutter,
gutters, tooltip — loses on specificity no matter how long a selector we write,
and silently renders in CodeMirror's palette instead of ours. Marking those
declarations is the only way to hold them. Do not remove them as tidying.

### The editor cancels the root zoom

The text size preference is `zoom` on `html`, for the reason `prefs.ts` gives:
every text size in this app is a hardcoded px while every spacing utility is
rem, so scaling the root font-size would move the padding and leave the text.

In WebKit, which is the webview on macOS, `zoom` splits the page into two
coordinate systems. `getBoundingClientRect` answers in unzoomed layout pixels;
a pointer event reports itself in zoomed viewport pixels. Anything that maps a
click onto text by asking the browser where that text is — which is what a code
editor does on every click — gets two different answers and lands between them.
Measured on a 45-character line: five characters off at `zoom: 0.9`, twelve at
`1.3`, and exact at `1`, which is why it was invisible on the default.

So the editor takes itself out of the zoom, the same way the titlebar does, and
scales its own type instead:

```
"&": {
  zoom: "calc(1 / var(--ui-scale, 1))",
  fontSize: "calc(12px * var(--ui-scale, 1))",
}
```

Inside that subtree the net zoom is 1 and the two answers are the same one. The
cost is that every size in the editor theme which should follow the preference
has to carry the multiplier — the tooltip and the completion detail do. `height`
must not: a percentage is resolved after the element's own zoom, so `100%`
already lands on the pane and a correction scales it twice.

The editor is also the surface `body`'s `user-select: none` had to be lifted
from. CodeMirror sets neither `user-select` nor `cursor`; it inherits the
browser's defaults for editable content, and those are exactly what the base
rule overrode. The opt-in is in `theme.css`, beside `input` and `textarea`.

Rules that hold everywhere:

- Never `ease-in`. It delays the initial movement, which is the part the user
  perceives as responsiveness.
- Never `transition: all`. Name the properties.
- Only `transform`, `opacity`, and `filter` animate.
- Nothing enters from `scale(0)`.
- Exit is always faster than entry. The user has already decided; do not make
  them wait for the system to agree.
- Under `prefers-reduced-motion`, movement is dropped and opacity is kept.
  Reduced means gentler, not absent.

## Layout

- No cards, and never nested cards. Panels are separated by 1px lines.
- Nothing is wrapped in a container unless the container does something.
- Spacing varies by density: 24px grid rows, 28px grid header, 44px titlebar,
  24px status bar.
- The macOS traffic lights are moved down to the tab row (`trafficLightPosition`
  in `tauri.conf.json`). They default to the middle of a 28px system titlebar,
  which is the middle of nothing in a 44px bar whose tabs hang from the bottom.
  Everything in that strip shares one line, or it reads as two rows that failed
  to line up. The arithmetic tying the two numbers together is in
  `Titlebar.tsx`; changing the bar height means changing the inset.
- Resizable split between editor and results; both panes have an 80px floor.

### The Settings sheet

Reached from **Rashbase Studio → Settings…**, ⌘, and the palette — one command
id, three doors. 720×560, fixed, split by a single 1px line into a 164px rail
and a content pane. Fixed rather than sized to its section: a dialog that
resizes as you move between three sections is a dialog whose rail moves under
the pointer.

Three sections, and each control that could be a word is a picture instead
where the picture answers something the word cannot:

- **Theme** is two tiles, each a miniature of the app — titlebar, sidebar, grid
  with one selected cell — rendered inside `data-theme` so it paints from the
  real tokens. Picking a palette is picking what a result set looks like, and
  no swatch answers that.
- **Text size** carries a specimen under the control: a real grid fragment with
  mono numerals, a selected cell, and the eyebrow header, at the size that is
  actually being chosen.
- **Tab behaviour** draws the two outcomes as three tab shapes.
- **Security** shows nothing but a sentence where Touch ID is unavailable. A
  disabled switch says "no sensor found" to a Windows user, which sends them
  looking for something that was never going to be there.

## Logo

A 2×2 grid with the top-left cell filled and the bottom-right cell's outer
corner notched away: a cursor on a selected cell. It refers to the data grid,
which is the product, rather than to a storage cylinder, which is a cliché.

- `assets/logo.svg` — mark, `currentColor`, on a 24-unit grid so strokes land on
  pixel boundaries at 16/24/32/48/64px
- `assets/logo-wordmark.svg` — mark plus wordmark
- `assets/app-icon.svg` → `assets/icon.png` → `bun run tauri icon` for the
  platform icon set. The app icon adds a rounded-square ground per macOS
  convention; the in-app mark has none.
