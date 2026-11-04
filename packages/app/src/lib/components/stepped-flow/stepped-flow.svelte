<script lang="ts" module>
export interface FlowStepItem {
  id: string;
  /** The step's name in the list. */
  label: string;
  /** Its heading above the content, and the line under that. */
  heading: string;
  description?: string;
  /** `done` wears a check, `problem` a mark, `todo` its number. */
  status: "todo" | "done" | "problem";
}
</script>

<script lang="ts">
import { sidebarMenuButtonVariants } from "$lib/components/ui/sidebar/sidebar-menu-button.svelte";
import { cn } from "$lib/utils";
import RyphLogo from "$lib/components/ryph-logo/ryph-logo.svelte";
import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
import CheckIcon from "@lucide/svelte/icons/check";
import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
import { flushSync, type Snippet, untrack } from "svelte";
import { requestToastPosition } from "$lib/utils/toast-position.svelte";
import { viewTransitionsEnabled } from "$lib/utils/view-transition";

let {
  title,
  cancelHref,
  oncancel,
  steps,
  current,
  select,
  children,
  footer,
}: {
  /** What the flow is for, above the steps — "New agent". */
  title: string;
  /** Where leaving the flow goes: the page it was opened from, one view up. */
  cancelHref: string;
  /** Called as the logo leaves the flow, before the move: the welcome notes it was skipped. */
  oncancel?: () => void;
  steps: FlowStepItem[];
  /** The id of the step on screen. */
  current: string;
  /** Asked to show another step: the list is free to move in any order. */
  select: (id: string) => void;
  /** The steps' content, handed the step to show. Every step is rendered and the caller hides
   * all but that one, so a step's own state — a probe's answer, a picked file — survives leaving
   * and coming back. */
  children: Snippet<[shown: string]>;
  footer?: Snippet;
} = $props();

// The footer's buttons sit bottom right, where toasts would cover them: up top while a flow is open.
$effect(() => requestToastPosition("top-right"));

// The step on screen follows `current` one beat behind, so the swap can run inside a view
// transition: the old step's content goes and the new one's comes, as a page's does, while the
// shell around it stands still. Any change of `current` — a click, the browser's back button —
// comes through here, so both move the same way. The page is scrolled to the top with it: each
// step starts at its start, and a named element captured mid-scroll would otherwise fly.
// svelte-ignore state_referenced_locally
let shown = $state(current);
$effect.pre(() => {
  const next = current;
  if (next === untrack(() => shown)) return;
  const swap = () => {
    shown = next;
    flushSync();
    window.scrollTo({ top: 0 });
  };
  if (!viewTransitionsEnabled()) {
    swap();
    return;
  }
  // The same terms as a page re-asking for itself: the root stands still, named content moves.
  document.documentElement.dataset.navigation = "same-page";
  const transition = document.startViewTransition(swap);
  void transition.finished.finally(() => {
    delete document.documentElement.dataset.navigation;
  });
});

const step = $derived(steps.find((s) => s.id === shown));

// Keeps the step on screen in view where the list scrolls sideways (below md, as a bar across the
// top): on arrival without motion, after that with it. Scrolls the list alone, never the page.
let stepList = $state<HTMLOListElement>();
let listPlaced = false;
$effect(() => {
  const list = stepList;
  const item = list?.querySelector<HTMLElement>(`[data-step="${CSS.escape(current)}"]`);
  if (!list || !item || list.scrollWidth <= list.clientWidth) return;
  list.scrollTo({
    left: item.offsetLeft - (list.clientWidth - item.offsetWidth) / 2,
    behavior: listPlaced ? "smooth" : "instant",
  });
  listPlaced = true;
});

// Marks pop in when they change, not when the page arrives: an editor's five checks on load
// are the state of things, not news. Set once the first render is on screen.
let settled = $state(false);
$effect(() => {
  settled = true;
});
</script>

<!-- The app's shell, redrawn for a flow: the column the nav sits in, at the nav's width and
     padding, with the logo in the slot it has on every other page and the steps where the nav
     items go; and the content on the panel beside it, framed as the app's pages are. The column
     is named as the nav is, so a move from a page into the flow keeps the logo where it was and
     only the column's contents change under it. Below md the column becomes a bar across the top
     and the steps run along it. -->
<div class="bg-sidebar flex min-h-svh w-full flex-col md:flex-row">
  <aside
    class="flex shrink-0 flex-col p-2 [view-transition-name:sidebar] md:sticky md:top-0 md:h-svh md:w-64"
  >
    <div class="flex flex-col gap-2 p-2">
      <!-- The logo leaves the flow, as Cancel does: back to where it was opened from. On a
           pointer it says so when hovered or focused; on a phone the footer's Cancel says it. -->
      <a
        href={cancelHref}
        onclick={oncancel}
        aria-label="Cancel"
        class={cn(sidebarMenuButtonVariants({ size: "lg" }), "group/logo h-10 overflow-visible")}
      >
        <!-- Both faces stacked in one cell and crossfaded, so the swap neither jumps nor reflows.
             Not clipped, as the button's last span otherwise is (for long labels): the logo's blob
             bulges past its box. The logo sits 8px left of the button's padding, where the app's
             sidebar puts it, so the morph between the two keeps it in place; named `ryph-logo` so a view
             transition holds it there (see layout.css). -->
        <span class="grid overflow-visible!">
          <span
            class="col-start-1 row-start-1 flex items-center gap-2 transition-opacity duration-200 md:group-hover/logo:opacity-0 md:group-focus-visible/logo:opacity-0"
          >
            <RyphLogo class="h-7! w-auto! -translate-x-2 [view-transition-name:ryph-logo]" />
            <span class="sr-only">Ryph</span>
          </span>
          <span
            aria-hidden="true"
            class="col-start-1 row-start-1 flex items-center gap-2 opacity-0 transition-opacity duration-200 max-md:hidden md:group-hover/logo:opacity-100 md:group-focus-visible/logo:opacity-100"
          >
            <ArrowLeftIcon />
            <span class="text-base font-semibold tracking-tight">Cancel</span>
          </span>
        </span>
      </a>
    </div>
    <nav aria-label="Steps" class="flex min-h-0 flex-1 flex-col gap-2 md:overflow-auto">
      <div class="flex flex-col p-2">
        <div
          class="text-sidebar-foreground/70 flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium"
        >
          {title}
        </div>
        <ol
          bind:this={stepList}
          class="relative flex min-w-0 gap-1 max-md:overflow-x-auto md:w-full md:flex-col"
        >
          {#each steps as item, index (item.id)}
            {@const active = item.id === current}
            <li data-step={item.id} class="relative max-md:shrink-0">
              <button
                type="button"
                data-active={active}
                aria-current={active ? "step" : undefined}
                class={cn(sidebarMenuButtonVariants(), "cursor-pointer max-md:w-auto")}
                onclick={() => select(item.id)}
              >
                <!-- Keyed on the status so a change remounts the mark and its pop-in runs;
                     the number never pops, it is what a step starts as. -->
                {#key item.status}
                  <span
                    class={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-medium tabular-nums motion-reduce:animate-none",
                      item.status === "done" && "bg-primary text-primary-foreground",
                      item.status === "problem" && "bg-destructive text-white",
                      item.status === "todo" && "ring-border text-muted-foreground ring-1",
                      settled && item.status !== "todo" && "animate-pop-in",
                    )}
                  >
                    {#if item.status === "done"}
                      <CheckIcon class="size-3!" />
                    {:else if item.status === "problem"}
                      <CircleAlertIcon class="size-3!" />
                    {:else}
                      {index + 1}
                    {/if}
                  </span>
                {/key}
                <span class="truncate">{item.label}</span>
              </button>
            </li>
          {/each}
        </ol>
      </div>
    </nav>
  </aside>

  <main
    class="bg-background relative flex w-full min-w-0 flex-1 flex-col md:m-2 md:ml-0 md:rounded-xl md:border md:shadow-sm"
  >
    <div class="flex flex-1 flex-col px-4 py-6 md:px-6 md:py-8">
      <div
        class="flex w-full flex-col gap-8 [[data-navigation=same-page]_&]:[view-transition-name:step-content]"
      >
        {#if step}
          <header class="flex max-w-2xl flex-col gap-1">
            <h1 class="font-heading text-2xl leading-tight font-bold tracking-[-0.02em]">{step.heading}</h1>
            {#if step.description}
              <p class="text-muted-foreground text-sm">{step.description}</p>
            {/if}
          </header>
        {/if}
        {@render children(shown)}
      </div>
    </div>
    {#if footer}
      <!-- Pinned to the bottom of the viewport while a long step scrolls, and to the panel's own
           end once it is reached; its corners follow the panel's, one border-width in. Named for
           the step transition so it is its own layer above the sliding content: a step's old
           content runs under the footer, and a named element is painted over the root's image,
           where an unnamed footer would live. -->
      <footer
        class="bg-background sticky bottom-0 mt-auto flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 md:px-6 md:py-4 md:rounded-b-[calc(var(--radius-xl)-1px)] [[data-navigation=same-page]_&]:[view-transition-name:step-footer]"
      >
        {@render footer()}
      </footer>
    {/if}
  </main>
</div>
