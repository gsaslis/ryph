<script lang="ts">
import { ApiError } from "$lib/api/call";
import { getChatroomChannels } from "$lib/api/chatrooms";
import { isPublicChannel, VISIBILITY_LABEL } from "$lib/api/command-rooms";
import {
  type ChatChannel,
  type Chatroom,
  CHATROOM_KIND_LABEL,
  isOneConversation,
} from "$lib/api/types";
import { Badge } from "$lib/components/ui/badge";
import * as Field from "$lib/components/ui/field";
import * as Select from "$lib/components/ui/select";

/**
 * Where a response reports: a room, or none (the run page is then the only room); and, for a room
 * with channels, the one each response opens its own conversation in — a Zulip topic, a Slack
 * thread, a Discord thread named after the response's topic. The channel list is asked live once such a room is picked, never in the page load, since
 * the chat service lists channels only to the room's creator and admins and everyone else must
 * still get the form.
 *
 * A response opens in a private channel only: the channel's members are who may steer the agent
 * and who sees what it posts. Every channel the room reports is listed so the picker reads as the
 * platform does, but a public or web-public one cannot be picked.
 */
let {
  rooms,
  chatroomId = $bindable(),
  channelId = $bindable(),
  blocked = $bindable(false),
  id = "chatroom",
}: {
  /** Every room the page knows, archived ones included: only the live ones are offered, but an
   * archived room a saved policy still binds keeps its name (and blocks the save). */
  rooms: Chatroom[];
  /** The picked room's id, or "" for none. */
  chatroomId: string;
  /** The picked channel's platform id, or "". Cleared whenever the room changes. */
  channelId: string;
  /** Set for the parent: the fields as they stand would only be refused — the bound room is
   * archived, or a room with channels is picked with no private one that can be sent for it. */
  blocked: boolean;
  id?: string;
} = $props();

type Channels =
  | { kind: "loading" }
  // `truncated`: the platform had more channels than it listed, so one missing here may exist.
  | { kind: "listed"; channels: ChatChannel[]; truncated: boolean }
  // The chat service lists a room's channels to its creator and admins only.
  | { kind: "forbidden" }
  // The platform did not answer (or the room is gone).
  | { kind: "unavailable" };

const liveRooms = $derived(rooms.filter((r) => r.archivedAt === null));
const room = $derived(rooms.find((r) => r.id === chatroomId));
const archived = $derived(room !== undefined && room.archivedAt !== null);
// An archived room asks for nothing: the save is refused whatever the channel.
const channelled = $derived(room !== undefined && !isOneConversation(room.kind) && !archived);
const platform = $derived(room === undefined ? "The platform" : CHATROOM_KIND_LABEL[room.kind]);

const roomLabel = $derived(
  chatroomId === ""
    ? "No chatroom, just the run page"
    : room === undefined
    ? chatroomId
    : archived
    ? `${room.name} (archived)`
    : room.name,
);

let channels = $state<Channels>({ kind: "loading" });
// The list is the picked room's own: an answer for a room no longer picked is dropped.
let asked = 0;
$effect(() => {
  if (!channelled || room === undefined) return;
  const roomId = room.id;
  const ticket = ++asked;
  channels = { kind: "loading" };
  getChatroomChannels(fetch, roomId).then(
    (listed) => {
      if (ticket === asked) {
        channels = { kind: "listed", channels: listed.channels, truncated: listed.truncated };
      }
    },
    (e: unknown) => {
      if (ticket !== asked) return;
      channels = e instanceof ApiError && e.status === 403
        ? { kind: "forbidden" }
        : { kind: "unavailable" };
    },
  );
});

const channel = $derived(
  channels.kind === "listed" ? channels.channels.find((c) => c.id === channelId) : undefined,
);
// A private channel is the only kind that can be picked, so only the others say what they are.
const channelLabel = (c: ChatChannel) =>
  isPublicChannel(c.visibility) ? `#${c.name} · ${VISIBILITY_LABEL[c.visibility]}` : `#${c.name}`;
const pickedChannelLabel = $derived(
  channel ? channelLabel(channel) : channelId === "" ? "Select a channel" : `channel ${channelId}`,
);
// A saved policy's channel the platform has since opened up: the service refuses it now.
const channelWentPublic = $derived(channel !== undefined && isPublicChannel(channel.visibility));

// A room with channels needs a private one; one nobody here may pick, one the list no longer
// holds or one no longer private leaves the save with nothing the service would accept. A channel
// kept from the saved policy while the platform is not answering is still sent — the service
// checks it against the room's list.
$effect(() => {
  blocked = archived ||
    (channelled &&
      (channels.kind === "forbidden" ||
        channelId === "" ||
        (channels.kind === "listed" && (channel === undefined || channelWentPublic))));
});

function pickRoom(value: string) {
  const next = value === "none" ? "" : value;
  if (next === chatroomId) return;
  chatroomId = next;
  channelId = "";
}
</script>

<Field.Field>
  <Field.FieldLabel for={id}>Chatroom</Field.FieldLabel>
  <Select.Root type="single" value={chatroomId} onValueChange={pickRoom}>
    <Select.Trigger {id} class="w-full">{roomLabel}</Select.Trigger>
    <Select.Content>
      <Select.Group>
        <Select.Item value="none" label="No chatroom, just the run page" />
        {#each liveRooms as r (r.id)}
          <Select.Item value={r.id} label={r.name} />
        {/each}
      </Select.Group>
    </Select.Content>
  </Select.Root>
  {#if archived}
    <Field.FieldDescription>This room was archived — pick another.</Field.FieldDescription>
  {:else}
    <Field.FieldDescription>
      The agent reports into the room and whoever mentions its bot there can steer it. A room with
      channels asks for one, and each response gets a conversation of its own there.
      {#if liveRooms.length === 0}
        None yet. Add one under Chatrooms.
      {/if}
    </Field.FieldDescription>
  {/if}
</Field.Field>

{#if channelled}
  <Field.Field>
    <Field.FieldLabel for="{id}-channel">Channel</Field.FieldLabel>
    <Select.Root
      type="single"
      value={channelId}
      onValueChange={(value) => {
        channelId = value;
      }}
      disabled={channels.kind !== "listed"}
    >
      <Select.Trigger id="{id}-channel" class="w-full">
        {#if channels.kind === "loading"}
          Listing channels…
        {:else}
          {pickedChannelLabel}
        {/if}
      </Select.Trigger>
      <Select.Content>
        <Select.Group>
          {#if channels.kind === "listed"}
            {#each channels.channels as c (c.id)}
              <Select.Item
                value={c.id}
                label={channelLabel(c)}
                disabled={isPublicChannel(c.visibility)}
              />
            {/each}
          {/if}
        </Select.Group>
      </Select.Content>
    </Select.Root>
    <Field.FieldDescription>
      Responses open in private channels only — the channel's members are who may steer the agent
      and who sees what it posts.
    </Field.FieldDescription>
    {#if channels.kind === "forbidden"}
      <Field.FieldDescription>
        Only this room's creator or an admin can pick a channel here.
      </Field.FieldDescription>
    {:else if channels.kind === "unavailable"}
      <Field.FieldDescription>
        {platform} did not answer, so its channels cannot be listed right now.
      </Field.FieldDescription>
    {:else if channelWentPublic}
      <Badge variant="destructive">{platform} now lists this channel as public</Badge>
    {:else if channels.kind === "listed" && channelId !== "" && !channel}
      <Badge variant="destructive">{platform} no longer lists this channel</Badge>
    {:else if channels.kind === "listed" && channels.truncated}
      <Field.FieldDescription>
        This workspace has more channels than {platform} lists in one read, so a channel you expect
        may not be here.
      </Field.FieldDescription>
    {/if}
  </Field.Field>
{/if}
