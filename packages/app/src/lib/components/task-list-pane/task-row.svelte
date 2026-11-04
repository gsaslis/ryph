<script lang="ts">
import type { TaskSummary } from "$lib/api/types";
import AgentAvatar from "$lib/components/agent-avatar/agent-avatar.svelte";
import RunStateBadge from "$lib/components/run-state-badge/run-state-badge.svelte";
import { Badge } from "$lib/components/ui/badge";
import { cn } from "$lib/utils";
import { formatDateTime, formatRelativeTime } from "$lib/utils/format";
import TaskTitle from "$lib/components/task-title/task-title.svelte";

let { task, selected = false, class: className }: {
  task: TaskSummary;
  selected?: boolean;
  /** The row's surface: its hover and selected fills, which differ between the pane and a page. */
  class?: string;
} = $props();
</script>

<!-- One task as the lists draw it: who and when, the title, and how its run is going. -->
<a
  href="/tasks/{task.id}"
  aria-current={selected ? "page" : undefined}
  class={cn("flex flex-col gap-1.5 px-4 py-3 text-sm transition-colors", className)}
>
  <div class="text-muted-foreground flex items-center gap-1.5 text-xs">
    <AgentAvatar agentId={task.agentId} size="sm" />
    <span class="truncate">{task.agentName ?? task.agentId}</span>
    <!-- The list is ordered by when a task was ASKED for, so that is what the row says; when it
         last moved is the other half of the story and rides the tooltip. -->
    <span
      class="ml-auto shrink-0"
      title="Created {formatDateTime(task.createdAt)} · last moved {formatDateTime(
        task.lastActivityAt,
      )}"
    >
      {formatRelativeTime(task.createdAt)}
    </span>
  </div>
  <TaskTitle title={task.title} compact />
  <div class="flex flex-wrap items-center justify-between gap-2">
    <RunStateBadge state={task.state} phase={task.phase} />
    {#if task.state === "running" && task.phase === "running" && task.idleState}
      {#if task.idleState === "waiting-for-user"}
        <Badge>Your turn</Badge>
      {:else if task.declaredOutcome === "success" || task.declaredOutcome === "no-changes"}
        <Badge variant="success">Done</Badge>
      {:else}
        <Badge variant="secondary">Idle</Badge>
      {/if}
    {/if}
  </div>
</a>
