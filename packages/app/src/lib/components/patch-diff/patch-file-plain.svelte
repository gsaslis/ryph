<script lang="ts">
import type { FileDiffMetadata } from "@pierre/diffs";
import { plainLines } from "./diff-files";

// A file the renderer could not draw, as plain unified lines: what is approved stays readable.
let { file }: { file: FileDiffMetadata } = $props();

const lines = $derived(plainLines(file));
</script>

<div class="bg-card overflow-clip rounded-xl border">
  <div class="flex items-center gap-3 border-b px-4 py-2.5 text-sm">
    <span class="min-w-0 truncate font-mono">{file.name}</span>
    <span class="text-muted-foreground ml-auto shrink-0 text-xs">Shown without highlighting</span>
  </div>
  <div class="overflow-x-auto p-4 font-mono text-xs leading-5">
    {#each lines as line, i (i)}
      <!-- Git's header lines and each hunk's own are neither added nor removed. -->
      <div
        class={[
          "min-h-5 whitespace-pre",
          line.startsWith("+") && "text-success",
          line.startsWith("-") && "text-destructive",
          !/^[ +-]/.test(line) && "text-muted-foreground",
        ]}
      >{line}</div>
    {/each}
  </div>
</div>
