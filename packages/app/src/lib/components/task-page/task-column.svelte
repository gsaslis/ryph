<script lang="ts">
import type { Snippet } from "svelte";
import type { Attachment } from "svelte/attachments";

let { children }: { children: Snippet } = $props();

/**
 * Where the column starts on the page, which is everything the window shows above it: the app's
 * bar, the panel's top edge, the page gutter. It moves when something above it does, so a change in
 * the page's size or the window's reads it again.
 */
const measureTop: Attachment<HTMLElement> = (el) => {
  const fit = () => {
    const top = el.getBoundingClientRect().top + window.scrollY;
    el.style.setProperty("--column-top", `${top}px`);
  };
  fit();
  const observer = new ResizeObserver(fit);
  observer.observe(document.body);
  window.addEventListener("resize", fit, { passive: true });
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", fit);
  };
};
</script>

<!-- The task page's column: the masthead, then the transcript or the question in its place. At
     least as tall as the rest of the window, so the page is never shorter than the window: what
     ends the column (the message box, docked) rests on the bottom of the window however little is
     above it, and the question in the middle of an empty task sits in the middle of the window.
     Below the column are the page's bottom gutter and, from md up, the panel's bottom edge
     (`--panel-cap`, the panel's margin and border); taking both off makes the page exactly the
     window's height when the column has room to spare. Before the browser has measured, the column
     is laid out from the top of the document, which errs tall and never short. -->
<div
  {@attach measureTop}
  class="flex min-h-[calc(100svh_-_var(--column-top,0px)_-_var(--page-gutter-y))] flex-col gap-6 md:min-h-[calc(100svh_-_var(--column-top,0px)_-_var(--page-gutter-y)_-_var(--panel-cap))] md:gap-8"
>
  {@render children()}
</div>
