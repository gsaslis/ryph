<script lang="ts">
let {
  width = $bindable(),
  min,
  max,
  label = "Resize",
  oncommit,
}: {
  /** The width of the pane to the handle's RIGHT, in px. */
  width: number;
  min: number;
  max: number;
  label?: string;
  /** A move is over: the pointer let go, or a resizing key came up. Where to keep the width. */
  oncommit?: (width: number) => void;
} = $props();

const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));

let drag: { x: number; width: number } | null = null;

function onpointerdown(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  drag = { x: event.clientX, width };
}

function onpointermove(event: PointerEvent) {
  if (drag === null) return;
  // The pane is on the right: moving the handle left makes it wider.
  width = clamp(drag.width + (drag.x - event.clientX));
}

function onpointerup() {
  if (drag === null) return;
  drag = null;
  oncommit?.(width);
}

const RESIZING_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

function onkeyup(event: KeyboardEvent) {
  if (RESIZING_KEYS.has(event.key)) oncommit?.(width);
}

function onkeydown(event: KeyboardEvent) {
  const step = event.shiftKey ? 64 : 16;
  if (event.key === "ArrowLeft") width = clamp(width + step);
  else if (event.key === "ArrowRight") width = clamp(width - step);
  else if (event.key === "Home") width = max;
  else if (event.key === "End") width = min;
  else return;
  event.preventDefault();
}
</script>

<!-- A separator a person can move, by pointer or with the arrow keys. It hangs over the left edge
     of a `relative` pane: the visible line is the pane's own border, and this is the wider strip
     over it that takes the drag and lights up while it is held. -->
<!-- A focusable separator IS interactive: it is the ARIA window-splitter pattern. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuenow={width}
  aria-valuemin={min}
  aria-valuemax={max}
  tabindex="0"
  class="group/handle absolute inset-y-0 -left-1.5 z-10 w-3 cursor-col-resize touch-none outline-none"
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  onpointercancel={onpointerup}
  {onkeydown}
  {onkeyup}
>
  <div
    class="group-hover/handle:bg-ring group-focus-visible/handle:bg-ring group-active/handle:bg-ring absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors"
  ></div>
</div>
