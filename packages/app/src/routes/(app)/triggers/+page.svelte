<script lang="ts">
import { can } from "$lib/utils/auth/capabilities";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { invalidate } from "$app/navigation";
import { deleteAutomation, disableAutomation, enableAutomation } from "$lib/api/automations";
import { deleteCommandRoom } from "$lib/api/command-rooms";
import { type Automation, type Chatroom, CHATROOM_KIND_LABEL } from "$lib/api/types";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import * as Card from "$lib/components/ui/card";
import * as Empty from "$lib/components/ui/empty";
import { formatDateTime } from "$lib/utils/format";
import ClockIcon from "@lucide/svelte/icons/clock";
import MessagesSquareIcon from "@lucide/svelte/icons/messages-square";
import PencilIcon from "@lucide/svelte/icons/pencil";
import MoreHorizontalIcon from "@lucide/svelte/icons/more-horizontal";
import PauseIcon from "@lucide/svelte/icons/pause";
import PlayIcon from "@lucide/svelte/icons/play";
import PlusIcon from "@lucide/svelte/icons/plus";
import Trash2Icon from "@lucide/svelte/icons/trash-2";
import WebhookIcon from "@lucide/svelte/icons/webhook";
import ZapIcon from "@lucide/svelte/icons/zap";
import type { Snippet } from "svelte";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

function triggerSummary(automation: Automation): string {
  return automation.trigger.kind === "webhook"
    ? automation.trigger.verification.kind
    : `${automation.trigger.cron} · ${automation.trigger.timezone}`;
}

async function toggleEnabled(automation: Automation) {
  try {
    if (automation.enabled) {
      await disableAutomation(fetch, automation.id);
      toast.success(`Paused "${automation.name}"`);
    } else {
      await enableAutomation(fetch, automation.id);
      toast.success(`Resumed "${automation.name}"`);
    }
    await invalidate("app:automations");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to update automation");
  }
}

const canManageRooms = $derived(can(data.user, "chat:manage"));
const empty = $derived(data.automations.length === 0 && data.chatCommands.length === 0);

// A delete from a card's menu is confirmed first: one click there used to delete for good.
type PendingDelete = { kind: "automation"; automation: Automation } | {
  kind: "chat";
  room: Chatroom;
};
let pendingDelete = $state<PendingDelete | null>(null);

function confirmDelete() {
  const target = pendingDelete;
  pendingDelete = null;
  if (target?.kind === "automation") void handleDelete(target.automation);
  else if (target?.kind === "chat") void deleteChatCommand(target.room);
}

async function deleteChatCommand(room: Chatroom) {
  try {
    await deleteCommandRoom(fetch, room.id);
    await invalidate("app:automations");
    toast.success(`Deleted the chat command for "${room.name}"`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to delete the chat command");
  }
}

async function handleDelete(automation: Automation) {
  try {
    await deleteAutomation(fetch, automation.id);
    await invalidate("app:automations");
    toast.success(`Deleted "${automation.name}"`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to delete automation");
  }
}
</script>

<svelte:head>
  <title>Triggers · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-6">
  <PageTitle title="Triggers">
    {#snippet description()}
      Webhooks, schedules and chat commands that start agent runs on their own.
    {/snippet}
  </PageTitle>

  {#if empty}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <ZapIcon />
        </Empty.Media>
        <Empty.Title>No triggers yet</Empty.Title>
        <Empty.Description>
          Start a run when a service sends a webhook, on a schedule, or when someone mentions the
          bot in chat.
        </Empty.Description>
      </Empty.Header>
      <Empty.Content>
        {@render newTriggerMenu(emptyTrigger)}
      </Empty.Content>
    </Empty.Root>
  {:else}
    <!-- Cards, as the tool servers are: a handful of these, each one thing with a face — what
         kind of signal it is — a name, the signal spelled out, and its state in the corner. The
         card for a new one sits in the grid it joins. -->
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {#each data.automations as automation (automation.id)}
        {@const webhook = automation.trigger.kind === "webhook"}
        <!-- The whole card opens the automation: the name is the link, and its ::after is
             stretched over the card (`relative` here anchors it), so the card is one target
             without nesting a button inside a link — the menu sits above that layer. Hover and
             keyboard focus on the link light the card's ring, so the target reads as one. -->
        <Card.Root
          size="sm"
          class={[
            "@container/card from-foreground/5 to-card relative bg-linear-to-t transition-[box-shadow,opacity] hover:ring-foreground/25 has-[a:focus-visible]:ring-ring/50 has-[a:focus-visible]:ring-[3px]",
            !automation.enabled && "opacity-60 hover:opacity-100",
          ]}
        >
          <Card.Header>
            <div class="flex min-w-0 flex-col gap-4">
              <div
                class="bg-background ring-border flex size-12 shrink-0 items-center justify-center rounded-lg ring-1"
              >
                {#if webhook}
                  <WebhookIcon class="text-muted-foreground size-6" />
                {:else}
                  <ClockIcon class="text-muted-foreground size-6" />
                {/if}
              </div>
              <Card.Title class="truncate" title={automation.name}>
                <a
                  href="/triggers/{automation.id}"
                  class="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                >
                  {automation.name}
                </a>
              </Card.Title>
            </div>
            <Card.Action class="relative z-10 flex items-center gap-1">
              {#if automation.enabled}
                <Badge variant="secondary">Enabled</Badge>
              {:else}
                <Badge variant="outline">Paused</Badge>
              {/if}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <Button
                      {...props}
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Trigger actions"
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                  <DropdownMenu.Group>
                    <DropdownMenu.Item onclick={() => toggleEnabled(automation)}>
                      {#if automation.enabled}
                        <PauseIcon />
                        Pause
                      {:else}
                        <PlayIcon />
                        Resume
                      {/if}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      variant="destructive"
                      onclick={() => (pendingDelete = { kind: "automation", automation })}
                    >
                      <Trash2Icon />
                      Delete
                    </DropdownMenu.Item>
                  </DropdownMenu.Group>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </Card.Action>
          </Card.Header>
          <Card.Content class="flex flex-col gap-1">
            <Card.Description class="flex items-center gap-2">
              <span>{webhook ? "Webhook" : "Schedule"}</span>
              <span class="truncate font-mono text-xs" title={triggerSummary(automation)}>
                {triggerSummary(automation)}
              </span>
            </Card.Description>
            <Card.Description class="text-xs">
              Created {formatDateTime(automation.createdAt)}
            </Card.Description>
          </Card.Content>
        </Card.Root>
      {/each}
      {#each data.chatCommands as { room, command } (room.id)}
        {@render chatCommandCard(room, command.channels.length)}
      {/each}
      {@render newTriggerMenu(tileTrigger)}
    </div>
  {/if}
</div>

<!-- What a new trigger can be. A chat command belongs to a chat connection, so the menu names the
     connections that could take one; with none, it says where they come from. Chat commands are
     an admin's alone — they let people on a chat server spend the saver's budget. -->
{#snippet newTriggerMenu(trigger: Snippet<[Record<string, unknown>]>)}
  <DropdownMenu.Root>
  <DropdownMenu.Trigger>
      {#snippet child({ props })}
        {@render trigger(props)}
      {/snippet}
    </DropdownMenu.Trigger>
  <DropdownMenu.Content class="min-w-56">
      <DropdownMenu.Group>
        <DropdownMenu.Item>
          {#snippet child({ props })}
            <a {...props} href="/triggers/create">
              <WebhookIcon />
              Webhook or schedule
            </a>
          {/snippet}
        </DropdownMenu.Item>
      </DropdownMenu.Group>
      {#if canManageRooms}
        <DropdownMenu.Separator />
        <DropdownMenu.Group>
          <DropdownMenu.Label class="text-muted-foreground text-xs font-normal">
            Chat command in
          </DropdownMenu.Label>
          {#each data.chatroomsWithoutCommand as room (room.id)}
            <DropdownMenu.Item>
              {#snippet child({ props })}
                <a {...props} href="/triggers/chat/{room.id}">
                  <MessagesSquareIcon />
                  <span class="truncate">{room.name}</span>
                  <span class="text-muted-foreground ml-auto pl-4 text-xs">
                    {CHATROOM_KIND_LABEL[room.kind]}
                  </span>
                </a>
              {/snippet}
            </DropdownMenu.Item>
          {:else}
            <DropdownMenu.Item>
              {#snippet child({ props })}
                <a {...props} href="/chat">
                  <MessagesSquareIcon />
                  {data.anyChatroom ? "Every chat has one. Add a chat…" : "Connect a chat first…"}
                </a>
              {/snippet}
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Group>
      {/if}
    </DropdownMenu.Content>
</DropdownMenu.Root>
{/snippet}

<!-- A chat command, drawn as the automations are: the room is its face and its name. -->
{#snippet chatCommandCard(room: Chatroom, channelCount: number)}
  <Card.Root
  size="sm"
  class="@container/card from-foreground/5 to-card relative bg-linear-to-t transition-shadow hover:ring-foreground/25 has-[a:focus-visible]:ring-ring/50 has-[a:focus-visible]:ring-[3px]"
>
  <Card.Header>
    <div class="flex min-w-0 flex-col gap-4">
      <div
        class="bg-background ring-border flex size-12 shrink-0 items-center justify-center rounded-lg ring-1"
      >
        <MessagesSquareIcon class="text-muted-foreground size-6" />
      </div>
      <Card.Title class="truncate" title={room.name}>
          {#if canManageRooms}
            <a
              href="/triggers/chat/{room.id}"
              class="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
            >
              {room.name}
            </a>
          {:else}
            {room.name}
          {/if}
        </Card.Title>
    </div>
    <Card.Action class="relative z-10 flex items-center gap-1">
        <Badge variant="secondary">Enabled</Badge>
        {#if canManageRooms}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button {...props} variant="ghost" size="icon-sm" aria-label="Trigger actions">
                  <MoreHorizontalIcon />
                </Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              <DropdownMenu.Group>
                <DropdownMenu.Item>
                  {#snippet child({ props })}
                    <a {...props} href="/triggers/chat/{room.id}">
                      <PencilIcon />
                      Edit
                    </a>
                  {/snippet}
                </DropdownMenu.Item>
                <DropdownMenu.Item variant="destructive" onclick={() => (pendingDelete = { kind: "chat", room })}>
                  <Trash2Icon />
                  Delete
                </DropdownMenu.Item>
              </DropdownMenu.Group>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        {/if}
      </Card.Action>
  </Card.Header>
  <Card.Content class="flex flex-col gap-1">
    <Card.Description class="flex items-center gap-2">
      <span>Chat command</span>
      <span class="truncate text-xs">
          {CHATROOM_KIND_LABEL[room.kind]}, mention @{room.botUsername}
        </span>
    </Card.Description>
    <Card.Description class="text-xs">
        {channelCount > 0
          ? `${channelCount} ${channelCount === 1 ? "channel" : "channels"} with their own target`
          : "One target for every channel"}
      </Card.Description>
  </Card.Content>
</Card.Root>
{/snippet}

<!-- The two faces of the new-trigger menu: a button in the empty state, a tile in the grid. -->
{#snippet emptyTrigger(props: Record<string, unknown>)}
  <Button {...props}>
    <PlusIcon data-icon="inline-start" />
    New trigger
  </Button>
{/snippet}

{#snippet tileTrigger(props: Record<string, unknown>)}
  <button
  {...props}
  type="button"
  class="text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:ring-ring/50 data-[state=open]:bg-muted/50 flex min-h-40 items-center justify-center gap-2 rounded-xl border border-dashed text-sm transition-colors outline-none focus-visible:ring-[3px]"
>
    <PlusIcon class="size-4" />
    New trigger
  </button>
{/snippet}

<AlertDialog.Root
  open={pendingDelete !== null}
  onOpenChange={(open) => {
    if (!open) pendingDelete = null;
  }}
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      {#if pendingDelete?.kind === "automation"}
        {@const automation = pendingDelete.automation}
        <AlertDialog.Title>Delete "{automation.name}"?</AlertDialog.Title>
        <AlertDialog.Description>
          {automation.trigger.kind === "webhook"
            ? "Requests to its webhook address will fail, and its history is deleted."
            : "It stops running on its schedule, and its history is deleted."}
          You can't undo this.
        </AlertDialog.Description>
      {:else if pendingDelete?.kind === "chat"}
        <AlertDialog.Title>Delete the chat command in "{pendingDelete.room.name}"?</AlertDialog.Title>
        <AlertDialog.Description>
          Mentioning the bot there will no longer start runs. Runs it already started keep going,
          and the chat connection stays.
        </AlertDialog.Description>
      {/if}
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmDelete}>Delete</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
