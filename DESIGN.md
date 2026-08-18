# Rashbase Studio design system

Tokens live in `src/styles/theme.css` as a Tailwind v4 `@theme` block. That file
is the source of truth; this document explains the reasoning behind it.

## The scene that decides the palette

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
| temporal / uuid | `--color-ink-muted` | |
| NULL | `--color-null` | italic, deliberately recessive |
| error | `--color-danger` | |

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

`view.translucency` in the command palette, persisted to `localStorage` by
`src/lib/translucency.ts`, defaulting on for macOS and Windows and off for
Linux. There is no Preferences panel; a ⌘K command is the settings surface
this app already has, and it is where every other view toggle lives.

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
- Resizable split between editor and results; both panes have an 80px floor.

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
