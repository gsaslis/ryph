<script lang="ts">
import TaskTitle from "$lib/components/task-title/task-title.svelte";
import type { Snippet } from "svelte";
import { prefersReducedMotion } from "svelte/motion";
import { fade } from "svelte/transition";

let {
  title = null,
  byline,
  actions,
  facts,
}: {
  /** The task's title; null while it waits for its first message, and on the new-task page. */
  title?: string | null;
  /** Who and when, and how it is going. */
  byline: Snippet;
  /** What can be done about it. Hidden on a phone, where the breadcrumb bar carries it. */
  actions: Snippet;
  /** Where it runs, in one line of short facts: a `dl`'s rows. */
  facts?: Snippet;
} = $props();
</script>

<!-- The task's masthead, on the task page and on the new-task page that opens it, so the two line
     up row for row.

     The byline sits on the line "Tasks" sits on in the pane beside it: `min-h-14` against the
     panel's top edge is the pane's own `h-14` against the top of its column (the negative top
     margin takes back the page wrapper's top padding, which is what had pushed the whole masthead
     below that line). Under it is the task's title, once it has one: a task waiting for its first
     message has nothing to call itself yet, so the headline only arrives with the title, fading
     in when it lands while the page is open. On the right is only what you can do about it. -->
<header
  class="bg-background relative z-10 -mx-(--bleed) -mt-(--page-gutter-y) flex flex-col gap-1.5 border-b px-(--bleed) pb-4 [--bleed:calc((100cqw_-_100%)_/_2_+_var(--page-gutter))] after:pointer-events-none after:absolute after:inset-x-0 after:top-[calc(100%_+_1px)] after:h-12 after:bg-linear-to-b after:from-background after:to-transparent max-md:after:hidden md:sticky md:top-[calc(var(--panel-cap)_+_--spacing(14))] md:gap-2 md:pb-5 xl:top-(--panel-cap)"
>
  <div class="flex min-h-12 items-center justify-between gap-4 py-2 md:min-h-14">
    <!-- Wraps on a narrow panel, the badges going under the who and when, rather than all of it
         running into the buttons on the right. -->
    <div
      class="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-sm"
    >
      {@render byline()}
    </div>
    <!-- On a phone these ride the breadcrumb bar instead, which stays put while this masthead
         scrolls away. -->
    <div class="flex shrink-0 items-center gap-2 max-md:hidden">
      {@render actions()}
    </div>
  </div>

  {#if title !== null}
    <!-- The whole width, and as many lines as it takes: nothing sits beside it. -->
    <h1
      class="font-heading text-xl leading-tight md:text-2xl font-bold tracking-[-0.02em] text-pretty"
      in:fade={{ duration: prefersReducedMotion.current ? 0 : 320 }}
    >
      <TaskTitle {title} />
    </h1>
  {/if}

  {#if facts}
    <dl class="flex min-h-4 flex-wrap items-center gap-x-5 gap-y-1 text-xs">
      {@render facts()}
    </dl>
  {/if}
</header>
