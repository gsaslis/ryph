<script lang="ts">
import PageTitle from "$lib/components/page-title/page-title.svelte";
import SettingsSection from "$lib/components/settings-section/settings-section.svelte";
import { Separator } from "$lib/components/ui/separator";
import BackgroundModel from "./background-model.svelte";
import EgressAllowlist from "./egress-allowlist.svelte";
import ReservedCapacity from "./reserved-capacity.svelte";
import { can } from "$lib/utils/auth/capabilities";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>Platform · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-10">
  <PageTitle title="Platform">
    {#snippet description()}
      Settings that apply to everyone on this instance.
    {/snippet}
  </PageTitle>

  <SettingsSection
    id="background-model"
    title="Background model"
    description="The model Ryph uses for its own work: checking memories against each other and turning documents into memories. Without one, that work skips anything that needs a model."
  >
    {#if data.modelAccessEnabled}
      <BackgroundModel
        providerKeys={data.providerKeys}
        providers={data.providers}
        platformPolicy={data.platformPolicy}
      />
    {:else}
      <p class="text-muted-foreground text-sm">Model access is off on this deployment.</p>
    {/if}
  </SettingsSection>

  <Separator />

  <SettingsSection id="internet-access" title="Internet access">
    {#snippet description()}
      What runs can reach on the internet, while setting up a repository and while an agent
      works. An agent can narrow this, but never widen it.
    {/snippet}
    {#if data.egressState === "on" && data.egressCeiling}
      <EgressAllowlist ceiling={data.egressCeiling} />
    {:else}
      <p class="text-muted-foreground text-sm">Couldn't load the internet access settings.</p>
    {/if}
  </SettingsSection>

  {#if can(data.user, "resources:manage")}
    <Separator />

    <SettingsSection
      id="reserved-capacity"
      title="Reserved capacity"
      description="Keep room ready for runs and checks of each size, so they start sooner. An idle slot still holds a machine."
    >
      {#if data.reservedCapacity}
        <ReservedCapacity capacity={data.reservedCapacity} />
      {:else}
        <p class="text-muted-foreground text-sm">Couldn't load reserved capacity.</p>
      {/if}
    </SettingsSection>
  {/if}
</div>
