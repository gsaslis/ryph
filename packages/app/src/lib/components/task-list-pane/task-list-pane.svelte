<script lang="ts">
import { page } from "$app/state";
import TaskStreamStatus from "$lib/components/task-stream-status/task-stream-status.svelte";
import type { LiveTaskList } from "$lib/components/task-list/live-task-list.svelte";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import TaskRow from "./task-row.svelte";
import PlusIcon from "@lucide/svelte/icons/plus";

let { list }: { list: LiveTaskList } = $props();

// The next page loads when the bottom of the list comes into view rather than on a click: this
// column is one scroll, and a button at the end of it is a stop sign in the middle of a gesture.
// The margin asks early enough that the rows are usually there before the gap would show.
let sentinel = $state<HTMLElement | null>(null);
$effect(() => {
  const el = sentinel;
  if (el === null) return;
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void list.loadMore();
    },
    { rootMargin: "300px" },
  );
  observer.observe(el);
  return () => observer.disconnect();
});
</script>

<!-- A second rail, on the canvas rather than in the page panel: the panel to its right keeps its
     own header and its own scroll, and this column stands still while that panel slides between
     tasks — hence the view-transition name, which lifts it out of the root snapshot the way the
     nav sidebar is lifted. `sticky h-svh` rather than a full-height block because the document is
     what scrolls here; the list scrolls inside itself, and `overscroll-contain` stops the page
     from taking over once it hits an end. -->
<aside
  class="border-sidebar-border sticky top-0 hidden h-svh w-80 shrink-0 flex-col self-start border-l py-2 xl:flex [view-transition-name:tasks-pane]"
>
  <!-- h-14 at 8px down, matching the page panel's header exactly: the panel's `m-2` and this
       column's `py-2` start the two at the same y. -->
  <header class="flex h-14 shrink-0 items-center gap-1 pr-2 pl-4">
    <span class="text-base font-semibold tracking-tight">Tasks</span>
    <TaskStreamStatus state={list.streamState} retry={() => list.retry()}
      backTo={page.url.pathname + page.url.search + page.url.hash} viewport="desktop" />
    <Button
      href="/tasks/create"
      size="icon"
      class="ml-auto rounded-full"
      aria-label="New task"
      title="New task"
    >
      <PlusIcon />
    </Button>
  </header>

  <!-- Rows fade out under the header and at the bottom edge rather than being cut off. -->
  <div class="scroll-fade-y min-h-0 flex-1 overflow-y-auto overscroll-contain">
    {#if list.rows.length === 0}
      <p class="text-muted-foreground px-4 py-6 text-center text-sm">
        No tasks yet.
      </p>
    {:else}
      {#each list.rows as task (task.id)}
        <TaskRow
          {task}
          selected={page.url.pathname === `/tasks/${task.id}`}
          class="border-sidebar-border hover:bg-sidebar-accent/60 aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground border-b last:border-b-0"
        />
      {/each}

      {#if list.hasMore}
        <div bind:this={sentinel} class="text-muted-foreground p-4 text-center text-xs">
          <Spinner class="inline-block" />
        </div>
      {/if}
    {/if}
  </div>
</aside>
