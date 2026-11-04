<script lang="ts">
import type { GitlabHook } from "$lib/api/repos";
import CopyButton from "$lib/components/copy-button/copy-button.svelte";
import CheckIcon from "@lucide/svelte/icons/check";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import { gitlabHookSteps } from "./steps";

// How a Maintainer adds Ryph's webhook to a GitLab project by hand, every value one click from
// the clipboard. The connect flow shows it right after connecting, and the repo page again.
let {
  hook,
  webUrl,
}: {
  hook: GitlabHook;
  /** The project's page on GitLab, for a link straight to its webhooks. */
  webUrl: string | null;
} = $props();

const steps = $derived(gitlabHookSteps(hook, webUrl));
</script>

<ol class="flex flex-col gap-6">
  {#each steps as step, i (i)}
    <li class="flex gap-3">
      <span
        class="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums"
        aria-hidden="true"
      >
        {i + 1}
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <p class="text-sm">{step.text}</p>
        {#if step.path}
          <p class="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
            {#each step.path as part, j (j)}
              {#if j > 0}<ChevronRightIcon class="size-3" aria-label="then" />{/if}
              <span class="text-foreground font-medium">{part}</span>
            {/each}
          </p>
        {/if}
        {#if step.link}
          <a
            href={step.link.href}
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary dark:text-foreground flex w-fit items-center gap-1 text-xs underline-offset-4 hover:underline"
          >
            {step.link.label}
            <ExternalLinkIcon class="size-3" />
          </a>
        {/if}
        {#each step.values ?? [] as value (value.label)}
          <div class="flex min-w-0 flex-col gap-1">
            <span class="text-muted-foreground text-xs">{value.label}</span>
            <div class="bg-muted/50 flex items-start gap-2 rounded-md border py-1 pr-1 pl-2.5">
              {#if value.value === null}
                <span class="text-muted-foreground min-w-0 flex-1 py-1.5 text-xs italic">Not set</span>
              {:else}
                <code class="min-w-0 flex-1 py-1.5 font-mono text-xs wrap-anywhere">{value.value}</code>
                <CopyButton
                  value={value.value}
                  size="icon-sm"
                  label="Copy the {value.label.toLowerCase()}"
                  what="{value.label} copied"
                />
              {/if}
            </div>
          </div>
        {/each}
        {#if step.ticks}
          <ul class="flex flex-col gap-1">
            {#each step.ticks as tick (tick)}
              <li class="flex items-center gap-2 text-xs">
                <CheckIcon class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                <span class="font-medium">{tick}</span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if step.note}
          <p class="text-muted-foreground text-xs">{step.note}</p>
        {/if}
      </div>
    </li>
  {/each}
</ol>
