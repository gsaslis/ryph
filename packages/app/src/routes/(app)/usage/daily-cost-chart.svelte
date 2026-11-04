<script lang="ts">
import { formatUsd } from "$lib/utils/format";

// One series, one colour: what each UTC day cost. Columns grow from a single baseline, capped at
// 24px with a 2px gap between neighbours; every column's whole slot is its hover and focus target,
// and the page renders the same numbers as a table beside it — the tooltip never gates a value.

type Bar = { day: string; cost: number; requests: number };
let { bars }: { bars: Bar[] } = $props();

const PLOT_HEIGHT = 180;
const TOP = 8;
const AXIS_BAND = 24;
const LEFT = 64;
const GAP = 2;

let width = $state(0);
let active = $state<number | null>(null);

/** Ticks on clean numbers: a step of 1, 2, 2.5 or 5 times a power of ten, four-ish of them. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const count = Math.ceil(max / step);
  return Array.from({ length: count + 1 }, (_, i) => i * step);
}

const ticks = $derived(niceTicks(Math.max(0, ...bars.map((b) => b.cost))));
const ceiling = $derived(ticks.at(-1) || 1);
const plotWidth = $derived(Math.max(0, width - LEFT));
const band = $derived(bars.length === 0 ? 0 : plotWidth / bars.length);
const barWidth = $derived(Math.max(1, Math.min(24, band - GAP)));

const y = (value: number) => TOP + PLOT_HEIGHT - (value / ceiling) * PLOT_HEIGHT;

/** A column with a 4px rounded data end and a square foot on the baseline. */
function columnPath(x: number, top: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} ` +
    `Q${x + w},${top} ${x + w},${top + r} V${top + h} Z`;
}

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

// Sparse x labels: the first, middle and last day are enough to place every column.
const labelled = $derived(
  new Set(bars.length === 0 ? [] : [0, Math.floor((bars.length - 1) / 2), bars.length - 1]),
);
</script>

<div class="relative w-full" bind:clientWidth={width}>
  {#if width > 0}
    <svg
      width={width}
      height={TOP + PLOT_HEIGHT + AXIS_BAND}
      class="block overflow-visible"
      aria-hidden="true"
    >
      {#each ticks as tick (tick)}
        <line
          x1={LEFT}
          x2={width}
          y1={y(tick)}
          y2={y(tick)}
          class="stroke-border"
          stroke-width="1"
          shape-rendering="crispEdges"
        />
        <!-- Set flush left, on the page's own edge, rather than ranged right against the axis:
             the tick amounts are all the same width bar their digit count, and a ragged left
             margin read as the chart being indented from the heading above it. -->
        <text
          x={0}
          y={y(tick)}
          text-anchor="start"
          dominant-baseline="middle"
          class="fill-muted-foreground text-[11px] tabular-nums"
        >
          {formatUsd(tick)}
        </text>
      {/each}
      {#each bars as bar, i (bar.day)}
        {@const h = (bar.cost / ceiling) * PLOT_HEIGHT}
        {#if h > 0}
          <path
            d={columnPath(LEFT + i * band + (band - barWidth) / 2, y(bar.cost), barWidth, h)}
            class="fill-chart-3 transition-opacity"
            opacity={active === null || active === i ? 1 : 0.45}
          />
        {/if}
        {#if labelled.has(i)}
          <text
            x={LEFT + (i + 0.5) * band}
            y={TOP + PLOT_HEIGHT + 16}
            text-anchor={i === 0 && bars.length > 1
            ? "start"
            : i === bars.length - 1 && bars.length > 1
            ? "end"
            : "middle"}
            class="fill-muted-foreground text-[11px]"
          >
            {dayLabel(bar.day)}
          </text>
        {/if}
      {/each}
    </svg>

    <!-- The hit layer: a real button per day, as wide as its slot and as tall as the plot. -->
    {#each bars as bar, i (bar.day)}
      <button
        type="button"
        class="focus-visible:ring-ring absolute rounded-sm outline-none focus-visible:ring-2"
        style:left="{LEFT + i * band}px"
        style:top="{TOP}px"
        style:width="{band}px"
        style:height="{PLOT_HEIGHT}px"
        aria-label="{dayLabel(bar.day)}: {formatUsd(bar.cost)} across {bar.requests} model calls"
        onpointerenter={() => (active = i)}
        onpointerleave={() => (active = null)}
        onfocus={() => (active = i)}
        onblur={() => (active = null)}
      ></button>
    {/each}

    {#if active !== null && bars[active]}
      {@const bar = bars[active]}
      <div
        class="bg-popover text-popover-foreground pointer-events-none absolute z-10 flex -translate-x-1/2 -translate-y-full flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-xs shadow-md"
        style:left="{Math.min(Math.max(LEFT + (active + 0.5) * band, 72), width - 72)}px"
        style:top="{Math.max(y(bar.cost) - 6, 40)}px"
      >
        <span class="flex items-center gap-1.5">
          <span class="bg-chart-3 inline-block h-0.5 w-3 rounded-full"></span>
          <strong class="text-sm font-semibold">{formatUsd(bar.cost)}</strong>
        </span>
        <span class="text-muted-foreground">
          {dayLabel(bar.day)} · {bar.requests} {bar.requests === 1 ? "call" : "calls"}
        </span>
      </div>
    {/if}
  {/if}
</div>
