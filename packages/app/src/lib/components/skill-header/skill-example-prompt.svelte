<script lang="ts">
import CopyButton from "$lib/components/copy-button/copy-button.svelte";

let { prompt }: { prompt: string } = $props();
</script>

<!-- A prompt the skill's author suggests, as plain text with its line breaks kept. -->
<section class="flex flex-col gap-3" aria-labelledby="example-prompt-title">
  <h2 id="example-prompt-title" class="text-sm font-semibold">Example prompt</h2>
  <div class="bg-muted/40 flex items-start gap-2 rounded-lg border py-2 pr-2 pl-4">
    <p class="min-w-0 flex-1 py-1 text-sm whitespace-pre-wrap wrap-anywhere">{prompt}</p>
    <CopyButton value={prompt} size="icon-sm" label="Copy the prompt" what="Prompt copied" />
  </div>
</section>
