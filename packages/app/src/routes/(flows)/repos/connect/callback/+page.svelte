<script lang="ts">
import { goto } from "$app/navigation";
import { ApiError } from "$lib/api/call";
import { registerInstallation } from "$lib/api/repos";
import { withBackTo } from "$lib/utils/safe-path";
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
import { onMount } from "svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

let error: string | null = $state(null);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function attemptRegister(): Promise<Error | null> {
  try {
    await registerInstallation(fetch, data.installationId);
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

// Right after the redirect GitHub may not confirm the installation yet (a 502,
// eventually consistent) — retry once after a beat before giving up.
async function register() {
  error = null;
  let failure = await attemptRegister();
  if (failure instanceof ApiError && failure.status === 502) {
    await wait(2000);
    failure = await attemptRegister();
  }
  if (failure) {
    error = failure.message;
    return;
  }
  await goto(
    withBackTo(
      `/repos/connect?installationId=${encodeURIComponent(data.installationId)}`,
      data.backTo,
    ),
    { replaceState: true },
  );
}

onMount(register);
</script>

<svelte:head>
  <title>Connect repository · Ryph</title>
</svelte:head>

<FlowStep
  headline="Registering the installation"
  description="Confirming the GitHub App installation before picking repositories."
>
  {#if error}
    <p class="text-destructive text-sm">{error}</p>
  {:else}
    <div class="text-muted-foreground flex items-center gap-2 text-sm">
      <Spinner />
      Checking with GitHub…
    </div>
  {/if}

  {#snippet leftActions()}
    {#if error}
      <Button variant="ghost" href={withBackTo("/repos/connect", data.backTo)}>Back</Button>
    {/if}
  {/snippet}

  {#snippet actions()}
    {#if error}
      <Button onclick={register}>
        <RotateCwIcon data-icon="inline-start" />
        Try again
      </Button>
    {/if}
  {/snippet}
</FlowStep>
