<script lang="ts">
import { onDestroy } from "svelte";
import AgentAvatar from "$lib/components/agent-avatar/agent-avatar.svelte";
import RunStateBadge from "$lib/components/run-state-badge/run-state-badge.svelte";
import { Button } from "$lib/components/ui/button";
import TitleTransition from "$lib/components/task-title/task-title.svelte";

const titles = [
  null,
  "let's improve the task list a bit. work on a dev server on a scratch",
  "Smooth title transitions in the task list and detail view",
];
const stages = ["Waiting for instructions", "Prompt-derived title", "Model-generated title"];
let step = $state(0);
let playing = $state(false);
let timers: ReturnType<typeof setTimeout>[] = [];
const title = $derived(titles[step] ?? null);

function stop() {
  timers.forEach(clearTimeout);
  timers = [];
  playing = false;
}
function replay() {
  stop();
  step = 0;
  playing = true;
  timers = [
    setTimeout(() => {
      step = 1;
    }, 1400),
    setTimeout(() => {
      step = 2;
      playing = false;
    }, 3400),
  ];
}
onDestroy(stop);
</script>

<svelte:head>
  <title>Task title transitions · Ryph</title>
</svelte:head>

<div class="mx-auto flex max-w-6xl flex-col gap-8 py-6">
  <div class="flex flex-col gap-3">
    <p
      class="text-muted-foreground text-xs font-medium uppercase tracking-widest">Scratch / Task titles</p>
    <h1 class="font-heading text-2xl font-bold tracking-tight">A softer handoff</h1>
    <p class="text-muted-foreground max-w-2xl text-sm">
      The old title fades away; its replacement settles in just below it. Same timing in the
      list and headline, without animating every character. Reduced motion skips the transition.
    </p>
    <div class="flex flex-wrap items-center gap-2">
      <Button onclick={replay}>{playing ? "Replay again" : "Replay title sequence"}</Button>
      <Button variant="outline"
        onclick={() => { stop(); step = (step + 1) % titles.length; }}>Next title</Button>
      <span class="text-muted-foreground text-xs">{step + 1} / 3 · {stages[step]}</span>
    </div>
  </div>

  <div class="grid overflow-hidden rounded-xl border md:grid-cols-[19rem_minmax(0,1fr)]">
    <section aria-label="Task list preview" class="bg-muted/20 border-b md:border-r md:border-b-0">
      <div class="flex h-14 items-center border-b px-4 text-sm font-medium">Tasks</div>
      <div class="bg-accent/50 flex flex-col gap-1.5 border-b px-4 py-3 text-sm">
        <div class="text-muted-foreground flex items-center gap-1.5 text-xs">
          <AgentAvatar agentId="ada" size="sm" />
          <span>Ada</span><span class="ml-auto">just now</span>
        </div>
        <TitleTransition {title} compact />
        <RunStateBadge state="running" phase="running" />
      </div>
      <div class="text-muted-foreground flex flex-col gap-1.5 px-4 py-3 text-sm">
        <div class="flex items-center gap-1.5 text-xs">
          <AgentAvatar agentId="ada" size="sm" />
          <span>Ada</span><span class="ml-auto">12m ago</span>
        </div>
        <span
          class="text-foreground font-medium">Keep the task composer focused after sending</span>
        <RunStateBadge state="succeeded" />
      </div>
    </section>
    <section aria-label="Task detail preview" class="min-w-0 px-6 pb-12 md:px-8">
      <div class="text-muted-foreground flex min-h-14 flex-wrap items-center gap-3 text-sm">
        <AgentAvatar agentId="ada" size="sm" /><span>Ada</span>
        <RunStateBadge state="running" phase="running" />
        <span>just now</span>
      </div>
      <h2
        class="font-heading text-xl leading-tight font-bold tracking-[-0.02em] text-pretty md:text-2xl">
        <TitleTransition {title} />
      </h2>
      <p class="text-muted-foreground mt-4 border-b pb-5 text-xs">ryph-hq/ryph · main</p>
      <div class="flex flex-col gap-4 pt-8 text-sm">
        <p class="text-muted-foreground text-xs">YOU</p>
        <p>Let's improve the task list a bit. Work on a dev server on a scratch route.</p>
        <p class="text-muted-foreground mt-4 text-xs">ADA</p>
        <p>I'll prototype a subtle transition in both the task list and the detail headline.</p>
      </div>
    </section>
  </div>
  <p class="text-muted-foreground text-xs">
    Uses the same title component as the task list and detail view. The waiting headline is shown
    here for comparison; real task headlines remain empty until instructions arrive.
  </p>
</div>
