# MacPuffin — Design System

The implementation contract. Every colour, size and spacing value in
`public/style.css` traces to a token named here. Change this file before
changing the UI, not after.

## 0. Research Log

| Lane | Deliverable |
|---|---|
| **Slop diagnosis (own UI, measured)** | 9 near-identical stat cards; 9 views rendering the same table; every surface carrying the same hairline and radius; 15 distinct font sizes, i.e. no scale; every layout a grid of equal boxes. Confirmed the interface was assembled from one repeated component. |
| **Lazyweb real-product screens** | Queried `mac desktop system monitor disk storage analyzer utility`, `observability metrics dashboard dense charts dark developer`, `storage usage breakdown analytics treemap disk space`. Viewed `signoz`, `dash0`, `uptrace`. **Corpus is mostly marketing and docs pages, not native Mac utilities** — low signal for this domain, logged rather than skipped. Useful grammar harvested from the embedded product shots: narrow icon rails, list-detail splits instead of card grids, small type with tabular numerals, sparklines inline at text size, near-monochrome surfaces with one accent reserved for state. |
| **Platform reference** | macOS 26 ships Liquid Glass — translucent, light-reactive material across sidebars, toolbars and menus. A Mac utility that renders an opaque web dashboard reads as a web app in a wrapper. Accepted as direction; full vibrancy is listed as debt below. |
| **Embedded taste references** | `layout-skill.md` (app-shell mechanics, scroll ownership, content stress). The 12 taste skills and 70 brand systems are **not installed on this machine** — direction is set from the diagnosis and platform reference instead. |

## 1. Atmosphere & Identity

**An instrument, not a dashboard.** The reference class is Activity Monitor,
Instruments and observability consoles — not SaaS marketing surfaces. The app
measures a machine and reports numbers that must be trusted, so the surface
earns credibility through density and precision, not through decoration.

Three consequences, applied throughout:

1. **Numbers are the interface.** Type, alignment and spacing serve legibility of
   figures. Decoration that competes with a number is removed.
2. **One thing wins per screen.** Each view has a single primary element; every
   other element is deliberately quieter. Nine equal cards is the failure mode
   this replaces.
3. **Colour means something.** A surface is grey unless there is a reason. Colour
   marks state — filling up, reclaimable, running — never brand presence.

## 2. Colour

### Palette

| Token | Value | Role |
|---|---|---|
| `--bg` | `#0b0b0c` | window background |
| `--surface` | `#121214` | panels, rails |
| `--surface-raised` | `#171719` | rows on hover, active nav |
| `--line` | `#232327` | hairlines, dividers |
| `--line-strong` | `#2f2f35` | table header rule, focus ring base |
| `--ink` | `#ededef` | primary text and figures |
| `--ink-dim` | `#a1a1a8` | labels, secondary text |
| `--ink-faint` | `#6e6e78` | paths, units, metadata |
| `--accent` | `#f5a524` | attention: active state, selection, indeterminate progress |
| `--accent-dim` | `#8a5c14` | accent at rest |
| `--brand-a` | `#e5484d` | brand red — identity only |
| `--brand-b` | `#3b82f6` | brand blue — identity only |
| `--brand` | `linear-gradient(135deg, var(--brand-a), var(--brand-b))` | the identity gradient |
| `--ok` | `#4a9d6b` | safe to remove, healthy |
| `--warn` | `#d97706` | review before removing |
| `--danger` | `#e5484d` | destructive, critically full |
| `--cool` | `#3b82f6` | the low end of a meter only |

### Rules

- **One accent.** `--accent` appears at most twice per screen. If a third use
  appears, one of them is decoration — remove it.
- **The brand gradient appears exactly twice, and always in the same two
  places:** the primary action of a view, and the active navigation marker. It
  is the app's signature against a black ground, so it must stay rare enough to
  be recognised. A third use makes it wallpaper.
- **Red and blue also work as a scale, inside meters**, where blue→amber→red
  carries meaning: space free → filling → critical. That is a separate job from
  the identity gradient and the two must not be confused.
- **No gradient on any other surface.** Never on panels, rows, cards,
  backgrounds, or secondary buttons.
- **Semantic colours never decorate.** `--ok` / `--warn` / `--danger` only ever
  describe the safety of an action.
- Contrast floor 4.5:1 for text, 3:1 for meaningful non-text.

## 3. Typography

### Scale

Seven steps. Nothing outside this table.

| Token | Size / line | Use |
|---|---|---|
| `--t-display` | 34px / 1.05 | the one primary figure on a screen |
| `--t-title` | 19px / 1.2 | view title |
| `--t-heading` | 13px / 1.3 | panel headings, table headers |
| `--t-body` | 13px / 1.45 | body, row labels |
| `--t-figure` | 13px / 1 | numbers in rows, tabular |
| `--t-small` | 11.5px / 1.4 | units, metadata, paths |
| `--t-micro` | 10px / 1.3 | tags, uppercase labels |

### Font Stack

- UI: `-apple-system, BlinkMacSystemFont, "SF Pro Text"` — the platform face.
  Never Inter: on a Mac utility it reads as a web app, and it is the single most
  common generated-UI tell.
- Figures: `ui-monospace, "SF Mono", Menlo` with `font-variant-numeric:
  tabular-nums`.

### Rules

- **Every number is tabular.** Columns of figures must align on the digit.
- Weight carries hierarchy before size does: 400 body, 550 emphasis, 650 display.
- Uppercase only at `--t-micro`, with `0.08em` tracking.

## 4. Spacing & Layout

### Base Unit

4px. Permitted steps: 4, 8, 12, 16, 24, 32, 48.

### Grid

Shell is `fixed-sidenav-shell` (see `layout-skill.md`): a fixed rail, a fixed
header, and exactly one scroll owner — the content body.

- Scroll owner: `.content`. The sidebar and header never scroll.
- Height bounded with `100dvb`, never `100vh`.
- Every grid/flex scroll child carries `min-height: 0`.

### Rules

- **No equal-weight card grids.** A row of identical boxes is forbidden. Summary
  figures live in a single dense strip where each cell is sized by importance.
- Table rows are 34px, not 44px. Density is the point.
- Long paths truncate in the middle, never at the end — the filename is the
  identifying part.

## 5. Components

### Meter

A single horizontal bar carrying one proportion. Track `--line`; fill is the
blue→amber→red scale positioned by value. The only gradient in the product UI.

### Summary strip

Replaces the card grid. One row of figures, divided by hairlines, each cell
`--t-figure` over a `--t-micro` label. No borders, no fills, no icons per cell.

### Table

Header row in `--t-micro` uppercase over `--line-strong`. Rows 34px, hairline
between, `--surface-raised` on hover. Numbers right-aligned and tabular. Primary
label in `--ink`, path beneath in `--t-small` `--ink-faint`.

### Panel

`--surface` with a single `--line` hairline and 10px radius. No shadow, no glow,
no inner highlight. Depth comes from the value step to `--bg`, not from effects.

### Button

Bordered by default, on `--surface-raised`. The **one** primary action per view
carries the brand gradient. Destructive actions are text in `--danger` until
hovered.

### Scan strip

A single progress region in the shell, above the views, shown while any scan
runs. Carries the scan's name, its running counts, the path being read, and a
Stop control. Deliberately not per-view: a scan started on one screen must stay
visible when the user moves to another, which is exactly when they go looking
for it.

## 6. Motion & Interaction

### Timing

- State change: 120ms `ease-out`.
- Meter and progress: 400ms `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Nothing animates for longer than 400ms.

### Rules

- **Motion reports change, it never decorates.** Every transition maps to a
  value changing, a state toggling, or a surface being entered.
- Transform and opacity only.
- The ambient background does not move. A drifting gradient behind a measurement
  tool undermines the numbers it sits behind.
- `prefers-reduced-motion` removes all non-essential transitions.

## 7. Depth & Surface

### Strategy

**Value steps, not effects.** `--bg` → `--surface` → `--surface-raised` is the
entire depth system, plus one hairline. No drop shadows, no glows, no blurred
blobs, no glass on interior surfaces.

The window itself is the exception: the native shell provides the platform's
translucent material at the title bar, which is where a Mac app should show it.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Text contrast ≥ 4.5:1; meter fills and state dots ≥ 3:1.
- No information carried by colour alone — safety ratings carry a text label
  beside the colour.
- Every control reachable by keyboard, with a visible focus ring.
- Hit targets ≥ 28px tall even at 34px row density, achieved through padding.

### Accepted Debt

- **Dark only.** A light theme is not built. The tool is used against a file
  system at night more often than not, and a second theme doubles the surface to
  maintain without a second audience asking for it.
- **No real Liquid Glass inside the window.** The web view paints opaque
  surfaces; only the title bar carries the platform material. Full vibrancy
  needs an `NSVisualEffectView` behind a transparent web view, which is a native
  change, not a CSS one.
- **Storage map is proportional bars, not a treemap.** A treemap reads better
  for nested sizes but needs a layout engine; the bars carry the same ordering
  and proportion honestly in the meantime.
