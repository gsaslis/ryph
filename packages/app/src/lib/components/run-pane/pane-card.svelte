<script lang="ts">
import type { Snippet } from "svelte";
import type { Attachment } from "svelte/attachments";

let { children, clip = true }: {
  children: Snippet;
  /** Shut a long card at a fixed height, faded out, to be opened on a click. */
  clip?: boolean;
} = $props();

let open = $state(false);
/** The text runs past the card's shut height, so there is more to show. */
let cut = $state(false);

const measure: Attachment<HTMLElement> = (card) => {
  const check = () => {
    if (!open) cut = clip && card.scrollHeight > card.clientHeight + 1;
  };
  check();
  const observer = new ResizeObserver(check);
  observer.observe(card);
  return () => observer.disconnect();
};

/** A click anywhere on a cut card opens it, unless it was on a link or ended a text selection. */
function onclick(event: MouseEvent) {
  if (!cut && !open) return;
  if ((event.target as Element).closest("a, button") !== null) return;
  if ((window.getSelection()?.toString() ?? "") !== "") return;
  open = !open;
}
</script>

<!-- What an item in the timeline holds, on a card of its own: a comment as it reads on the forge,
     a patch's description, a suite's checks. A long one fades out and opens in full on a click. Raised over the row's own link, which would
     otherwise take the click. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class={[
    "bg-background relative z-10 my-0.5 flex flex-col rounded-md border",
    (cut || open) && "cursor-pointer",
  ]}
  {onclick}
>
  <div
    {@attach measure}
    class={[
      "flex flex-col gap-2 px-3 py-2.5",
      clip && !open && "max-h-48 overflow-hidden",
      cut && !open && "mask-b-from-60%",
    ]}
  >
    {@render children()}
  </div>
  {#if cut || open}
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground self-start px-3 pb-2 text-xs underline-offset-4 hover:underline"
      aria-expanded={open}
      onclick={(event) => {
        event.stopPropagation();
        open = !open;
      }}
    >
      {open ? "Show less" : "Show all"}
    </button>
  {/if}
</div>
