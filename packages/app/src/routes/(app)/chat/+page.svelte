<script lang="ts">
import { can } from "$lib/utils/auth/capabilities";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { invalidate } from "$app/navigation";
import { archiveChatroom, createChatroom, updateChatroom } from "$lib/api/chatrooms";
import { type Chatroom, CHATROOM_KIND_LABEL, type ChatroomKind } from "$lib/api/types";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
import * as Empty from "$lib/components/ui/empty";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import { Spinner } from "$lib/components/ui/spinner";
import { Switch } from "$lib/components/ui/switch";
import * as Table from "$lib/components/ui/table";
import { formatDateTime } from "$lib/utils/format";
import { refreshWhileLive } from "$lib/utils/live-refresh.svelte";
import ArchiveIcon from "@lucide/svelte/icons/archive";
import MessageSquareIcon from "@lucide/svelte/icons/message-square";
import MessagesSquareIcon from "@lucide/svelte/icons/messages-square";
import MoreHorizontalIcon from "@lucide/svelte/icons/more-horizontal";
import PencilIcon from "@lucide/svelte/icons/pencil";
import PlusIcon from "@lucide/svelte/icons/plus";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// A Zulip room makes the server dial the organization URL it names, so adding one takes
// chat:manage (the chat service refuses anyone else); so does a room's command policy. Telegram,
// Slack and Discord are reached at one fixed address, so any writer may add those.
const canManage = $derived(can(data.user, "chat:manage"));

// A room links itself the moment someone mentions its bot in the group, and nothing pushes
// that down to this page — so it asks again while any room is still waiting to be linked.
refreshWhileLive("app:chatrooms", () => data.chatrooms.some((room) => !room.linked));

// ---- create ----
let createOpen = $state(false);
let creating = $state(false);
let newKind = $state<ChatroomKind>("telegram");
let newName = $state("");
let newToken = $state("");
let newAppToken = $state("");
let newRealmUrl = $state("");
let newBotEmail = $state("");
let newApiKey = $state("");
let newGuildId = $state("");
let newQuiet = $state(false);

// A Discord server id is a snowflake: 17 to 20 digits, kept a string (it outgrows a JS number).
const guildIdValid = $derived(/^\d{17,20}$/.test(newGuildId.trim()));

const createReady = $derived.by(() => {
  if (newName.trim() === "") return false;
  switch (newKind) {
    case "telegram":
      return newToken.trim() !== "";
    case "slack":
      return newToken.trim() !== "" && newAppToken.trim() !== "";
    case "discord":
      return newToken.trim() !== "" && guildIdValid;
    case "zulip":
      return newRealmUrl.trim() !== "" && newBotEmail.trim() !== "" && newApiKey.trim() !== "";
  }
});

function resetCreate() {
  newKind = "telegram";
  newName = "";
  newToken = "";
  newAppToken = "";
  newRealmUrl = "";
  newBotEmail = "";
  newApiKey = "";
  newGuildId = "";
  newQuiet = false;
}

function createInput() {
  const name = newName.trim();
  switch (newKind) {
    case "telegram":
      return { kind: "telegram" as const, name, botToken: newToken.trim() };
    case "slack":
      return {
        kind: "slack" as const,
        name,
        botToken: newToken.trim(),
        appToken: newAppToken.trim(),
      };
    case "discord":
      return {
        kind: "discord" as const,
        name,
        botToken: newToken.trim(),
        guildId: newGuildId.trim(),
      };
    case "zulip":
      return {
        kind: "zulip" as const,
        name,
        realmUrl: newRealmUrl.trim(),
        botEmail: newBotEmail.trim(),
        apiKey: newApiKey.trim(),
      };
  }
}

async function submitCreate(event: SubmitEvent) {
  event.preventDefault();
  creating = true;
  try {
    const room = await createChatroom(fetch, { ...createInput(), quiet: newQuiet });
    toast.success(
      room.kind === "telegram"
        ? `Added "${room.name}" — now mention @${room.botUsername} in the group with its code`
        : `Added "${room.name}". Add a chat-command trigger to let mentions start runs.`,
    );
    createOpen = false;
    resetCreate();
    await invalidate("app:chatrooms");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to add the chatroom");
  } finally {
    creating = false;
  }
}

// ---- edit ----
let editTarget = $state<Chatroom | null>(null);
let editName = $state("");
let editQuiet = $state(false);
let saving = $state(false);

function openEdit(room: Chatroom) {
  editTarget = room;
  editName = room.name;
  editQuiet = room.quiet;
}

async function submitEdit(event: SubmitEvent) {
  event.preventDefault();
  if (!editTarget) return;
  saving = true;
  try {
    const room = await updateChatroom(fetch, editTarget.id, {
      name: editName.trim(),
      quiet: editQuiet,
    });
    toast.success(`Saved "${room.name}"`);
    editTarget = null;
    await invalidate("app:chatrooms");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to save the chatroom");
  } finally {
    saving = false;
  }
}

// ---- archive ----
let archiveTarget = $state<Chatroom | null>(null);
let archiving = $state(false);

async function submitArchive() {
  if (!archiveTarget) return;
  archiving = true;
  try {
    await archiveChatroom(fetch, archiveTarget.id);
    toast.success(`Archived "${archiveTarget.name}"`);
    archiveTarget = null;
    await invalidate("app:chatrooms");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to archive the chatroom");
  } finally {
    archiving = false;
  }
}
</script>

<svelte:head>
  <title>Chat · Ryph</title>
</svelte:head>

{#snippet quiet(id: string, checked: boolean, set: (on: boolean) => void)}
  <Field.Field orientation="horizontal">
  <Field.FieldContent>
    <Field.FieldLabel for={id}>Quiet</Field.FieldLabel>
    <Field.FieldDescription>
        Skips the start message in existing conversations and the finish message when a run
        succeeds.
      </Field.FieldDescription>
  </Field.FieldContent>
  <Switch {id} {checked} onCheckedChange={set} />
</Field.Field>
{/snippet}

<div class="flex flex-col gap-6">
  <PageTitle title="Chat">
    {#snippet actions()}
      <Button
        onclick={() => {
          createOpen = true;
        }}
      >
        <PlusIcon data-icon="inline-start" />
        Add chatroom
      </Button>
    {/snippet}
    {#snippet description()}
      Telegram, Zulip, Slack and Discord connections. Responses report into them, and chat-command triggers
      start runs from them.
    {/snippet}
  </PageTitle>

  {#if data.chatrooms.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <MessageSquareIcon />
        </Empty.Media>
        <Empty.Title>No chatrooms yet</Empty.Title>
        <Empty.Description>
          Create a Telegram bot, turn its privacy mode off, paste its token here, add the bot to
          your team's group and mention it once quoting the room's link code. The group is the
          allowlist: whoever the team lets in may talk to a responding agent. A Slack app works
          too: paste its bot and app-level tokens and invite it to the channels it should serve.
          So does a Discord bot: paste its token and your server's id.
          An admin can add a Zulip organization's bot. Start runs from any of them with a
          chat-command trigger.
        </Empty.Description>
      </Empty.Header>
      <Empty.Content>
        <Button
          onclick={() => {
            createOpen = true;
          }}
        >
          <PlusIcon data-icon="inline-start" />
          Add chatroom
        </Button>
      </Empty.Content>
    </Empty.Root>
  {:else}
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Name</Table.Head>
          <Table.Head>Platform</Table.Head>
          <Table.Head>Bot</Table.Head>
          <Table.Head>Where</Table.Head>
          <Table.Head>Added</Table.Head>
          <Table.Head class="w-0"><span class="sr-only">Actions</span></Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each data.chatrooms as room (room.id)}
          <Table.Row>
            <Table.Cell class="font-medium">
              <span class="flex items-center gap-2">
                {room.name}
                {#if room.quiet}
                  <Badge variant="secondary">Quiet</Badge>
                {/if}
              </span>
            </Table.Cell>
            <Table.Cell>
              <Badge variant="outline">{CHATROOM_KIND_LABEL[room.kind]}</Badge>
            </Table.Cell>
            <Table.Cell class="font-mono text-xs">
              {room.kind === "zulip" ? room.botEmail : `@${room.botUsername}`}
            </Table.Cell>
            <Table.Cell>
              {#if room.kind === "zulip"}
                <a
                  href={room.realmUrl}
                  target="_blank"
                  rel="noreferrer"
                  class="font-mono text-xs underline-offset-4 hover:underline"
                >
                  {room.realmUrl}
                </a>
              {:else if room.kind === "slack"}
                <Badge variant="secondary">
                  {room.chatTitle ?? "the workspace the app is installed in"}
                </Badge>
              {:else if room.kind === "discord"}
                <Badge variant="secondary">{room.chatTitle ?? "the server the bot is in"}</Badge>
              {:else if room.linked}
                <Badge variant="secondary">Linked to {room.chatTitle ?? "the group"}</Badge>
              {:else}
                <div class="text-muted-foreground flex flex-col items-start gap-1 text-sm">
                  <span>
                    Add <span class="font-mono text-xs">@{room.botUsername}</span> to the group,
                    then mention it once quoting this code (privacy mode off):
                  </span>
                  <code class="bg-muted rounded px-1.5 py-0.5 font-mono text-xs"
                    >{room.linkCode}</code
                  >
                  <span>
                    The code is what proves the group is yours: the bot's username is not a
                    secret, so a mention alone would let any group claim this room.
                  </span>
                </div>
              {/if}
            </Table.Cell>
            <Table.Cell class="text-muted-foreground">{formatDateTime(room.createdAt)}</Table.Cell>
            <Table.Cell>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <Button {...props} variant="ghost" size="icon" aria-label="Chatroom actions">
                      <MoreHorizontalIcon />
                    </Button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                  <DropdownMenu.Group>
                    {#if canManage}
                      <DropdownMenu.Item>
                        {#snippet child({ props })}
                          <a {...props} href="/triggers/chat/{room.id}">
                            <MessagesSquareIcon />
                            Chat command
                          </a>
                        {/snippet}
                      </DropdownMenu.Item>
                    {/if}
                    <DropdownMenu.Item onclick={() => openEdit(room)}>
                      <PencilIcon />
                      Edit
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      variant="destructive"
                      onclick={() => {
                        archiveTarget = room;
                      }}
                    >
                      <ArchiveIcon />
                      Archive
                    </DropdownMenu.Item>
                  </DropdownMenu.Group>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  {/if}
</div>

<Dialog.Root bind:open={createOpen}>
  <Dialog.Content>
    <form onsubmit={submitCreate} class="flex flex-col gap-4">
      <Dialog.Header>
        <Dialog.Title>Add a chatroom</Dialog.Title>
        <Dialog.Description>
          {#if newKind === "zulip"}
            Paste a generic bot's email and API key from the organization's settings (Personal
            settings → Bots). The key is sealed on arrival and never shown again. The bot hears
            only messages that mention it; subscribe it to any private channel it should serve.
          {:else if newKind === "slack"}
            Paste the app's bot token and an app-level token with the connections:write scope.
            Both are sealed on arrival and never shown again. The app hears only messages that
            mention it, and only in channels it has been invited to — public ones included.
          {:else if newKind === "discord"}
            Paste the bot's token and your server's id. The token is sealed on arrival and never
            shown again. The bot hears only messages that mention it, in channels it can see. Each
            server needs its own bot application: one bot serves one room.
          {:else}
            Paste the bot's token from BotFather. It is sealed on arrival and never shown again;
            only the bot's username is. The room is then listed with a one-time link code: add the
            bot to your group and mention it once quoting that code, and the room links to it.
          {/if}
        </Dialog.Description>
      </Dialog.Header>
      <Field.FieldGroup>
        <Field.Field>
          <Field.FieldLabel for="room-kind">Platform</Field.FieldLabel>
          <Select.Root
            type="single"
            value={newKind}
            onValueChange={(value) => {
              newKind = value as ChatroomKind;
            }}
          >
            <Select.Trigger id="room-kind" class="w-full">
              {CHATROOM_KIND_LABEL[newKind]}
            </Select.Trigger>
            <Select.Content>
              <Select.Group>
                <Select.Item value="telegram" label="Telegram — a bot in one group" />
                <Select.Item value="slack" label="Slack — an app in one workspace" />
                <Select.Item value="discord" label="Discord — a bot in one server" />
                <!-- A Zulip room makes the server dial the organization URL it names, so the
                     chat service refuses anyone without chat:manage. -->
                {#if canManage}
                  <Select.Item value="zulip" label="Zulip — a bot in one organization" />
                {/if}
              </Select.Group>
            </Select.Content>
          </Select.Root>
        </Field.Field>
        <Field.Field>
          <Field.FieldLabel for="room-name">Name</Field.FieldLabel>
          <Input
            id="room-name"
            required
            bind:value={newName}
            placeholder={newKind === "telegram" ? "#incidents" : "acme"}
          />
        </Field.Field>
        {#if newKind === "zulip"}
          <Field.Field>
            <Field.FieldLabel for="room-realm">Organization URL</Field.FieldLabel>
            <Input
              id="room-realm"
              required
              type="url"
              bind:value={newRealmUrl}
              placeholder="https://your-org.zulipchat.com"
            />
            <Field.FieldDescription>
              The organization's address; a link into it works too. It must be https.
            </Field.FieldDescription>
          </Field.Field>
          <Field.Field>
            <Field.FieldLabel for="room-bot-email">Bot email</Field.FieldLabel>
            <Input
              id="room-bot-email"
              required
              autocomplete="off"
              bind:value={newBotEmail}
              placeholder="ryph-bot@your-org.zulipchat.com"
            />
          </Field.Field>
          <Field.Field>
            <Field.FieldLabel for="room-api-key">API key</Field.FieldLabel>
            <Input
              id="room-api-key"
              required
              type="password"
              autocomplete="off"
              bind:value={newApiKey}
            />
            <Field.FieldDescription>
              A bot's key reads every public channel's history and posts as the bot. To rotate
              it, regenerate it in Zulip and add the room again.
            </Field.FieldDescription>
          </Field.Field>
        {:else if newKind === "slack"}
          <Field.Field>
            <Field.FieldLabel for="room-token">Bot token</Field.FieldLabel>
            <Input
              id="room-token"
              required
              type="password"
              autocomplete="off"
              bind:value={newToken}
              placeholder="xoxb-…"
            />
            <Field.FieldDescription>
              From the app's OAuth &amp; Permissions page, once it is installed in the workspace.
              It needs the app_mentions:read, chat:write, reactions:write, channels:read,
              channels:history, groups:read, groups:history, users:read, usergroups:read,
              files:read and files:write scopes.
            </Field.FieldDescription>
          </Field.Field>
          <Field.Field>
            <Field.FieldLabel for="room-app-token">App-level token</Field.FieldLabel>
            <Input
              id="room-app-token"
              required
              type="password"
              autocomplete="off"
              bind:value={newAppToken}
              placeholder="xapp-…"
            />
            <Field.FieldDescription>
              From the app's Basic Information page, with the connections:write scope, and turn
              Socket Mode on. It is how ryph hears mentions without anything published to the
              internet. To rotate either token, replace it in Slack and add the room again.
            </Field.FieldDescription>
          </Field.Field>
        {:else if newKind === "discord"}
          <Field.Field>
            <Field.FieldLabel for="room-token">Bot token</Field.FieldLabel>
            <Input
              id="room-token"
              required
              type="password"
              autocomplete="off"
              bind:value={newToken}
            />
            <Field.FieldDescription>
              Create an application in the
              <a
                href="https://discord.com/developers/applications"
                target="_blank"
                rel="noreferrer"
                class="underline underline-offset-4"
              >Discord Developer Portal</a>, add a bot and copy its token. On the Bot page, turn
              on Message Content Intent and turn off Public Bot. Then invite the bot to your server
              (OAuth2 → URL Generator, bot scope) with View Channels, Send Messages, Send Messages
              in Threads, Create Public Threads, Read Message History, Add Reactions and Attach
              Files. Use one application per server. To rotate the token, reset it in Discord and
              add the room again.
            </Field.FieldDescription>
          </Field.Field>
          <Field.Field data-invalid={newGuildId.trim() !== "" && !guildIdValid}>
            <Field.FieldLabel for="room-guild-id">Server ID</Field.FieldLabel>
            <Input
              id="room-guild-id"
              required
              inputmode="numeric"
              autocomplete="off"
              bind:value={newGuildId}
              aria-invalid={newGuildId.trim() !== "" && !guildIdValid}
              placeholder="123456789012345678"
            />
            <Field.FieldDescription>
              Turn on Developer Mode (User Settings → Advanced), then right-click the server and
              pick Copy Server ID. It is 17 to 20 digits.
            </Field.FieldDescription>
          </Field.Field>
        {:else}
          <Field.Field>
            <Field.FieldLabel for="room-token">Bot token</Field.FieldLabel>
            <Input
              id="room-token"
              required
              type="password"
              autocomplete="off"
              bind:value={newToken}
              placeholder="123456789:ABC…"
            />
            <Field.FieldDescription>
              Turn the bot's privacy mode off first (BotFather: /setprivacy, Disable), or re-add
              the bot after changing it. With privacy mode on, Telegram never delivers the mention
              that links the room. Only messages that mention the bot or reply to it reach an
              agent.
            </Field.FieldDescription>
          </Field.Field>
        {/if}
        {@render quiet("room-quiet", newQuiet, (on) => (newQuiet = on))}
      </Field.FieldGroup>
      <Dialog.Footer>
        <Button
          type="button"
          variant="ghost"
          onclick={() => {
            createOpen = false;
          }}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={creating || !createReady}>
          {#if creating}
            <Spinner data-icon="inline-start" />
          {/if}
          Add
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root
  open={editTarget !== null}
  onOpenChange={(open) => {
    if (!open) editTarget = null;
  }}
>
  <Dialog.Content>
    <form onsubmit={submitEdit} class="flex flex-col gap-4">
      <Dialog.Header>
        <Dialog.Title>Edit "{editTarget?.name}"</Dialog.Title>
      </Dialog.Header>
      <Field.FieldGroup>
        <Field.Field>
          <Field.FieldLabel for="edit-name">Name</Field.FieldLabel>
          <Input id="edit-name" required bind:value={editName} />
        </Field.Field>
        {@render quiet("edit-quiet", editQuiet, (on) => (editQuiet = on))}
      </Field.FieldGroup>
      <Dialog.Footer>
        <Button
          type="button"
          variant="ghost"
          onclick={() => {
            editTarget = null;
          }}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !editName.trim()}>
          {#if saving}
            <Spinner data-icon="inline-start" />
          {/if}
          Save
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root
  open={archiveTarget !== null}
  onOpenChange={(open) => {
    if (!open) archiveTarget = null;
  }}
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Archive "{archiveTarget?.name}"?</AlertDialog.Title>
      <AlertDialog.Description>
        No new response binds to it, and the bot stops listening. A run already bound keeps its
        conversation until it ends, but nothing the room says reaches it any more. This cannot be
        undone.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action disabled={archiving} onclick={submitArchive}>
        {#if archiving}
          <Spinner data-icon="inline-start" />
        {/if}
        Archive
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
