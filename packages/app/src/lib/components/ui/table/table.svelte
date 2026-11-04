<script lang="ts">
import { cn, type WithElementRef } from "$lib/utils.js";
import type { HTMLTableAttributes } from "svelte/elements";

let {
  ref = $bindable(null),
  class: className,
  containerClass,
  children,
  ...restProps
}: WithElementRef<HTMLTableAttributes> & {
  /** For the framed scroll box around the table, which `class` does not reach. */
  containerClass?: string;
} = $props();
</script>

<!-- Framed here, so every table on every page is the same table: a hairline border with the panel's
     radius, and the scroll box that was already here clips the rows' hover fills to the corners.
     The pages used to wrap the ones they framed in a div of their own and leave the rest bare. -->
<div
  data-slot="table-container"
  class={cn("relative w-full overflow-x-auto rounded-lg border", containerClass)}
>
  <table bind:this={ref} data-slot="table" class={cn("w-full caption-bottom text-sm", className)}
    {...restProps}>
		{@render children?.()}
	</table>
</div>
