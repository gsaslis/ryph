<script lang="ts">
import CopyButton from "$lib/components/copy-button/copy-button.svelte";

let {
  command,
  caption = null,
  what = "Command copied",
}: {
  /** Exactly what the person is meant to run — never a paraphrase of it. */
  command: string;
  /** When the command needs one line of context: where to run it, or what it does. */
  caption?: string | null;
  what?: string;
} = $props();
</script>

<div class="flex flex-col gap-1">
  {#if caption}
    <span class="text-muted-foreground text-xs">{caption}</span>
  {/if}
  <div class="bg-muted/50 flex items-start gap-2 rounded-md border p-2">
    <code class="min-w-0 flex-1 overflow-x-auto font-mono text-xs break-all">{command}</code>
    <CopyButton value={command} label="Copy the command" {what} />
  </div>
</div>
