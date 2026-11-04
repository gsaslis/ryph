<script lang="ts">
import JumpToBottom from "$lib/components/run-transcript/jump-to-bottom.svelte";
import type { JobTone } from "$lib/utils/background";
import type { Snippet } from "svelte";
import type { OutputBuffer } from "./commands-view";
import { type LinesChange, lineTone, type OutputLine, OutputLines } from "./output-lines";

let {
  buffer,
  command,
  wrap = true,
  running = false,
  ended = null,
  empty: placeholder,
  class: className,
}: {
  /** The job's output: live as it arrives, or a stored log held whole. Drawn as text only. */
  buffer: OutputBuffer;
  /** What was run, shown as the prompt the output follows. */
  command: string;
  /** Long lines wrap, under a hanging indent, rather than scroll sideways. */
  wrap?: boolean;
  /** Still writing: a caret marks where the next output lands. */
  running?: boolean;
  /** How it ended, said beneath the output: "Exited 1 after 1m 42s". */
  ended?: { text: string; tone: JobTone } | null;
  /** What stands in while there is no output. */
  empty: Snippet;
  class?: string;
} = $props();

// Polling replaces the job record behind this prop, not its buffer. Only a different buffer
// should reattach the renderer: reattaching redraws every line and jumps back to the end.
const output = $derived(buffer);
const attachment = $derived(draw(output));

let empty = $state(true);
/** The reader has scrolled up, away from the end. */
let away = $state(false);
let scroller = $state<HTMLElement | null>(null);

/** How close to the end still counts as being there, in pixels. */
const AT_END = 24;

const TONE_CLASS = { error: "text-destructive", success: "text-success" } as const;

function paint(el: HTMLElement, line: OutputLine) {
  if (el.textContent !== line.text) el.textContent = line.text;
  const tone = line.note ? null : lineTone(line.text);
  el.className = [
    "command-line",
    line.note ? "text-muted-foreground italic" : tone === null ? "" : TONE_CLASS[tone],
  ].join(" ");
}

function toEnd() {
  if (scroller === null) return;
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
}

/**
 * Draws the buffer as lines into the box's line list and keeps it drawn: a chunk that arrives
 * redraws only the lines it touched, and lines leave the top as the buffer lets output go, so
 * nothing is drawn twice. Follows the end while the reader is there; scrolled up, it holds their
 * place, even as old output leaves above them.
 */
function draw(source: OutputBuffer) {
  return (box: HTMLElement) => {
    const list = box.querySelector("[data-lines]") as HTMLElement;
    const lines = new OutputLines();
    let atEnd = true;
    let frame = 0;
    const onScroll = () => {
      atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < AT_END;
      if (away === atEnd) away = !atEnd;
    };
    const follow = () => {
      if (frame !== 0 || !atEnd) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (atEnd) box.scrollTop = box.scrollHeight;
      });
    };
    const apply = (change: LinesChange) => {
      const before = box.scrollHeight;
      for (let i = 0; i < change.dropped; i++) list.firstElementChild?.remove();
      const els = list.children;
      for (let i = change.from; i < lines.lines.length; i++) {
        let el = els[i] as HTMLElement | undefined;
        if (el === undefined) {
          el = document.createElement("div");
          list.append(el);
        }
        paint(el, lines.lines[i]);
      }
      while (els.length > lines.lines.length) list.lastElementChild?.remove();
      if (change.dropped > 0 && !atEnd) box.scrollTop -= before - box.scrollHeight;
    };

    list.replaceChildren();
    apply(lines.reset(source.chunks));
    empty = source.chars === 0;
    away = false;
    box.scrollTop = box.scrollHeight;

    const unsubscribe = source.subscribe((change) => {
      if (change.kind === "append") apply(lines.append(change.chunk));
      else if (change.kind === "trim") apply(lines.trim(change.count));
      else apply(lines.reset(source.chunks));
      const nothing = source.chars === 0;
      if (nothing !== empty) empty = nothing;
      follow();
    });
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
      box.removeEventListener("scroll", onScroll);
    };
  };
}
</script>

<div class={["relative flex min-h-0 flex-col", className]}>
  <div
    bind:this={scroller}
    {@attach attachment}
    class="scroll-fade-y flex min-h-0 flex-1 flex-col overflow-auto overscroll-contain bg-linear-to-b from-card from-[calc(100%-3rem)] to-transparent"
  >
    <div
      class={[
        "command-output text-foreground/90 px-4 py-3 font-mono text-[0.75rem] leading-[1.6]",
        wrap ? "wrap" : "w-max min-w-full",
      ]}
    >
      <!-- The prompt: what was run, so the output reads as it would in a terminal. -->
      <div class="command-line text-foreground mb-1 font-medium">
        <span class="text-muted-foreground select-none" aria-hidden="true">{"$ "}</span><bdi>{command}</bdi>
      </div>
      <div data-lines></div>
      {#if running && !empty}
        <span
          class="command-caret bg-foreground/60 inline-block h-[1.1em] w-[0.55em] translate-y-[0.2em] rounded-[1px]"
          aria-hidden="true"
        ></span>
      {/if}
      {#if ended !== null}
        <p
          class={[
            "mt-2 border-t border-dashed pt-2 font-sans",
            ended.tone === "failed" ? "text-destructive" : "text-muted-foreground",
          ]}
        >
          {ended.text}
        </p>
      {/if}
    </div>
    {#if empty}
      <div class="flex flex-1">
        {@render placeholder()}
      </div>
    {/if}
  </div>
  {#if away && !empty}
    <JumpToBottom
      class="right-4 bottom-4"
      onclick={toEnd}
      label={running ? "Follow output" : "Jump to end"}
    />
  {/if}
</div>

<style>
/* Each line a block of its own: one that wraps hangs its continuation under a small indent, so
   where a line ends stays plain. Lines are text only, set with textContent. */
.command-output :global(.command-line) {
  white-space: pre;
  min-height: 1.6em;
}
.command-output.wrap :global(.command-line) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding-left: 2ch;
  text-indent: -2ch;
}
.command-caret {
  animation: command-caret-blink 1.1s steps(1) infinite;
}
@keyframes command-caret-blink {
  50% {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .command-caret {
    animation: none;
  }
}
</style>
