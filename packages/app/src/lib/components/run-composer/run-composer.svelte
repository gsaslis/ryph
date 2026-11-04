<script module lang="ts">
/** The message box's outline on screen: what something standing in for it has to match. */
export type ComposerBox = { rect: DOMRect; radius: string };
</script>

<script lang="ts">
import { ATTACHMENT_MIMES, deleteAttachment, uploadAttachment } from "$lib/api/attachments";
import * as InputGroup from "$lib/components/ui/input-group";
import { Button } from "$lib/components/ui/button";
import RunContext from "$lib/components/run-context/run-context.svelte";
import type { ContextUsage } from "$lib/components/run-context/context-usage";
import { Spinner } from "$lib/components/ui/spinner";
import CornerDownLeftIcon from "@lucide/svelte/icons/corner-down-left";
import ImagePlusIcon from "@lucide/svelte/icons/image-plus";
import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import XIcon from "@lucide/svelte/icons/x";
import { onMount, untrack } from "svelte";
import { toast } from "svelte-sonner";
import { ComposerImages } from "./composer-images.svelte";
import { clearSentDraft, readDraft, saveDraft } from "./draft";

let {
  runId,
  draftKey,
  agentName,
  onSend,
  onSent,
  variant = "dock",
  sendLabel = "Send",
  canAddImages = true,
  sendsFiles = false,
  prefill = null,
  uploadRefused,
  concealed = false,
  contextUsage,
  height = $bindable(0),
}: {
  /** The run the box speaks to, which every image is uploaded to as it is added. The page keys
   * the box on it: another run is another box, with fresh image uploads. */
  runId: string;
  /** Local text storage, scoped to the signed-in person and task. Fixed for this box's lifetime. */
  draftKey: string;
  agentName: string;
  /** Delivers the message; a rejection keeps the draft and its images and is shown as a toast.
   * `files` are the images' own files, in the same order, for a send that uploads them anew. */
  onSend: (text: string, attachmentIds: string[], files: File[]) => Promise<void>;
  /**
   * After a message went out and the box let go of it, with where the box was on screen. Only
   * now may the box go away: until it has cleared them, the images it holds are its to take
   * back, and a box unmounted with them still held deletes them. `box` is null once the box is
   * off the page already (another task was opened while it sent).
   */
  onSent?: (box: ComposerBox | null) => void;
  /**
   * `dock` is the box stuck to the bottom of the window under a transcript. `prompt` is the
   * first message of a task that has none yet: in the flow, taller, focused, and asking.
   */
  variant?: "dock" | "prompt";
  /** What the send button does, for its tooltip and its label. */
  sendLabel?: string;
  /** Off where the run can take no more uploads: the images already in the box stay. */
  canAddImages?: boolean;
  /**
   * The send takes the images' files somewhere else (a task started again, whose box uploads
   * them anew), so how their uploads to this run went does not matter: the box is ready once it
   * holds something, and an upload that failed here is not shown as one.
   */
  sendsFiles?: boolean;
  /** What the box starts with: a draft and its images, brought from a task started again. Read
   * once, when the box is made; the images upload to this run as if just added. */
  prefill?: { text: string; files: readonly File[] } | null;
  /** Words an upload's refusal in the page's own terms, or null to show the server's. */
  uploadRefused?: (e: unknown) => string | null;
  /** Laid out but not drawn: something else is standing in for it while it moves into place. */
  concealed?: boolean;
  /** Undefined hides the gauge; null means usage is not yet available. Docked composer only. */
  contextUsage?: ContextUsage | null;
  /**
   * How tall the box is, bound rather than guessed: the textarea is `field-sizing-content`, so it
   * grows line by line as a message is typed, and a transcript that follows its tail to the bottom
   * of the page needs to know that bottom moved.
   */
  height?: number;
} = $props();

const storageKey = untrack(() => draftKey);
let draft = $state(untrack(() => prefill?.text ?? ""));
// Read only after hydration; server rendering never knows browser-local drafts.
onMount(() => {
  draft = readDraft(storageKey) ?? draft;
  saveDraft(storageKey, draft);
});
let sending = $state(false);
let box = $state<HTMLElement | null>(null);
let textarea = $state<HTMLTextAreaElement | null>(null);
const prompting = $derived(variant === "prompt");
const label = $derived(
  prompting ? `What would you like ${agentName} to do?` : `Send a message to ${agentName}`,
);

/** Where the box is on screen and how round it is, its images aside. */
export function boxShape(): ComposerBox | null {
  if (box === null) return null;
  return { rect: box.getBoundingClientRect(), radius: getComputedStyle(box).borderRadius };
}

// Each run gets a fresh box: make it ready to type in when the task opens, without
// moving the transcript's scroll position or taking focus back on message updates.
$effect(() => {
  textarea?.focus({ preventScroll: true });
});

const images = new ComposerImages(
  async (file, onProgress, signal) => {
    try {
      return await uploadAttachment(runId, file, { onProgress, signal });
    } catch (e) {
      const worded = uploadRefused?.(e) ?? null;
      throw worded === null ? e : new Error(worded);
    }
  },
  (id) => deleteAttachment(fetch, runId, id),
);
untrack(() => {
  if (prefill) take(prefill.files);
});
// The previews are object URLs, held until released, and an upload still going has nobody left
// to send it.
$effect(() => () => images.dispose());

const hasImages = $derived(images.items.length > 0);
const uploadsDone = $derived(sendsFiles || (images.settled && images.ready));
const canSend = $derived(!sending && uploadsDone && (draft.trim() !== "" || hasImages));
const failures = $derived(
  sendsFiles ? [] : images.items.filter((image) => image.state === "failed"),
);

async function send() {
  if (!canSend) return;
  const sentDraft = draft;
  const text = sentDraft.trim();
  sending = true;
  try {
    await onSend(text, images.ids, images.files);
    clearSentDraft(storageKey, sentDraft);
    draft = "";
    images.clear();
    onSent?.(boxShape());
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to send the message");
  } finally {
    sending = false;
  }
}

function take(files: Iterable<File>) {
  if (!canAddImages) return;
  for (const problem of images.add(files)) toast.error(problem);
}

function onkeydown(event: KeyboardEvent) {
  // Enter sends; Shift+Enter is a newline, as in every chat box.
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
}

// A pasted screenshot arrives as a file with no text beside it. Something copied with text as
// well (a cell from a spreadsheet, a passage from a document, which often bring a rendering of
// themselves along) is pasted as the text, which is what the person meant.
function onpaste(event: ClipboardEvent) {
  const data = event.clipboardData;
  if (
    !canAddImages || data === null || data.files.length === 0 ||
    data.getData("text/plain") !== ""
  ) return;
  event.preventDefault();
  take(data.files);
}

// Dropping files anywhere on the box. A counter rather than a flag, because dragenter and
// dragleave fire for every child the pointer crosses.
let dragDepth = $state(0);
const carriesFiles = (event: DragEvent) =>
  canAddImages && (event.dataTransfer?.types.includes("Files") ?? false);

function ondragenter(event: DragEvent) {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth++;
}
function ondragover(event: DragEvent) {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}
function ondragleave(event: DragEvent) {
  if (!carriesFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
}
function ondrop(event: DragEvent) {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  if (event.dataTransfer) take(event.dataTransfer.files);
}

let picker = $state<HTMLInputElement>();

function onpick(event: Event & { currentTarget: HTMLInputElement }) {
  const input = event.currentTarget;
  if (input.files) take(input.files);
  // Picking the same file again should add it again, which a held value would swallow.
  input.value = "";
}
</script>

<!-- Docked at the bottom of the window, so it is in reach wherever the transcript is scrolled to.
     Two halves make that hold. It is the last thing in the task column, which is never shorter
     than the window (`TaskColumn`), and the transcript above it grows to fill the column: on a
     short run that alone puts it on the bottom of the window. On a long one it is `sticky` there.
     Still in flow either way: at the end of the page it is the last thing on it, which is what the
     transcript's follow-the-tail measures against. The negative bottom margin takes back the
     page's bottom gutter, so at the end it rests where it sticks rather than a gutter higher; the
     negative top margin tightens the gap the page puts above it, which its own top padding and
     fade already provide. `--bleed` takes the background out to the panel's edges and the padding
     brings the box back onto the column, as the task page's masthead does: a row's card bleeds
     past the column, and scrolled under a column-wide background its edge showed beside the box. -->
<div
  bind:clientHeight={height}
  class={prompting
  ? "w-full"
  : "bg-background sticky bottom-0 z-10 flex items-end gap-2 -mx-(--bleed) -mt-4 -mb-(--page-gutter-y) px-(--bleed) pt-2 pb-4 [--bleed:calc((100cqw_-_100%)_/_2_+_var(--page-gutter))] before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-8 before:bg-linear-to-t before:from-background before:to-transparent"}
>
  <form
    class={["flex min-w-0 flex-1 flex-col gap-2", concealed && "opacity-0"]}
    onsubmit={(event) => {
      event.preventDefault();
      void send();
    }}
    {ondragenter}
    {ondragover}
    {ondragleave}
    {ondrop}
  >
    {#if hasImages}
      <ul class="flex flex-wrap gap-2" aria-label="Images to send">
        {#each images.items as image (image.key)}
          {@const shown = sendsFiles ? "done" : image.state}
          <li
            class={[
              "bg-muted relative size-14 overflow-hidden rounded-md border",
              shown === "failed" && "border-destructive",
            ]}
            title={sendsFiles ? image.name : (image.error ?? image.name)}
          >
            <img
              src={image.preview}
              alt={image.name}
              class={["size-full object-cover", shown !== "done" && "opacity-50"]}
            />
            {#if shown === "uploading"}
              <div
                class="bg-background/70 absolute inset-x-1 bottom-1 h-1 overflow-hidden rounded-full"
                role="progressbar"
                aria-label="Uploading {image.name}"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(image.progress * 100)}
              >
                <div
                  class="bg-primary h-full transition-[width]"
                  style:width="{image.progress * 100}%"
                ></div>
              </div>
            {:else if shown === "failed"}
              <button
                type="button"
                class="text-destructive hover:text-foreground focus-visible:ring-ring absolute inset-0 flex items-center justify-center outline-none focus-visible:ring-2"
                aria-label="Retry {image.name}"
                onclick={() => images.retry(image.key)}
              >
                <RotateCwIcon class="size-4" />
              </button>
            {/if}
            <button
              type="button"
              class="bg-background/80 hover:bg-background focus-visible:ring-ring absolute top-0.5 right-0.5 rounded-full p-0.5 outline-none focus-visible:ring-2"
              aria-label="Remove {image.name}"
              onclick={() => images.remove(image.key)}
            >
              <XIcon class="size-3" />
            </button>
          </li>
        {/each}
      </ul>
      {#if failures.length > 0}
        <ul class="text-destructive flex flex-col gap-0.5 text-xs">
          {#each failures as image (image.key)}
            <li class="flex items-center gap-1">
              <TriangleAlertIcon class="size-3 shrink-0" />
              <span class="truncate">{image.name}: {image.error}</span>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
    <InputGroup.Root
      bind:ref={box}
      class={[
        "bg-background",
        prompting
          ? "rounded-xl shadow-sm"
          : "rounded-[calc(min(var(--radius-md),10px)+5px)] md:rounded-[calc(min(var(--radius-md),10px)+3px)]",
        dragDepth > 0 && "border-ring ring-ring/50 ring-3",
      ]}
    >
      <InputGroup.Textarea
        bind:ref={textarea}
        bind:value={draft}
        oninput={(event) => saveDraft(storageKey, event.currentTarget.value)}
        rows={prompting ? 3 : 1}
        class={prompting
        ? "max-h-[50svh] min-h-24 px-4 py-3 md:text-[0.9375rem] md:leading-6"
        : "max-h-60 min-h-0"}
        disabled={sending}
        placeholder={prompting ? "Describe the task" : label}
        aria-label={label}
        {onkeydown}
        {onpaste}
      />
      <InputGroup.Addon
        align="inline-end"
        class={[
          "self-end",
          prompting ? "pr-3 pb-3" : "h-[calc(1lh+1rem)] py-0 text-base md:pr-1.5 md:text-sm",
        ]}
      >
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={sending || !canAddImages}
          aria-label="Add images"
          title="Add images"
          onclick={() => picker?.click()}
        >
          <ImagePlusIcon />
        </Button>
        <!-- On the first message the button stays, so the way to send is plain from the start. -->
        {#if prompting || sending || draft.trim() !== "" || hasImages}
          <Button
            type="submit"
            size="icon-sm"
            variant="ghost"
            disabled={!canSend}
            aria-label={sendLabel}
            title={uploadsDone
              ? `${sendLabel} (Enter)`
              : !images.settled
              ? "Waiting for images to upload"
              : "Retry or remove the images that failed"}
          >
            {#if sending}<Spinner />{:else}<CornerDownLeftIcon />{/if}
          </Button>
        {/if}
      </InputGroup.Addon>
    </InputGroup.Root>
    <input
      bind:this={picker}
      type="file"
      accept={ATTACHMENT_MIMES.join(",")}
      multiple
      hidden
      onchange={onpick}
    />
  </form>
  {#if !prompting && contextUsage !== undefined}
    <!-- Match one textarea line plus its vertical padding and the box's borders, so the gauge
         stays centered beside an empty box and holds that position as the draft grows. -->
    <div
      class={[
        "flex h-[calc(1lh+1rem+2px)] shrink-0 items-center text-base md:text-sm",
        concealed && "opacity-0",
      ]}
    >
      <RunContext usage={contextUsage} />
    </div>
  {/if}
</div>
