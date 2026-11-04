<script lang="ts">
import PageTitle from "$lib/components/page-title/page-title.svelte";
import SingleUserNotice from "$lib/components/single-user-notice/single-user-notice.svelte";
import { Separator } from "$lib/components/ui/separator";
import type { PageProps } from "./$types";
import InvitesSection from "./invites-section.svelte";
import UsersSection from "./users-section.svelte";

let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>Members · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-10">
  <PageTitle title="Members">
    {#snippet description()}
      Who can use this instance, and who's been invited.
    {/snippet}
  </PageTitle>
  {#if !data.multiUser}
    <SingleUserNotice />
  {/if}
  <UsersSection {data} />
  <Separator />
  <InvitesSection {data} />
</div>
