<script lang="ts">
import type { ResultImage } from "$lib/api/types";
import { renderMarkdown } from "$lib/utils/markdown";
import AttachmentImages from "$lib/components/attachment-images/attachment-images.svelte";
import CodeView from "$lib/components/code-view/code-view.svelte";
import { getAllContexts, mount, unmount, untrack } from "svelte";

let { content, breaks = true, compact = false, images, imageRunId, class: className = "" }: {
  content: string;
  /** Every newline a line break: true for a message, false for a hard-wrapped document. */
  breaks?: boolean;
  /** Smaller type and tighter spacing, for a narrow card rather than a page. */
  compact?: boolean;
  /**
   * The images the agent took with its tools that this text may show, by the ref it wrote them
   * as (`![alt](img-…)`). Each is drawn where it was written; a ref not among them reads as its
   * alt text. Left out, every image stays as the markdown the agent wrote.
   */
  images?: { runId: string; refs: readonly ResultImage[] };
  /** Transcript images resolve by ref on this run, independently of loaded tool events. */
  imageRunId?: string;
  class?: string;
} = $props();

const byRef = $derived(new Map(images?.refs.map((image) => [image.ref, image]) ?? []));

// A `$derived` rather than an effect, so it runs on both sides of the wire — SSR renders the load's
// snapshot, the live tail hands over new blocks in the browser. Safe to hand to `{@html}` because
// of how it is rendered; see the note there.
const html = $derived(
  renderMarkdown(content, {
    breaks,
    imageRefs: imageRunId !== undefined
      ? "run"
      : images === undefined
      ? undefined
      : new Set(byRef.keys()),
  }),
);

// What is mounted below is mounted outside this component's tree, so it is handed the page's
// contexts by hand: an attachment's URL comes from one (a dev preview draws its own images).
const contexts = getAllContexts();

let root = $state<HTMLDivElement | null>(null);

// Fenced blocks are highlighted by upgrading them where they stand, rather than by pulling them out
// of the markdown and rendering them as siblings. A fence is very often written inside a list item —
// the numbered install step is the whole shape of a README — and nothing at that depth can be
// lifted out without breaking the list it was indented into. So marked renders the document's
// structure whole, and each block it emitted is swapped for the real highlighter in place.
//
// This stays cheap because a message's markdown never changes: the historian stores completed
// blocks, so `content` arrives whole and is never appended to.
$effect(() => {
  const el = root;
  html; // re-run whenever the markup this is reaching into has been replaced
  if (el === null) return;

  const mounted = [...el.querySelectorAll("pre[data-code-block]")].map((shell) => {
    const props = {
      // Escaped on the way in, so this reads back exactly what the model wrote.
      code: shell.textContent ?? "",
      lang: shell.getAttribute("data-lang"),
    };
    const target = document.createElement("div");
    target.className = "my-4"; // the shell's own spacing, kept across the swap
    shell.replaceWith(target);
    return mount(CodeView, { target, props });
  });

  // An agent's own image, mounted where it wrote it, in place of the alt text that held the spot.
  // In place for the same reason a fence is: the image may sit inside a list item. Read untracked:
  // the placeholders are gone once filled, so a re-run for a fresh but equal `images` (the task
  // detail is re-fetched) would take the pictures down and find nothing to put back. Which refs
  // have a picture is in `html` already, and a change there re-runs this.
  const { runId, known, transcript } = untrack(() => ({
    runId: imageRunId ?? images?.runId,
    known: byRef,
    transcript: imageRunId !== undefined,
  }));
  const pictures = runId === undefined ? [] : [...el.querySelectorAll("span[data-image-ref]")]
    .flatMap((holder) => {
      const ref = holder.getAttribute("data-image-ref") ?? "";
      const image = known.get(ref);
      if (image === undefined && !transcript) return [];
      const target = document.createElement("span");
      target.className = "not-prose my-2 inline-block max-w-full align-top";
      holder.replaceWith(target);
      return [
        mount(AttachmentImages, {
          target,
          context: contexts,
          props: {
            runId,
            attachments: [{
              id: image?.attachmentId ?? ref,
              alt: image?.alt ?? holder.textContent ?? "Image",
            }],
            size: transcript ? "thumbnail" : "preview",
          },
        }),
      ];
    });

  return () => {
    for (const view of [...mounted, ...pictures]) void unmount(view);
  };
});
</script>

<!--
  prose-code:* is the inline-code chip — a quiet tinted highlight.
  The `before/after:content-none` pair is load-bearing: the typography plugin renders literal
  backticks around every <code> by default, which read as typos once there is a background behind
  them. Fenced blocks never reach these styles: they carry `not-prose`, both as the shell marked
  emits and as what replaces it.
-->
<div
  bind:this={root}
  class:prose-compact={compact}
  class="prose prose-sm dark:prose-invert prose-code:bg-muted prose-code:text-foreground prose-code:rounded-md prose-code:px-1.5 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none max-w-none wrap-anywhere {className}"
>
  {@html html}
</div>
