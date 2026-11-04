<script lang="ts">
import AgentAvatar from "$lib/components/agent-avatar/agent-avatar.svelte";
import type { Snippet } from "svelte";

let {
  agentId,
  agentName,
  children,
  status,
}: {
  /** The agent asked about. */
  agentId: string;
  agentName: string;
  /** The message box, or what stands in for it. */
  children: Snippet;
  /** One quiet line under the box, saying whether a message can go yet. */
  status?: Snippet;
} = $props();
</script>

<!-- A task with no instructions yet asks for them, in the middle of where the transcript will be.
     It fills what the task column leaves below the masthead, and centres the question in it, with
     the agent's face where the new-task page had it. -->
<section aria-labelledby="prompt-question"
  class="flex flex-1 flex-col items-center justify-center py-6">
  <div class="flex w-full max-w-2xl flex-col items-center gap-5">
    <AgentAvatar {agentId} size="lg" class="size-12" />
    <p
      id="prompt-question"
      class="font-heading text-center text-xl leading-snug font-bold tracking-[-0.02em] text-balance md:text-2xl"
    >
      What would you like {agentName} to do?
    </p>
    {@render children()}
    {#if status}
      <p
        class="text-muted-foreground flex min-h-4 items-center gap-1.5 self-start px-1 text-xs"
        aria-live="polite"
      >
        {@render status()}
      </p>
    {/if}
  </div>
</section>
