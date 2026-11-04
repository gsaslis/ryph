<script lang="ts">
import { presetById, type PresetId, type SetupContext, setupSteps } from "$lib/automations/presets";
import CopyButton from "$lib/components/copy-button/copy-button.svelte";
import { untrack } from "svelte";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import FirstRequest from "./first-request.svelte";
import PasteSecret from "./paste-secret.svelte";

// How to connect a sender, step by step in its own menus, with every value to paste one click
// from the clipboard; then, for a sender that makes its own secret, where to paste it; then a
// live check that its first request arrived. The create flow shows it once the automation exists,
// and the automation's page reopens it.
let {
  automationId,
  preset,
  context,
  pasted,
  awaiting = pasted,
  onlyNew = false,
  onsaved,
}: {
  automationId: string;
  preset: PresetId;
  context: SetupContext;
  /** The sender makes the secret, and it is pasted here. */
  pasted: boolean;
  /** The sender's secret is still to be pasted, so its requests are turned away for now. */
  awaiting?: boolean;
  /** Count only requests after this opened. */
  onlyNew?: boolean;
  /** Told when a pasted secret is saved. */
  onsaved?: () => void;
} = $props();

const vendor = $derived(preset === "other" ? "the sender" : presetById(preset).name);
const steps = $derived(setupSteps(preset, context));
// A sender whose secret was pasted before this opened starts with it saved.
let saved = $state(untrack(() => !awaiting));
</script>

<div class="flex flex-col gap-8">
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
                {#if value.missing}
                  <span class="text-muted-foreground min-w-0 flex-1 py-1.5 font-mono text-xs italic">
                    {value.value}
                  </span>
                {:else if value.block}
                  <pre class="min-w-0 flex-1 py-1.5 font-mono text-xs whitespace-pre-wrap wrap-anywhere">{value.value}</pre>
                {:else}
                  <code class="min-w-0 flex-1 py-1.5 font-mono text-xs wrap-anywhere">{value.value}</code>
                {/if}
                {#if !value.missing}
                  <CopyButton
                    value={value.value}
                    size="icon-sm"
                    label="Copy {value.label}"
                    what="{value.label} copied"
                  />
                {/if}
              </div>
              {#if value.missing}
                <span class="text-muted-foreground text-xs">
                  Shown once when it was made. Lost it? Make a new one with New secret.
                </span>
              {/if}
            </div>
          {/each}
          {#if step.note}
            <p class="text-muted-foreground text-xs">{step.note}</p>
          {/if}
        </div>
      </li>
    {/each}
  </ol>

  {#if pasted}
    <PasteSecret {automationId} {vendor} verification={context.verification} bind:saved {onsaved} />
  {/if}

  <FirstRequest {automationId} {vendor} {onlyNew} waitingOnSecret={pasted && awaiting && !saved} />
</div>
