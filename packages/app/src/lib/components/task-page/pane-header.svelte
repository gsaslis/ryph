<script lang="ts">
import { Button } from "$lib/components/ui/button";
import XIcon from "@lucide/svelte/icons/x";
import type { Snippet } from "svelte";
import type { Attachment } from "svelte/attachments";

let {
  docked,
  close,
  closeLabel = "Close details",
  strip,
  children,
}: {
  /** Beside the panel. Shut from the masthead there; in a sheet, from a button here. */
  docked: boolean;
  close: () => void;
  closeLabel?: string;
  /** Run on the strip that holds the content, for one that scrolls sideways. */
  strip?: Attachment<HTMLElement>;
  /** Tabs, or a title. */
  children: Snippet;
} = $props();
</script>

<!-- The top of the task's details pane, and of the new task's settings in the same place. Tabs
     hang from the rule the way the browser's own Actions, Console and Network do, their labels on
     the line the tasks pane's "Tasks" and the masthead's byline sit on, the middle of their h-14
     rows: the tabs hang from the rule, so it is the rule that moves to put them there, and h-12 is
     what brings a tab's middle up to 28px. Docked, it is shut from the masthead's switch; in a
     sheet, from the close button at the strip's end, on the tabs' line. -->
<header class={["flex h-12 shrink-0 items-end border-b", !docked && "pr-2"]}>
  <!-- Scrolls sideways when the pane is narrower than the strip, fading out at the end that has
       more. `-mb-px pb-px` reaches over the header's rule, so an open tab's underline is drawn on
       it rather than clipped above it. -->
  <div
    class="scroll-fade-x @container/strip -mb-px min-w-0 flex-1 overflow-x-auto overflow-y-hidden px-2 pb-px [scrollbar-width:none]"
    {@attach strip}
  >
    {@render children()}
  </div>
  {#if !docked}
    <div class="flex h-9 shrink-0 items-center">
      <Button variant="ghost" size="icon-sm" onclick={close}>
        <XIcon />
        <span class="sr-only">{closeLabel}</span>
      </Button>
    </div>
  {/if}
</header>
