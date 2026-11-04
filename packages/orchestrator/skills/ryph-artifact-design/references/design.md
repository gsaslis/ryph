# Designing an artifact

An artifact should read like a well-edited document, not a generated web page. The reader wants the
answer, the evidence and the next step, in that order. Every choice below serves that: calm type,
one accent colour, generous space, and structure that shows at a glance.

[../assets/template.html](../assets/template.html) implements all of it. Change the content, keep
the system.

## Type

Use the system stack. It loads instantly, looks native on every device and never fails:

```css
--font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue",
  Arial, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
```

A Google Font is fine for character (Inter, IBM Plex Sans, Source Serif 4 for long reading), one
family, two or three weights, with `display=swap`, and always the system stack after it.

One scale, on a ratio of about 1.25, and nothing off it:

| Token       | Size                           | Use                              |
| ----------- | ------------------------------ | -------------------------------- |
| `--step--1` | 0.875rem                       | captions, table cells, footnotes |
| `--step-0`  | 1rem (body is 17px on desktop) | body text                        |
| `--step-1`  | 1.25rem                        | h3, lead paragraph               |
| `--step-2`  | 1.5rem                         | h2                               |
| `--step-3`  | clamp(1.75rem, 5vw, 2.5rem)    | the page title (h1), once        |

- Body line-height 1.6; headings 1.2 with `text-wrap: balance`; body `text-wrap: pretty`.
- Headings carry weight (600–700) and sit closer to the text below them than above.
- Never below 0.875rem for anything a reader must read. Numbers in tables get
  `font-variant-numeric: tabular-nums`.

## Measure and rhythm

- Prose is at most **65ch** wide (`max-width: 65ch`). Tables, charts and card grids may break out to
  about 1100px; prose never does.
- Spacing comes from one scale: `--space-1` 0.25rem, `-2` 0.5rem, `-3` 1rem, `-4` 1.5rem, `-5`
  2.5rem, `-6` 4rem. Paragraphs 1rem apart, sections `--space-6` apart, an h2 `--space-5` above.
- Left-align everything that is read. Center only a lone figure or a single short label.

## Colour

A restrained palette: neutrals, one accent, and status colours used only for status.

```css
:root {
  color-scheme: light dark;
  --bg: #fbfbf9;
  --surface: #ffffff;
  --border: #e4e4e0;
  --text: #1c1c1a;
  --muted: #5f5f5a;
  --accent: #2f5bd3;
  --good: #1f7a4d;
  --warn: #a15c00;
  --bad: #b42318;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131314;
    --surface: #1b1b1d;
    --border: #2e2e32;
    --text: #ececea;
    --muted: #a3a3a0;
    --accent: #8aa8ff;
    --good: #5cc38f;
    --warn: #e0a64a;
    --bad: #f08a80;
  }
}
```

- Every colour in a rule is a `var(--…)`. A literal colour is a bug in dark mode.
- Accent marks what is interactive or most important: links, the TL;DR rule, one highlighted series.
  If everything is accented, nothing is.
- Pick a different accent if the subject has one (a brand, a project colour), but keep the neutrals
  and keep contrast.
- Dark mode is not inverted light mode: surfaces lighten slightly as they rise, accents desaturate.

## Layouts

Pick the one the content is, and keep to it.

**Article** (research write-up, explanation). Header, a lead paragraph, sections with h2s, sources
at the end. One column at 65ch.

**Report** (findings, audit, incident). Header, then a **TL;DR callout** with the answer in two to
four sentences or three bullets at most, then key numbers as a row of stat tiles, then sections in
order of importance, then method and sources. A reader who stops after the TL;DR should still know
what to do.

**Comparison.** The recommendation first, in one sentence. Then a table: options as columns (two to
four), criteria as rows, the deciding rows first. Mark the chosen column with the accent on its
header, not with colour across every cell. Use words or short phrases in cells, not checkmark emoji.
Then a short section per option for what the table cannot say.

**Card grid** (an overview of many similar things: services, repos, candidates).
`display: grid; grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr)); gap: var(--space-3)`.
Each card: a title, one line of what it is, two or three facts. Equal structure in every card.

**Timeline** (incident, history, plan). A vertical list with the time in a fixed-width tabular
column and a thin rule joining the points; one line per event, details folded in `<details>`.

Use `<details><summary>` for material most readers skip: raw data, logs, method.

## Responsive

- Mobile first: base styles are for a 375px screen; add `@media (min-width: 48rem)` for more.
- 16px side gutters on phones (`padding-inline: max(1rem, env(safe-area-inset-left))`), more on wide
  screens.
- No horizontal page scroll. Every table sits in `<div class="table-wrap">` with `overflow-x: auto`;
  long code lines wrap or scroll inside their `<pre>`; images get `max-width: 100%; height: auto`;
  long URLs get `overflow-wrap: anywhere`.
- Stat tiles and card grids reflow with `auto-fit`/`auto-fill`, never fixed column counts.
- Charts take the container's width and a fixed aspect, and stay legible at 375px: fewer ticks,
  shorter labels.

## Accessibility

- One `<h1>`, then h2 and h3 in order. Never skip a level for size; style the right level.
- Real elements: `<header>`, `<main>`, `<section>`, `<table>` with `<th scope>`, `<figure>` with
  `<figcaption>`, `<ol>` for sources.
- Text contrast at least 4.5:1 against its background in both themes; `--muted` on `--surface`
  included. Never convey meaning by colour alone: a status is a word plus a colour.
- Every `<img>` has an `alt` that says what the image shows; a decorative one has `alt=""`. A
  chart's `<canvas>` gets `role="img"` and an `aria-label` with the takeaway, and the numbers are in
  a table or the text as well.
- `lang` on `<html>`, a `<title>`, and a viewport meta.

## Charts

Use a chart when the shape of the numbers is the point; use a table when the values are.

- Previews show the page without scripts, so a chart drawn by a script is blank there. Prefer inline
  SVG for the charts that carry the answer; when you use a library, keep the numbers in a table or
  the text beside it.
- Chart.js from jsdelivr, pinned:
  `https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js`. For hand-built visuals,
  inline SVG needs no library at all. D3, ECharts and Mermaid also load from
  `cdn.jsdelivr.net/npm/`, each with its exact version in the URL. A library that compiles code at
  runtime (with `eval` or `new Function`) does not work: the policy blocks both.
- Data inline in the script, never fetched.
- Colours from the tokens: read them with
  `getComputedStyle(document.documentElement).getPropertyValue("--accent")`, so the chart follows
  light and dark. One highlighted series in the accent, others in `--muted` or a desaturated set.
- Label both axes with units, start bar charts at zero, title the chart with its takeaway ("p95
  latency doubled after the 3 June deploy"), and drop the legend when there is one series.
- Set `maintainAspectRatio: true` and a sensible `aspectRatio`, and turn off animation: the page may
  be shown in a small preview.

## What to avoid

- Gradient hero banners, glassmorphism, glowing shadows, purple-to-blue anything. It reads as
  generated.
- Emoji as bullets, headings or table cells.
- Walls of bullet points. Write sentences; use a list only for things that are truly parallel, and
  keep it under seven items.
- Centered body text, justified text, all-caps paragraphs.
- Small grey text for content that matters. Muted is for metadata only.
- Cards inside cards, borders on everything, more than two levels of emphasis.
- Decorative icons, stock-photo energy, filler ("In today's fast-paced world").
- Repeating the title in the first paragraph. Start with the answer.
