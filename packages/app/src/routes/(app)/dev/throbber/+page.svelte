<script lang="ts">
import AgentThrobber, {
  type ThrobberMood,
} from "$lib/components/agent-throbber/agent-throbber.svelte";
import RyphBlob from "$lib/components/ryph-blob/ryph-blob.svelte";

const moods: ThrobberMood[] = ["sleepy", "working", "thinking", "happy", "evil"];
let agentId = $state("agent-demo");
let mood = $state<ThrobberMood>("working");
let size = $state(64);
let blinkRate = $state(1);
let mouthRate = $state(1);
let bob = $state(1);
const ids = ["agent-demo", "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];
</script>

<div class="mx-auto flex max-w-4xl flex-col gap-8 p-6">
  <h1 class="text-xl font-semibold">Agent throbber</h1>

  <section class="grid gap-6 md:grid-cols-[1fr_16rem]">
    <div class="bg-muted/40 flex min-h-48 items-center justify-center rounded-lg border">
      <AgentThrobber {agentId} {mood} {size} {blinkRate} {mouthRate} {bob} />
    </div>
    <div class="flex flex-col gap-3 text-sm">
      <label class="flex flex-col gap-1">Agent id
        <input class="rounded border px-2 py-1" bind:value={agentId} />
      </label>
      <label class="flex flex-col gap-1">Mood
        <select class="rounded border px-2 py-1" bind:value={mood}>
          {#each moods as m (m)}<option value={m}>{m}</option>{/each}
        </select>
      </label>
      <label class="flex flex-col gap-1">Size {size}px
        <input type="range" min="24" max="160" bind:value={size} />
      </label>
      <label class="flex flex-col gap-1">Blink rate ×{blinkRate}
        <input type="range" min="0.25" max="4" step="0.25" bind:value={blinkRate} />
      </label>
      <label class="flex flex-col gap-1">Mouth rate ×{mouthRate}
        <input type="range" min="0.25" max="4" step="0.25" bind:value={mouthRate} />
      </label>
      <label class="flex flex-col gap-1">Body bob ×{bob}
        <input type="range" min="0" max="3" step="0.25" bind:value={bob} />
      </label>
    </div>
  </section>

  <section class="flex flex-col gap-3">
    <h2 class="font-medium">Every mood, several agents</h2>
    <div class="grid grid-cols-[6rem_repeat(5,1fr)] items-center gap-3 text-sm">
      <span></span>{#each moods as m (m)}<span class="text-muted-foreground">{m}</span>{/each}
      {#each ids as id (id)}
        <span class="text-muted-foreground">{id}</span>
        {#each moods as m (m)}<AgentThrobber agentId={id} mood={m} size={40} />{/each}
      {/each}
    </div>
  </section>

  <section class="flex items-center gap-6">
    <h2 class="font-medium">Current logo blob</h2>
    <RyphBlob mood="excited" />
    <RyphBlob mood="idle" />
  </section>
</div>
