<script lang="ts">
import type { Attachment } from "svelte/attachments";

let { text }: { text: string } = $props();

let open = $state(false);
/** The text runs past the slip's shut height, so there is more to unfold. */
let cut = $state(false);

const measure: Attachment<HTMLElement> = (slip) => {
  const check = () => {
    // Measured shut only: open, the slip is as tall as its text and says nothing.
    if (!open) cut = slip.scrollHeight > slip.clientHeight + 1;
  };
  check();
  const observer = new ResizeObserver(check);
  observer.observe(slip);
  return () => observer.disconnect();
};
</script>

<!-- What the agent wrote down, as it wrote it: a slip of yellow paper with one corner folded over.
     A long one is torn off short, with a zig-zag edge, and unfolds in full on a click. The slip
     stays text, to be read and copied; the click is a shortcut, and the button under it the way in
     for a keyboard. Raised over the row's own link, which would otherwise take the click. -->
<div class="relative z-10 my-0.5 flex flex-col items-start gap-1">
  <div class="relative w-full drop-shadow-xs">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      {@attach measure}
      class={[
        "slip bg-paper text-paper-foreground rounded-sm px-3 pt-2.5 pr-5 font-mono text-xs leading-relaxed whitespace-pre-wrap",
        // Shut, six and a half lines: the tear runs through the middle of one, so it reads as torn.
        open ? "pb-2.5" : "max-h-[calc(0.625rem_+_6.5lh)] overflow-hidden",
        cut && !open ? "torn cursor-pointer pb-3" : "pb-2.5",
      ]}
      onclick={() => {
        // A click that ended a selection was the reader copying, not asking for more.
        if (cut && !open && (window.getSelection()?.toString() ?? "") === "") open = true;
      }}
    >
      {text}
    </div>
    <span
      aria-hidden="true"
      class="bg-paper-fold pointer-events-none absolute top-0 right-0 size-3 rounded-bl-[3px] [clip-path:polygon(0_0,100%_100%,0_100%)]"
    ></span>
  </div>
  {#if cut || open}
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      {open ? "Show less" : "Show all"}
    </button>
  {/if}
</div>

<style>
/* The corner the fold is drawn over, cut off the slip itself. */
.slip {
  clip-path: polygon(0 0, calc(100% - 0.75rem) 0, 100% 0.75rem, 100% 100%, 0 100%);
}

/* Torn off: the bottom edge a row of 8px teeth, 4px deep. */
.torn {
  --tooth: 8px;
  mask:
    linear-gradient(#000 0 0) top / 100% calc(100% - var(--tooth) / 2) no-repeat,
    conic-gradient(from -45deg at bottom, #0000, #000 1deg 89deg, #0000 90deg) bottom /
    var(--tooth) calc(var(--tooth) / 2) repeat-x;
}
</style>
