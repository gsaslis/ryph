<script lang="ts" module>
/** The table's outer cells: inset by what the table takes back (`--bleed`), so their content
 * lines up with the page's column while the table runs to the panel's edges. */
export const edgeStart = "pl-(--bleed)";
export const edgeEnd = "pr-(--bleed)";
/* The table is fixed-layout, so the outer columns must be widened by what their cells are padded
 * beyond the page's gutter (`--side`, the page's margin on a wide screen) or that padding would
 * eat into their content. A page gives its first and last `<col>` a width of
 * `calc(<its width> + var(--side))`. */
</script>

<script lang="ts">
import * as Table from "$lib/components/ui/table";
import type { Snippet } from "svelte";

let {
  columns,
  headings,
  children,
}: {
  /** A `<colgroup>`, drawn into both tables so the headings line up with the rows. */
  columns: Snippet;
  /** One `Table.Row` of `Table.Head`s. */
  headings: Snippet;
  /** The `Table.Row`s. */
  children: Snippet;
} = $props();

// The headings' table and the rows' table: the headings follow the rows when they scroll
// sideways. One way only, from the rows, as two boxes each following the other fight over a
// momentum scroll; a sideways swipe over the headings is handed to the rows instead, and taken
// from the page: the headings' box cannot scroll, so the swipe would go on to the browser's back
// gesture. Only a mostly sideways one, so a scroll down the page over the headings still is one;
// and as a browser lets only a gesture's first wheel be cancelled, `overscroll-x-none` on the
// box backs it for a swipe that starts out downward.
let headTable = $state<HTMLTableElement | null>(null);
let bodyTable = $state<HTMLTableElement | null>(null);
$effect(() => {
  const head = headTable?.parentElement;
  const rows = bodyTable?.parentElement;
  if (!head || !rows) return;
  const followRows = () => {
    head.scrollLeft = rows.scrollLeft;
  };
  // A wheel in lines (Firefox's mouse wheel) is scaled to pixels as a scroll box takes it, and a
  // shifted wheel a browser reports as vertical is sideways. A pinch (ctrl) is left to the page.
  const handOver = (e: WheelEvent) => {
    if (e.ctrlKey) return;
    const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
    if (Math.abs(dx) <= Math.abs(e.shiftKey ? 0 : e.deltaY)) return;
    e.preventDefault();
    rows.scrollLeft += e.deltaMode === 1 ? dx * 16 : dx;
  };
  followRows();
  rows.addEventListener("scroll", followRows, { passive: true });
  head.addEventListener("wheel", handOver, { passive: false });
  return () => {
    rows.removeEventListener("scroll", followRows);
    head.removeEventListener("wheel", handOver);
  };
});
</script>

<!-- Edge to edge across the panel at every width, taking back the page's gutters and, once the
     page's column is at its widest (`max-w-[100rem]` in the layout), the margin centering it
     too. The outer cells are padded by the same `--bleed`, so the rows' content stays within
     the page's column, lined up with the title, and centred with it on a wide screen. It is
     never framed: a framed table narrower than the panel showed its rounded top corners under
     the page header once its headings stuck there. `--bleed` is in `cqw` and `rem` rather than
     `%`, as it is read in the cells, where a `%` would be of the table rather than the column.
     `isolate`: the row links and icons raised over the row's link stay raised only within
     the table, below the page header that scrolls over it.
     Never narrower than its columns can be read at (`min-w-5xl`), so a narrow panel scrolls
     it sideways. A box that scrolls sideways scrolls both ways, and headings stuck inside one
     would stick to it rather than to the page — so they are a table of their own above it,
     stuck to the page, with the same columns, and follow the rows sideways (`followRows`).
     They stick 1px high, so their top rule tucks under the page header's own instead of
     doubling it. -->
<div
  class="isolate -mx-(--bleed) [--bleed:calc(var(--side)_+_var(--page-gutter))] [--side:max(0px,(100cqw_-_100rem)_/_2)]"
>
  <Table.Root
    bind:ref={headTable}
    aria-hidden="true"
    class="min-w-5xl table-fixed"
    containerClass="bg-background sticky top-[calc(--spacing(14)-1px)] z-20 overflow-x-hidden overscroll-x-none rounded-none border-x-0 border-b-0 md:top-[calc(var(--panel-cap)+--spacing(14)-1px)]"
  >
    {@render columns()}
    <Table.Header>{@render headings()}</Table.Header>
  </Table.Root>
  <Table.Root
    bind:ref={bodyTable}
    class="min-w-5xl table-fixed"
    containerClass="rounded-none border-x-0 border-t-0"
  >
    {@render columns()}
    <!-- The real headings, for a screen reader; the ones above are what is seen. -->
    <Table.Header class="sr-only">{@render headings()}</Table.Header>
    <Table.Body>{@render children()}</Table.Body>
  </Table.Root>
</div>
