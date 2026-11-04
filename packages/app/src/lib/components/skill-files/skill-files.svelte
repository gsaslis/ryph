<script lang="ts">
import type { SkillFile } from "$lib/api/types";
import CodeView from "$lib/components/code-view/code-view.svelte";
import CopyButton from "$lib/components/copy-button/copy-button.svelte";
import Markdown from "$lib/components/markdown/markdown.svelte";
import { Badge } from "$lib/components/ui/badge";
import { cn } from "$lib/utils";
import { formatBytes } from "$lib/utils/environments";
import {
  readingOrder,
  resolveSkillLink,
  SKILL_FILE,
  skillBody,
  skillFileKind,
} from "$lib/utils/skills";
import FileIcon from "@lucide/svelte/icons/file";
import FileTextIcon from "@lucide/svelte/icons/file-text";
import TerminalIcon from "@lucide/svelte/icons/terminal";
import { tick } from "svelte";
import type { Attachment } from "svelte/attachments";

let { files }: { files: SkillFile[] } = $props();

const ordered = $derived(readingOrder(files));
const paths = $derived(ordered.map((f) => f.path));

// The file on screen: SKILL.md until another is picked. A pick that is no longer among the files
// (another version, with different ones) falls back the same way.
let picked = $state<string | null>(null);
const shown = $derived(
  ordered.find((f) => f.path === picked) ?? ordered.find((f) => f.path === SKILL_FILE) ??
    ordered[0],
);
const kind = $derived(shown ? skillFileKind(shown) : "binary");

// Shows a file, and takes focus and the page to it when it would otherwise change out of sight.
// A link in the markdown always does: the link is gone once the other file shows, and a link low
// in a long SKILL.md would leave focus nowhere and the new file off screen. A pick in the list does
// only when the file's header is out of view, as it is below a long list on a narrow screen;
// side by side, focus stays in the list so the next file is one key away.
let viewerHeader = $state<HTMLElement | null>(null);

function show(path: string, always: boolean) {
  picked = path;
  void tick().then(() => {
    if (!viewerHeader) return;
    if (!always) {
      const { top, bottom } = viewerHeader.getBoundingClientRect();
      if (top >= 0 && bottom <= window.innerHeight) return;
    }
    viewerHeader.focus({ preventScroll: true });
    viewerHeader.scrollIntoView({ block: "nearest" });
  });
}

// A skill's markdown links to its own files (`references/checks-yml.md`), which exist here and
// nowhere a browser could open. A click on one of those shows that file instead; any other link
// is left to open as a link.

const followSkillLinks: Attachment<HTMLElement> = (el) => {
  const onclick = (event: MouseEvent) => {
    const anchor = (event.target as Element | null)?.closest("a");
    const href = anchor?.getAttribute("href");
    if (!anchor || href == null || !shown) return;
    const target = resolveSkillLink(href, shown.path, paths);
    if (target === null) return;
    event.preventDefault();
    show(target, true);
  };
  el.addEventListener("click", onclick);
  return () => el.removeEventListener("click", onclick);
};
</script>

<!-- A skill's files: the list on one side, the file on the other, side by side once the panel is
     wide enough and stacked below that. SKILL.md is shown first, as the agent reads it. -->
<div class="grid gap-4 @3xl:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
  <nav aria-label="Files" class="flex flex-col gap-0.5">
    {#each ordered as file (file.path)}
      {@const active = file.path === shown?.path}
      {@const Icon = file.executable ? TerminalIcon : file.text === null ? FileIcon : FileTextIcon}
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        class={cn(
          "focus-visible:ring-ring/50 flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs outline-none focus-visible:ring-[3px]",
          active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        )}
        onclick={() => show(file.path, false)}
      >
        <Icon class="mt-px size-3.5 shrink-0 self-start" aria-hidden="true" />
        <!-- Wraps rather than truncates: the end of a path is what tells two files apart. -->
        <span class="min-w-0 wrap-anywhere">{file.path}</span>
      </button>
    {/each}
  </nav>

  {#if shown}
    <div class="flex min-w-0 flex-col rounded-lg border">
      <div
        bind:this={viewerHeader}
        tabindex="-1"
        class="flex min-w-0 items-center justify-between gap-3 border-b py-1 pr-1 pl-4 outline-none"
      >
        <!-- The path wraps, and the size and badge go under it when the bar is too narrow for
             all three. -->
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 py-1">
          <span class="min-w-0 font-mono text-xs wrap-anywhere">{shown.path}</span>
          <span class="text-muted-foreground shrink-0 text-xs">{formatBytes(shown.bytes)}</span>
          {#if shown.executable}
            <Badge variant="secondary">Executable</Badge>
          {/if}
        </div>
        {#if shown.text !== null}
          <CopyButton value={shown.text} label="Copy the file" what="File copied" />
        {:else}
          <!-- Holds the bar's height on a file with nothing to copy. -->
          <span class="size-9" aria-hidden="true"></span>
        {/if}
      </div>
      {#if kind === "markdown" && shown.text !== null}
        <div class="min-w-0 px-5 py-4" {@attach followSkillLinks}>
          <Markdown
            content={shown.path === SKILL_FILE ? skillBody(shown.text) : shown.text}
            breaks={false}
          />
        </div>
      {:else if kind === "text" && shown.text !== null}
        <div class="min-w-0 p-2">
          <CodeView code={shown.text} name={shown.path} lineNumbers />
        </div>
      {:else}
        <p class="text-muted-foreground px-4 py-6 text-sm">
          Not a text file, so it can't be shown here.
        </p>
      {/if}
    </div>
  {/if}
</div>
