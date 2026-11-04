<script lang="ts">
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { invalidate } from "$app/navigation";
import { archiveAgent } from "$lib/api/agents";
import AgentAvatar from "$lib/components/agent-avatar/agent-avatar.svelte";
import { pageHeader } from "$lib/components/page-header/page-header.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Card from "$lib/components/ui/card";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
import * as Empty from "$lib/components/ui/empty";
import { Label } from "$lib/components/ui/label";
import { Switch } from "$lib/components/ui/switch";
import { agentAvatar } from "$lib/utils/avatar";
import { formatDateTime } from "$lib/utils/format";
import ArchiveIcon from "@lucide/svelte/icons/archive";
import BotIcon from "@lucide/svelte/icons/bot";
import MoreHorizontalIcon from "@lucide/svelte/icons/more-horizontal";
import PencilIcon from "@lucide/svelte/icons/pencil";
import PlusIcon from "@lucide/svelte/icons/plus";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// Archived agents are kept for the record, not for the eye: out of the grid unless asked for, and
// the switch that asks lives in the sticky bar above the page, as on the tool servers page.
let showArchived = $state(false);
const archivedCount = $derived(data.agents.filter((a) => a.archivedAt !== null).length);
const agents = $derived(data.agents.filter((a) => showArchived || a.archivedAt === null));
$effect(() => {
  pageHeader.controls = archivedCount > 0 ? archivedSwitch : null;
  return () => {
    pageHeader.controls = null;
  };
});

async function handleArchive(id: string, name: string) {
  try {
    await archiveAgent(fetch, id);
    await invalidate("app:agents");
    toast.success(`Archived "${name}"`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to archive agent");
  }
}
</script>

<svelte:head>
  <title>Agents · Ryph</title>
</svelte:head>

{#snippet archivedSwitch()}
  <Label for="show-archived" class="text-muted-foreground font-normal">Show archived</Label>
  <Switch id="show-archived" bind:checked={showArchived} />
{/snippet}

<div class="flex flex-col gap-6">
  <PageTitle title="Agents">
    {#snippet description()}
      Blueprints that define who works on your tasks.
    {/snippet}
  </PageTitle>

  {#if data.agents.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <BotIcon />
        </Empty.Media>
        <Empty.Title>No agents yet</Empty.Title>
        <Empty.Description>
          Create your first agent to start running tasks.
        </Empty.Description>
      </Empty.Header>
      <Empty.Content>
        <Button href="/agents/create">
          <PlusIcon data-icon="inline-start" />
          New agent
        </Button>
      </Empty.Content>
    </Empty.Root>
  {:else}
    <!-- Cards, as the tool servers and triggers are: each agent is someone with a face, and the
         card is tinted with that face's own background colour, so a roster reads as a row of
         people rather than a row of identical tiles. The whole card opens the agent for editing:
         the name is the link and its ::after is stretched over the card (`relative` anchors it),
         with the menu above that layer. -->
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {#each agents as agent (agent.id)}
        {@const avatar = agentAvatar(agent.id)}
        <Card.Root
          size="sm"
          class={[
            "@container/card from-(--brand)/15 to-card relative bg-linear-to-t transition-[box-shadow,opacity] hover:ring-foreground/25 has-[a:focus-visible]:ring-ring/50 has-[a:focus-visible]:ring-[3px]",
            agent.archivedAt && "opacity-60 hover:opacity-100",
          ]}
          style="--brand: {avatar.color}"
        >
          <Card.Header>
            <div class="flex min-w-0 flex-col gap-4">
              <AgentAvatar agentId={agent.id} class="size-12" />
              <Card.Title class="truncate" title={agent.name}>
                <a
                  href="/agents/{agent.id}/edit"
                  class="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                >
                  {agent.name}
                </a>
              </Card.Title>
            </div>
            <Card.Action class="relative z-10 flex items-center gap-1">
              {#if agent.archivedAt}
                <Badge variant="outline">Archived</Badge>
              {:else}
                <Badge variant="secondary">{agent.harnessKind}</Badge>
              {/if}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <Button {...props} variant="ghost" size="icon-sm" aria-label="Agent actions">
                      <MoreHorizontalIcon />
                    </Button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                  <DropdownMenu.Group>
                    <DropdownMenu.Item>
                      {#snippet child({ props })}
                        <a {...props} href="/agents/{agent.id}/edit">
                          <PencilIcon />
                          Edit
                        </a>
                      {/snippet}
                    </DropdownMenu.Item>
                    {#if !agent.archivedAt}
                      <DropdownMenu.Item
                        variant="destructive"
                        onclick={() => handleArchive(agent.id, agent.name)}
                      >
                        <ArchiveIcon />
                        Archive
                      </DropdownMenu.Item>
                    {/if}
                  </DropdownMenu.Group>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </Card.Action>
          </Card.Header>
          <Card.Content class="flex flex-col gap-1">
            <Card.Description class="truncate" title={agent.email}>{agent.email}</Card.Description>
            <Card.Description class="text-xs">
              Created {formatDateTime(agent.createdAt)}
            </Card.Description>
          </Card.Content>
        </Card.Root>
      {/each}
      <a
        href="/agents/create"
        class="text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:ring-ring/50 flex min-h-40 items-center justify-center gap-2 rounded-xl border border-dashed text-sm transition-colors outline-none focus-visible:ring-[3px]"
      >
        <PlusIcon class="size-4" />
        New agent
      </a>
    </div>
  {/if}
</div>
