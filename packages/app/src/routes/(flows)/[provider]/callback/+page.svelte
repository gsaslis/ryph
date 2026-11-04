<script lang="ts">
import { page } from "$app/state";
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import { Button } from "$lib/components/ui/button";
import { providerLabel } from "$lib/utils/providers";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
import CheckIcon from "@lucide/svelte/icons/check";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const label = $derived(providerLabel(page.params.provider ?? ""));
const linking = $derived(data.intent === "link");
</script>

<svelte:head>
  <title>{linking ? `Link ${label}` : `Sign in with ${label}`} · Ryph</title>
</svelte:head>

<FlowStep
  headline={data.login
    ? `${label} account linked`
    : linking
    ? "Linking failed"
    : data.linkRequired
    ? `${label} isn't linked yet`
    : "Sign-in failed"}
  description={data.login
    ? `Your Ryph account now carries a ${label} identity — repo permissions are checked against it.`
    : data.linkRequired
    ? undefined
    : linking
    ? `The ${label} account could not be linked.`
    : `Signing in with ${label} did not work.`}
>
  {#if data.login}
    <p class="flex items-center gap-2 text-sm">
      <CheckIcon class="size-4" />
      Linked as <span class="font-medium">@{data.login}</span>
    </p>
  {:else}
    <p class={data.linkRequired ? "text-sm" : "text-destructive text-sm"}>{data.error}</p>
  {/if}

  {#snippet actions()}
    <Button href={linking ? "/account" : "/login"}>
      <ArrowRightIcon data-icon="inline-start" />
      {linking ? "Back to settings" : "Back to sign-in"}
    </Button>
  {/snippet}
</FlowStep>
