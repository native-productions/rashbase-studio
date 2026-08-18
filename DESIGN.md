# Rashbase Studio design system

Tokens live in `src/styles/theme.css` as a Tailwind v4 `@theme` block. That file
is the source of truth; this document explains the reasoning behind it.

## The scene that decides the palette

> 11pm, warm desk lamp, 14-inch laptop, forty minutes into a result set, hunting
> for a NULL in column 7.

That scene, not the category "database tool", produces the decisions below.

- **Dark, but not near-black.** High contrast against moderate ambient light is
  what causes fatigue over a long session.
- **Warm, not blue-black.** Matches the light the user is actually sitting in.
- **Low chroma on every surface.** The data must be the brightest thing on
  screen, which is only possible if the chrome is not competing.

## Colour strategy: Restrained

Tinted neutrals plus one accent occupying under 10% of surface area.

The yellow appears on exactly five things: the active tab, the focus ring, the
selected cell, the primary button, and SQL keywords. Nowhere else. Yellow across
a large surface is unusable for an eight-hour session.

Every neutral is tinted toward hue 90 at chroma 0.008. There is no pure grey in
the system, no `#000`, and no `#fff`.

| Role | Token | Value |
|---|---|---|
| Base ground | `--color-base` | `oklch(0.19 0.008 90)` |
| Raised (sidebar, toolbar) | `--color-raised` | `oklch(0.23 0.008 90)` |
| Overlay (menus, sheets) | `--color-overlay` | `oklch(0.27 0.009 90)` |
| Grid zebra | `--color-row-alt` | `oklch(0.21 0.008 90)` |
| Border | `--color-line` | `oklch(0.32 0.008 90)` |
| Cell line | `--color-line-soft` | `oklch(0.26 0.008 90)` |
| Text | `--color-ink` | `oklch(0.93 0.006 90)` |
| Secondary text | `--color-ink-muted` | `oklch(0.70 0.006 90)` |
| Tertiary text | `--color-ink-faint` | `oklch(0.55 0.006 90)` |
| Accent | `--color-accent` | `oklch(0.82 0.17 88)` |
| Selection fill | `--color-accent-wash` | `oklch(0.30 0.04 88)` |

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
