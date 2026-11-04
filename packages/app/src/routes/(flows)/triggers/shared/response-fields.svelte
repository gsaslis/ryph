<script lang="ts">
import { type Chatroom, CONVERSATION_NOUN, isOneConversation } from "$lib/api/types";
import { presetById, type ResponseChoice, withArticle } from "$lib/automations/presets";
import PickCard from "$lib/components/pick-card/pick-card.svelte";
import ResponseRoomFields from "$lib/components/response-room-fields/response-room-fields.svelte";
import * as Alert from "$lib/components/ui/alert";
import { Badge } from "$lib/components/ui/badge";
import { Checkbox } from "$lib/components/ui/checkbox";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import LayersIcon from "@lucide/svelte/icons/layers";
import MessageSquarePlusIcon from "@lucide/svelte/icons/message-square-plus";
import MessagesSquareIcon from "@lucide/svelte/icons/messages-square";
import PlayIcon from "@lucide/svelte/icons/play";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import { RadioGroup } from "bits-ui";
import {
  oneConversationReason,
  responseChoiceOf,
  responseConflict,
  type ResponseFields,
  type TriggerFields,
  triggerYieldsKeys,
} from "./automation-steps";

// The response step: where a conversation talks, then one question about what each start does,
// phrased in the sender's words. A choice is the person's once made: a trigger or room that no
// longer fits it marks the step and says why, and the choice stays as it was. The room and
// channel are the room fields' business; their verdict on what they hold comes back as `blocked`.
let {
  fields = $bindable(),
  blocked = $bindable(false),
  rooms,
  trigger,
}: {
  fields: ResponseFields;
  /** Set for the parent: the room as picked would only be refused. */
  blocked: boolean;
  /** Every room the page knows, archived ones included. */
  rooms: Chatroom[];
  /** The trigger step as it stands, for the question's words and what it can offer. */
  trigger: TriggerFields;
} = $props();

const choice = $derived(responseChoiceOf(fields, trigger));
const conflict = $derived(responseConflict(fields, trigger, rooms));
const keyed = $derived(triggerYieldsKeys(trigger));
const sender = $derived(
  trigger.kind === "webhook" && trigger.preset !== null ? presetById(trigger.preset) : null,
);
const schedule = $derived(trigger.kind === "schedule");
// A room that holds one conversation at a time, or one shared topic, can't take the choices that
// keep several open.
const oneRoom = $derived(oneConversationReason(fields, rooms));
// What a conversation is called in the picked room once a channel is picked (a topic, a thread),
// or null where there is no channel to keep them all in.
const channelNoun = $derived.by(() => {
  const room = rooms.find((r) => r.id === fields.chatroomId);
  if (room === undefined || room.archivedAt !== null || isOneConversation(room.kind)) return null;
  return fields.channelId === "" ? null : CONVERSATION_NOUN[room.kind];
});
// Every conversation in one place holds one at a time, so turning it on picks the shared choice.
function setShared(on: boolean) {
  fields.conversation = on ? "shared" : "per-response";
  if (on) fields.choice = "automation";
}
// The idle clocks: quiet before anyone has replied, then the longer one once a person has.
const clockInvalid = (m: number) => !Number.isInteger(m) || m < 1 || m > 1440;

const question = $derived(
  schedule
    ? "When the schedule runs"
    : sender === null || sender.id === "other"
    ? "When a request arrives"
    : `When ${sender.name} sends ${withArticle(sender.eventNoun)}`,
);

type Choice = {
  value: ResponseChoice;
  title: string;
  detail: string;
  example?: string;
  recommended?: boolean;
  disabled?: boolean;
  icon: typeof LayersIcon;
};

const choices = $derived.by<Choice[]>(() => {
  const event = sender?.eventNoun ?? "request";
  const list: Choice[] = [{
    value: "run",
    title: "Start a run",
    detail: "Runs to the end and reports on its page. No conversation.",
    icon: PlayIcon,
  }];
  // Offered only where the sender reads something to group by, but a choice already made stays
  // on screen when it no longer can be, so it can be seen and changed.
  if (keyed || choice === "key") {
    list.push({
      value: "key",
      title: `One conversation per ${sender?.keyNoun ?? "ID"}`,
      detail: oneRoom ??
        `Everything about the same ${sender?.keyNoun ?? "ID"} joins its conversation.`,
      example: oneRoom === null && keyed ? sender?.keyExample : undefined,
      recommended: keyed && sender?.id !== "other",
      disabled: oneRoom !== null || !keyed,
      icon: LayersIcon,
    });
  }
  list.push(
    {
      value: "fire",
      title: schedule ? "One conversation per run" : "One conversation per request",
      detail: oneRoom ??
        (schedule
          ? "Each run opens its own conversation."
          : sender === null || sender.id === "other"
          ? "Every request opens its own conversation."
          : `Every ${event} opens its own conversation, even a resolve.`),
      disabled: oneRoom !== null,
      icon: MessageSquarePlusIcon,
    },
    {
      value: "automation",
      title: "One shared conversation",
      detail: "Everything joins the open conversation until it ends.",
      icon: MessagesSquareIcon,
    },
  );
  return list;
});
</script>

{#snippet clock(id: string, label: string, key: "idleMinutes" | "attendedIdleMinutes")}
  {@const invalid = choice !== "run" && clockInvalid(fields[key])}
  <Field.Field data-invalid={invalid || undefined}>
  <Field.FieldLabel for={id}>{label}</Field.FieldLabel>
  <div class="flex items-center gap-2">
    <Input
      {id}
      type="number"
      min="1"
      max="1440"
      step="1"
      bind:value={fields[key]}
      aria-invalid={invalid || undefined}
      class="w-24"
    />
    <span class="text-muted-foreground text-sm">minutes of quiet</span>
  </div>
</Field.Field>
{/snippet}

<Field.FieldGroup>
  {#if conflict !== null}
    <Alert.Root variant="destructive">
      <TriangleAlertIcon />
      <Alert.Title>This choice no longer fits</Alert.Title>
      <Alert.Description>{conflict}</Alert.Description>
    </Alert.Root>
  {/if}

  <Field.FieldSet disabled={choice === "run"} class={[choice === "run" && "opacity-60"]}>
    <Field.FieldLegend>Where it talks</Field.FieldLegend>
    <Field.FieldGroup>
      <ResponseRoomFields
        {rooms}
        bind:chatroomId={fields.chatroomId}
        bind:channelId={fields.channelId}
        bind:blocked
      />
      {#if !schedule}
        <Field.Field orientation="horizontal" data-disabled={fields.chatroomId === "" || undefined}>
          <Checkbox
            id="response-post-alert"
            bind:checked={fields.postAlert}
            disabled={fields.chatroomId === ""}
          />
          <Field.FieldContent>
            <Field.FieldLabel for="response-post-alert">
              Post the {sender?.eventNoun ?? "request"} in the first message
            </Field.FieldLabel>
            <Field.FieldDescription>
              The room sees what came in without opening the run.
            </Field.FieldDescription>
          </Field.FieldContent>
        </Field.Field>
      {/if}
      {#if channelNoun !== null}
        <Field.Field orientation="horizontal">
          <Checkbox
            id="response-shared"
            bind:checked={() => fields.conversation === "shared", setShared}
          />
          <Field.FieldContent>
            <Field.FieldLabel for="response-shared">
              Post every response in one {channelNoun}
            </Field.FieldLabel>
            <Field.FieldDescription>
              Every response continues in the same {channelNoun}.
            </Field.FieldDescription>
          </Field.FieldContent>
        </Field.Field>
      {/if}
    </Field.FieldGroup>
  </Field.FieldSet>
  {#if choice === "run"}
    <Field.FieldDescription class="-mt-4">
      A run talks only on its page. Pick a conversation below to talk in a room.
    </Field.FieldDescription>
  {/if}

  <Field.FieldSet>
    <Field.FieldLegend id="response-question">{question}</Field.FieldLegend>
    <RadioGroup.Root
      value={choice}
      onValueChange={(value) => (fields.choice = value as ResponseChoice)}
      aria-labelledby="response-question"
      class="grid grid-cols-1 gap-2"
    >
      {#each choices as c (c.value)}
        {@const Icon = c.icon}
        <PickCard value={c.value} disabled={c.disabled} wrap>
          {#snippet media()}
            <span class="bg-background ring-border flex size-8 items-center justify-center rounded-md ring-1">
              <Icon class="size-4" />
            </span>
          {/snippet}
          {#snippet title()}
            <span class="flex flex-wrap items-center gap-2">
              {c.title}
              {#if c.recommended}
                <Badge variant="secondary">Recommended</Badge>
              {/if}
            </span>
          {/snippet}
          {#snippet meta()}
            {c.detail}
            {#if c.example}
              <span class="text-foreground/70 mt-1 block">{c.example}</span>
            {/if}
          {/snippet}
        </PickCard>
      {/each}
    </RadioGroup.Root>
  </Field.FieldSet>

  <Field.FieldSet disabled={choice === "run"} class={[choice === "run" && "opacity-60"]}>
    <Field.FieldLegend>When it ends</Field.FieldLegend>
    <Field.FieldDescription>
      The conversation ends when the agent says it's done, or after a stretch of quiet.
    </Field.FieldDescription>
    <div class="grid gap-6 sm:grid-cols-2">
      {@render clock("idle-minutes", "If nobody has replied", "idleMinutes")}
      {@render clock("attended-idle-minutes", "After someone replies", "attendedIdleMinutes")}
    </div>
  </Field.FieldSet>
  {#if choice === "run"}
    <Field.FieldDescription class="-mt-4">A run ends when its work is done.</Field.FieldDescription>
  {/if}
</Field.FieldGroup>
