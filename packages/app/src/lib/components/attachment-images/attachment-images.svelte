<script lang="ts">
import type { AttachmentRef } from "$lib/api/types";
import * as Dialog from "$lib/components/ui/dialog";
import { cn } from "$lib/utils";
import AttachmentThumb from "./attachment-thumb.svelte";
import { getAttachmentUrlContext } from "./attachment-url-context";

/** An image to show, with what it is of when its author said: an agent's alt text. */
type Shown = Pick<AttachmentRef, "id"> & { alt?: string };

let {
  runId,
  attachments,
  size = "thumbnail",
  class: className,
}: {
  runId: string;
  /** In the order the text's `[image N]` markers count them, which is how the ones without alt
   * text are labelled. */
  attachments: readonly Shown[];
  /** A square crop, or the whole image at a height a screenshot can be read at. */
  size?: "thumbnail" | "preview";
  class?: string;
} = $props();

const label = (ref: Shown, n: number) => ref.alt || `Image ${n}`;

// A run's images as thumbnails, each opening full size. The bytes are served by the control
// plane as the type it sniffed, inert (`nosniff`, a sandbox CSP), and checked with it again on every
// view (`private, no-cache`), so a browser that lost access is not shown a cached copy.

const attachmentUrl = getAttachmentUrlContext();

let open = $state(false);
let shown = $state<{ ref: Shown; n: number } | null>(null);

function show(ref: Shown, n: number) {
  shown = { ref, n };
  open = true;
}
</script>

<ul class={cn("flex flex-wrap gap-2", className)} aria-label="Images">
  {#each attachments as ref, i (ref.id)}
    <li>
      <AttachmentThumb
        src={attachmentUrl(runId, ref.id)}
        label={label(ref, i + 1)}
        {size}
        onopen={() => show(ref, i + 1)}
      />
      {#if size === "preview" && ref.alt}
        <p class="text-muted-foreground mt-1 max-w-80 text-xs">{ref.alt}</p>
      {/if}
    </li>
  {/each}
</ul>

<Dialog.Root bind:open>
  <Dialog.Content class="w-auto p-3 sm:max-w-[min(90vw,72rem)]">
    {#if shown}
      <Dialog.Title class="sr-only">{label(shown.ref, shown.n)}</Dialog.Title>
      <img
        src={attachmentUrl(runId, shown.ref.id)}
        alt={label(shown.ref, shown.n)}
        class="max-h-[85vh] max-w-full rounded-md object-contain"
      />
    {/if}
  </Dialog.Content>
</Dialog.Root>
