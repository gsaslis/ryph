<script lang="ts">
import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
import DropdownMenuPortal from "./dropdown-menu-portal.svelte";
import type { ComponentProps } from "svelte";

let {
  ref = $bindable(null),
  sideOffset = 4,
  align = "start",
  portalProps,
  class: className,
  ...restProps
}: DropdownMenuPrimitive.ContentProps & {
  portalProps?: WithoutChildrenOrChild<ComponentProps<typeof DropdownMenuPortal>>;
} = $props();
</script>

<DropdownMenuPortal {...portalProps}>
  <!-- At least as wide as what opened it, and as wide as its items need: stock set the width TO the
     trigger's, which under an icon button is the 128px floor, and "Rotate credential" wrapped. -->
  <DropdownMenuPrimitive.Content
    bind:ref
    data-slot="dropdown-menu-content"
    {sideOffset}
    {align}
    class={cn(
			"data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 bg-popover text-popover-foreground min-w-[max(--spacing(32),var(--bits-dropdown-menu-anchor-width))] rounded-md p-1 shadow-md ring-1 duration-100 z-50 max-h-(--bits-dropdown-menu-content-available-height) origin-(--bits-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto data-closed:overflow-hidden",
			className
		)}
    {...restProps}
  />
</DropdownMenuPortal>
