<script lang="ts">
import { page } from "$app/state";
import TaskStreamStatus from "$lib/components/task-stream-status/task-stream-status.svelte";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import TaskRow from "$lib/components/task-list-pane/task-row.svelte";
import { getTaskListContext } from "$lib/components/task-list/live-task-list.svelte";
import { Button } from "$lib/components/ui/button";
import * as Empty from "$lib/components/ui/empty";
import { Spinner } from "$lib/components/ui/spinner";
import ListChecksIcon from "@lucide/svelte/icons/list-checks";
import PlusIcon from "@lucide/svelte/icons/plus";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// The same list the pane draws, not a second copy of it: the app shell owns it, because a pane
// beside the page panel can only be rendered there, and hands it down through context.
const list = getTaskListContext();

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

<svelte:head>
  <title>Tasks · Ryph</title>
</svelte:head>

<!-- From xl up the list lives in the pane beside this panel, so an index that drew the table
     again would put the same rows on screen twice; what is missing there is a task to look at, and
     that is what this says instead. Below xl there is no pane and the table IS the list. -->
<div class="hidden min-h-[calc(100svh-5rem)] items-center xl:flex">
  <Empty.Root>
    <Empty.Header>
      <Empty.Media variant="icon">
        <ListChecksIcon />
      </Empty.Media>
      <Empty.Title>{list.rows.length === 0 ? "No tasks yet" : "No task selected"}</Empty.Title>
      <Empty.Description>
        {list.rows.length === 0
          ? "Create a task to put one of your agents to work."
          : "Pick one from the list to follow its run."}
      </Empty.Description>
    </Empty.Header>
    <Empty.Content>
      <Button href="/tasks/create">
        <PlusIcon data-icon="inline-start" />
        New task
      </Button>
    </Empty.Content>
  </Empty.Root>
</div>

<div class="flex flex-col gap-6 xl:hidden">
  <PageTitle title="Tasks">
    {#snippet aside()}
      <TaskStreamStatus state={list.streamState} retry={() => list.retry()}
        backTo={page.url.pathname + page.url.search + page.url.hash} viewport="mobile" />
    {/snippet}
    {#snippet actions()}
      <Button href="/tasks/create">
        <PlusIcon data-icon="inline-start" />
        New task
      </Button>
    {/snippet}
    {#snippet description()}
      Work handed to your agents, one run at a time.
    {/snippet}
  </PageTitle>

  {#if list.rows.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <ListChecksIcon />
        </Empty.Media>
        <Empty.Title>No tasks yet</Empty.Title>
        <Empty.Description>
          Create a task to put one of your agents to work.
        </Empty.Description>
      </Empty.Header>
      <Empty.Content>
        <Button href="/tasks/create">
          <PlusIcon data-icon="inline-start" />
          New task
        </Button>
      </Empty.Content>
    </Empty.Root>
  {:else}
    <div class="flex flex-col overflow-hidden rounded-lg border">
      {#each list.rows as task (task.id)}
        <TaskRow {task} class="hover:bg-muted/50 active:bg-muted border-b last:border-b-0" />
      {/each}
    </div>

    <!-- More rows as the end of the list comes into view, as the pane does: on a phone this page
         is the list, and there is nothing below it to scroll past to. -->
    {#if list.hasMore}
      <div bind:this={sentinel} class="text-muted-foreground flex justify-center p-4">
        <Spinner />
      </div>
    {/if}
  {/if}
</div>
