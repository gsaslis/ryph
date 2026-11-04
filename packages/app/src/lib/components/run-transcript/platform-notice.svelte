<script lang="ts">
import type { Snippet } from "svelte";
import * as Collapsible from "$lib/components/ui/collapsible";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import { formatTime } from "$lib/utils/format";
import type { PlatformNoticeSummary } from "./platform-notice";

let { summary, at, details, open = false, ontoggle, actions, children }: {
  summary: PlatformNoticeSummary;
  at: string;
  details: string;
  open?: boolean;
  ontoggle: (open: boolean) => void;
  actions?: Snippet;
  children?: Snippet;
} = $props();
</script>

<Collapsible.Root class="group/notice @container flex min-w-0 flex-col gap-1" {open}
  onOpenChange={ontoggle}>
  <!-- The header's 16px first line + 4px padding matches the 20px lane marker. Its
       right column never wraps or follows a multiline summary down the row. Below 36rem of
       notice width (including narrow desktop panes), only disclosure and time occupy that
       column; secondary actions live in expanded Details. No viewport or JS measurement needed. -->
  <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 py-0.5 text-xs leading-4">
    <p class="min-w-0 wrap-anywhere">
      <bdi class={["font-medium", summary.failed && "text-destructive", summary.checksState === "passed" && "text-success"]}>{summary.label.charAt(0).toUpperCase() + summary.label.slice(1)}</bdi>
      {#if summary.detail}
        <span class="text-muted-foreground block @min-[36rem]:inline"><span class="hidden @min-[36rem]:inline"> · </span>{summary.detail}</span>
      {/if}
    </p>
    <div class="flex h-4 items-center gap-2 whitespace-nowrap">
      {#if actions}
        <div class="hidden h-4 items-center gap-2 @min-[36rem]:flex">{@render actions()}</div>
      {/if}
      <Collapsible.Trigger class="text-muted-foreground hover:text-foreground -my-1 flex size-6 shrink-0 items-center justify-center gap-1 transition-colors @min-[36rem]:my-0 @min-[36rem]:h-4 @min-[36rem]:w-auto">
        <ChevronRightIcon class="size-3 transition-transform group-data-[state=open]/notice:rotate-90" />
        <span class="sr-only @min-[36rem]:not-sr-only">Details</span>
      </Collapsible.Trigger>
      <span class="text-muted-foreground shrink-0 pr-2">{formatTime(at)}</span>
    </div>
  </div>
  {@render children?.()}
  <Collapsible.Content>
    {#if actions}
      <!-- display:none excludes the other responsive copy from focus/accessibility too. -->
      <div class="mb-2 flex flex-wrap items-center gap-2 py-1 @min-[36rem]:hidden">{@render actions()}</div>
    {/if}
    <pre class="bg-muted text-muted-foreground max-h-96 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap wrap-anywhere">{details}</pre>
  </Collapsible.Content>
</Collapsible.Root>
