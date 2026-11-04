<script lang="ts">
import { mode } from "mode-watcher";

let { code, lang = null, name = "snippet", lineNumbers = false, onready = () => {} }: {
  code: string;
  /** An explicit language, for a source with no filename to infer one from (a markdown fence). */
  lang?: string | null;
  /** The file's path. Infers the language when `lang` is absent, so prefer it when there is one. */
  name?: string;
  lineNumbers?: boolean;
  /**
   * Settled at the size it will actually be — either drawn, or fallen back for good. A caller
   * animating this into view cannot do it until then, and must not be left waiting on a failure.
   */
  onready?: () => void;
} = $props();

let host = $state<HTMLDivElement | null>(null);
// The plain block below stands in until the highlighter has actually drawn: it is what SSR emits,
// what shows if the chunk never loads, and what a fence tagged with an unknown language falls back
// to. Only ever swapped out once there is something real to swap in.
let highlighted = $state(false);

$effect(() => {
  const el = host;
  if (el === null) return;

  // Read reactive inputs before the first `await` — this effect stops tracking after it.
  const themeType = mode.current === "dark" ? "dark" : "light";
  const currentCode = code;
  const currentLang = lang;
  const currentName = name;
  const currentLineNumbers = lineNumbers;

  let disposed = false;
  let instance: { cleanUp(): void } | undefined;

  void (async () => {
    try {
      const { File } = await import("@pierre/diffs");
      if (disposed) return;

      const file = new File({
        themeType,
        disableFileHeader: true,
        disableLineNumbers: !currentLineNumbers,
        overflow: "scroll",
        // Repoint the theme's surface at the app's, rather than clearing it: nine different rules
        // paint `--diffs-bg` (code, gutters, buffers), so blanking one element just exposes the
        // others. Setting the variable moves all of them at once, and the block then matches the
        // bg-muted an inline code chip already sits on. Needed because pierre-light paints
        // #ffffff — exactly --card — so a light-mode block was invisible against its own card,
        // while dark paints #0a0a0a and separates on its own.
        //
        // Custom properties cross the shadow boundary, so --muted resolves in here; the adopted
        // core sheet is overridden because an injected <style> cascades after it. Only the surface
        // moves — the syntax colours stay entirely the theme's.
        unsafeCSS: ":host { --diffs-bg: var(--muted); }",
      });
      instance = file;
      if (disposed) return;

      file.render({
        // `name` feeds the header and language inference, and the header is off — so here it only
        // ever does inference, which is why a real path is worth passing when there is one. An
        // explicit `lang` wins where given; a source with neither renders as plain text rather
        // than being guessed at.
        file: {
          name: currentName,
          contents: currentCode,
          ...(currentLang === null ? {} : { lang: currentLang as never }),
        },
        containerWrapper: el,
      });
      if (!disposed) {
        highlighted = true;
        onready();
      }
    } catch {
      // An unsupported language, or a chunk that never arrived. The fallback block stays.
      if (!disposed) {
        highlighted = false;
        onready();
      }
    }
  })();

  return () => {
    disposed = true;
    instance?.cleanUp();
    highlighted = false;
  };
});
</script>

<!-- One surface: the wrapper's bg-muted is the same colour the renderer now paints, so it only
     backs the fallback and the rounded corners rather than framing a second panel inside itself.

     `not-prose` because this renders inside markdown prose. <diffs-container> puts its shadow root
     to work holding the adopted core sheet, but builds the actual <pre> and a <code>-per-row as its
     own light-DOM children — so typography's descendant rules reach straight in: prose paints every
     <pre> with its own slate fill (dark whatever the mode, which is why light mode looked worst),
     and the prose-code chip meant for inline `code` landed on each row of the block separately.
     This opts the whole subtree out, leaving the renderer to draw what it renders. -->
<div class="not-prose bg-muted overflow-hidden rounded-xl">
  <div bind:this={host}></div>
  {#if !highlighted}
    <pre class="overflow-x-auto p-3 font-mono text-xs whitespace-pre">{code}</pre>
  {/if}
</div>
