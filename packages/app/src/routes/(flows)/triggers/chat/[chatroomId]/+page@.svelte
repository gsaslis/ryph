<script lang="ts">
import { goto, pushState } from "$app/navigation";
import { page } from "$app/state";
import {
  accessProblem,
  agentsProblem,
  type ChannelRowFields,
  checkoutProblem,
  commandRoomToFields,
  composeCommandRoom,
  deleteCommandRoom,
  isPublicChannel,
  MAX_STARTS_PER_HOUR,
  saveCommandRoom,
  targetToFields,
  VISIBILITY_LABEL,
} from "$lib/api/command-rooms";
import {
  type ChatChannel,
  CHATROOM_KIND_LABEL,
  GROUP_NOUN,
  isOneConversation,
} from "$lib/api/types";
import ReviewFact from "$lib/components/stepped-flow/review-fact.svelte";
import ReviewSection from "$lib/components/stepped-flow/review-section.svelte";
import SteppedFlow, { type FlowStepItem } from "$lib/components/stepped-flow/stepped-flow.svelte";
import { stepOf } from "$lib/components/stepped-flow/steps";
import UnsavedChangesGuard from "$lib/components/unsaved-changes-guard/unsaved-changes-guard.svelte";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Checkbox } from "$lib/components/ui/checkbox";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import * as Select from "$lib/components/ui/select";
import { Spinner } from "$lib/components/ui/spinner";
import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
import CheckIcon from "@lucide/svelte/icons/check";
import PlusIcon from "@lucide/svelte/icons/plus";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import XIcon from "@lucide/svelte/icons/x";
import { untrack } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { toast } from "svelte-sonner";
import TargetFields from "./target-fields.svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// A chat command is a trigger: it is listed, opened and left from the triggers page.
const BACK = "/triggers";

// Whether the room has channels: a channel may then carry its own target, and the commanders
// may be a platform group. A Telegram group is one conversation with neither.
const channelled = $derived(!isOneConversation(data.chatroom.kind));
const platform = $derived(CHATROOM_KIND_LABEL[data.chatroom.kind]);
// What the platform calls the groups commanders may be: a user group, or a Discord role.
const groupNoun = $derived(GROUP_NOUN[data.chatroom.kind]);

// The form seeds from the saved policy (or a new room's defaults) and diverges as the admin
// edits, so capturing the initial value is what we want here.
// svelte-ignore state_referenced_locally
let fields = $state(commandRoomToFields(data.commandRoom, data.chatroom.kind));
let saving = $state(false);
const creating = $derived(data.commandRoom === null);

// Whether anything differs from what was loaded, for the guard against leaving by accident; a
// successful save sets `saved` so the move away goes through.
let saved = $state(false);
const pristine = untrack(() => JSON.stringify(fields));
const dirty = $derived(!saved && JSON.stringify(fields) !== pristine);

// ---- steps ----
// The same shell as the webhook and schedule triggers: made in steps ending in a review, edited
// in the same steps with Save on every one.
type StepId = "agents" | "checkout" | "access" | "review";
const ALL_STEPS: { id: StepId; label: string; heading: string; description: string }[] = [
  {
    id: "agents",
    label: "Agents",
    heading: "Agents",
    description: "Which agents a mention can reach, and which one answers by default.",
  },
  {
    id: "checkout",
    label: "Code",
    heading: "Code",
    description: "The repository or workspace a run starts with.",
  },
  {
    id: "access",
    label: "Access",
    heading: "Access",
    description: "Who can use the command, and how many runs it can start.",
  },
  {
    id: "review",
    label: "Review",
    heading: "Review",
    description:
      "Runs use the permissions of whoever saves this. Repository access is checked each time a run starts.",
  },
];
const STEPS = $derived(creating ? ALL_STEPS : ALL_STEPS.filter((s) => s.id !== "review"));
const current = $derived(stepOf(page.state, STEPS, page.url.searchParams.get("step")) as StepId);
const index = $derived(STEPS.findIndex((s) => s.id === current));

const problems = $derived<Record<StepId, string | null>>({
  agents: agentsProblem(fields),
  checkout: checkoutProblem(fields),
  access: accessProblem(fields, groupNoun),
  review: null,
});

// A new command marks a step only once it has been seen, as the trigger flow does; an existing
// one has been seen whole, so every problem shows at once.
const visited = new SvelteSet<string>();
$effect(() => {
  const here = current;
  untrack(() => visited.add(here));
});
let attempted = $state(false);

function statusOf(id: StepId): FlowStepItem["status"] {
  if (id === "review") return "todo";
  const problem = problems[id] !== null;
  if (!creating) return problem ? "problem" : "done";
  if (problem) return attempted || (visited.has(id) && id !== current) ? "problem" : "todo";
  return visited.has(id) || id === current ? "done" : "todo";
}
const steps = $derived<FlowStepItem[]>(STEPS.map((s) => ({ ...s, status: statusOf(s.id) })));

// The step on screen lives in the history entry (shallow routing), so back and forward walk it.
function go(id: StepId) {
  if (id !== current) pushState("", { step: id });
}
let deleteOpen = $state(false);
let deleting = $state(false);

// The agents the list offers: every live one, plus any listed agent since archived — flagged, so
// it can be unticked knowingly rather than vanishing from the save.
const agentRows = $derived([
  ...data.agents,
  ...fields.agentIds
    .filter((id) => !data.agents.some((a) => a.id === id))
    .map((id) => ({ id, name: id, archivedAt: "gone" })),
]);
const agentName = (id: string) => data.agents.find((a) => a.id === id)?.name ?? id;
const defaultAgentLabel = $derived(
  fields.agentIds.includes(fields.defaultAgentId)
    ? agentName(fields.defaultAgentId)
    : "Select the default agent",
);

function setAgent(id: string, on: boolean) {
  const rest = fields.agentIds.filter((a) => a !== id);
  fields.agentIds = on ? [...rest, id] : rest;
  // One agent is its own default; a default unticked is no default.
  if (fields.agentIds.length === 1) fields.defaultAgentId = fields.agentIds[0];
  else if (!fields.agentIds.includes(fields.defaultAgentId)) fields.defaultAgentId = "";
}

// ---- commanders ----
const COMMANDERS_LABEL = $derived({
  group: groupNoun === "role" ? "Everyone with a role" : `Members of a ${groupNoun}`,
  room: "Everyone in the room (private channels only)",
});
const groupLabel = $derived(
  data.groups?.find((g) => g.id === fields.groupId)?.name ??
    (fields.groupId === "" ? `Select a ${groupNoun}` : `${groupNoun} ${fields.groupId}`),
);

// ---- channels ----
// The platform's list, with any saved channel it no longer lists kept (by its saved name) so the
// row still shows what it is.
const channelById = $derived(new Map((data.channels ?? []).map((c) => [c.id, c])));
const channelOf = (row: ChannelRowFields): ChatChannel | undefined =>
  channelById.get(row.channelId);
const channelLabel = (channel: ChatChannel) =>
  `#${channel.name} · ${VISIBILITY_LABEL[channel.visibility]}`;
const unlisted = $derived(
  (data.channels ?? []).filter((c) => !fields.channels.some((row) => row.channelId === c.id)),
);

function addChannel() {
  fields.channels = [
    ...fields.channels,
    { channelId: "", channelName: "", target: { ...targetToFields(null), kind: "repo" } },
  ];
}

function pickChannel(index: number, id: string) {
  const channel = channelById.get(id);
  fields.channels[index].channelId = id;
  fields.channels[index].channelName = channel?.name ?? id;
}

function removeChannel(index: number) {
  fields.channels = fields.channels.filter((_, i) => i !== index);
}

// Enter in a field moves on while creating; only the review's button creates. Editing saves.
function submit(event: SubmitEvent) {
  event.preventDefault();
  if (creating && current !== "review") {
    const next = STEPS[index + 1];
    if (next) go(next.id);
    return;
  }
  void save();
}

async function save() {
  attempted = true;
  const problem = STEPS.find((s) => problems[s.id] !== null);
  if (problem) {
    toast.error(problems[problem.id] ?? "Something on this step needs fixing.");
    go(problem.id);
    return;
  }
  saving = true;
  try {
    await saveCommandRoom(fetch, data.chatroom.id, composeCommandRoom(fields));
    toast.success(
      creating
        ? `Created the chat command for "${data.chatroom.name}"`
        : `Saved the chat command for "${data.chatroom.name}"`,
    );
    saved = true;
    await goto(BACK);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Couldn't save the chat command");
  } finally {
    saving = false;
  }
}

async function handleDelete() {
  deleting = true;
  try {
    await deleteCommandRoom(fetch, data.chatroom.id);
    toast.success(`Deleted the chat command for "${data.chatroom.name}"`);
    saved = true;
    await goto(BACK);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Couldn't delete the chat command");
  } finally {
    deleting = false;
  }
}

// The review's lines, each step said in a few words.
const targetSummary = (t: typeof fields.defaultTarget) => {
  if (t.kind === "none") return "None";
  if (t.kind === "workspace") {
    return data.workspaces.find((w) => w.workspace.id === t.workspaceId)?.workspace.name ??
      "A workspace";
  }
  const repo = data.repos.find((r) => r.id === t.connectedRepoId);
  return repo ? `${repo.repoRef}${t.ref.trim() ? ` @ ${t.ref.trim()}` : ""}` : "A repository";
};
const commandersSummary = $derived(
  !channelled
    ? "Everyone in the group"
    : fields.commanders === "room"
    ? "Everyone in the room (private channels only)"
    : groupNoun === "role"
    ? `Everyone with ${groupLabel}`
    : `Members of ${groupLabel}`,
);
</script>

<svelte:head>
  <title>Chat command · {data.chatroom.name} · Ryph</title>
</svelte:head>

<UnsavedChangesGuard {dirty} />

<form onsubmit={submit} novalidate class="contents">
  <SteppedFlow
    cancelHref={BACK}
    title={creating ? `New chat command in ${data.chatroom.name}` : `Chat command in ${data.chatroom.name}`}
    {steps}
    {current}
    select={(id) => go(id as StepId)}
  >
    {#snippet children(shown: string)}
      <div hidden={shown !== "agents"} class="max-w-2xl">
        <Field.FieldGroup>
          <div class="flex items-center gap-2">
            <Badge variant="outline">{platform}</Badge>
            {#if data.chatroom.realmUrl}
              <span class="text-muted-foreground font-mono text-xs">{data.chatroom.realmUrl}</span>
            {:else}
              <span class="text-muted-foreground text-xs">@{data.chatroom.botUsername}</span>
            {/if}
          </div>
            <Field.FieldSet>
              <Field.FieldLegend class="sr-only">Agents</Field.FieldLegend>
              <Field.FieldDescription>
                Write <code>@bot investigate this</code> to use the default agent, or
                <code>@bot ada investigate this</code> to pick one by handle. In a public room,
                anyone who can post there can give these agents instructions.
              </Field.FieldDescription>
              <div class="flex flex-col gap-2">
                {#each agentRows as agent (agent.id)}
                  <div class="flex items-center gap-2">
                    <Checkbox
                      id="agent-{agent.id}"
                      checked={fields.agentIds.includes(agent.id)}
                      onCheckedChange={(checked) => setAgent(agent.id, checked === true)}
                    />
                    <Label for="agent-{agent.id}" class="flex items-center gap-2">
                      {agent.name}
                      {#if agent.archivedAt}
                        <Badge variant="destructive">Archived</Badge>
                      {/if}
                    </Label>
                  </div>
                {:else}
                  <p class="text-muted-foreground text-sm">No agents yet — create one first.</p>
                {/each}
              </div>
              {#if fields.agentIds.length > 1}
                <Field.Field>
                  <Field.FieldLabel for="default-agent">Default agent</Field.FieldLabel>
                  <Select.Root type="single" bind:value={fields.defaultAgentId}>
                    <Select.Trigger id="default-agent" class="w-full">{defaultAgentLabel}</Select.Trigger>
                    <Select.Content>
                      <Select.Group>
                        {#each fields.agentIds as id (id)}
                          <Select.Item value={id} label={agentName(id)} />
                        {/each}
                      </Select.Group>
                    </Select.Content>
                  </Select.Root>
                </Field.Field>
              {/if}
            </Field.FieldSet>
        </Field.FieldGroup>
      </div>
      <div hidden={shown !== "checkout"} class="max-w-2xl">
        <Field.FieldGroup>
            <Field.FieldSet>
              <Field.FieldLegend class="sr-only">What a run checks out</Field.FieldLegend>
              <Field.Field>
                <Field.FieldLabel for="default-target-kind">Repo or workspace</Field.FieldLabel>
                <!-- "None" only means something where channels below can have their own. A
                     Telegram group is one conversation with nothing to fall back on. -->
                <TargetFields
                  bind:fields={fields.defaultTarget}
                  repos={data.repos}
                  workspaces={data.workspaces}
                  id="default-target"
                  noneLabel={channelled ? "None (only the channels below)" : null}
                />
                {#if channelled}
                  <Field.FieldDescription>
                    Channels below can use a different one. Public channels can only use public
                    repositories.
                  </Field.FieldDescription>
                {/if}
              </Field.Field>

              {#if channelled}
                <Field.Field>
                  <Field.FieldLabel>Channel targets</Field.FieldLabel>
                  {#if data.channels === null}
                    <Field.FieldDescription>
                      Couldn't load channels from {platform}. Saved channels are unchanged.
                    </Field.FieldDescription>
                  {/if}
                  <div class="flex flex-col gap-4">
                    {#each fields.channels as row, index (index)}
                      {@const channel = channelOf(row)}
                      <div class="flex flex-col gap-3 rounded-lg border p-3">
                        <div class="flex items-center gap-2">
                          <Select.Root
                            type="single"
                            value={row.channelId}
                            onValueChange={(value) => pickChannel(index, value)}
                            disabled={data.channels === null}
                          >
                            <Select.Trigger id="channel-{index}" class="w-full" aria-label="Channel">
                              {channel
                                ? channelLabel(channel)
                                : row.channelId === ""
                                ? "Select a channel"
                                : `#${row.channelName}`}
                            </Select.Trigger>
                            <Select.Content>
                              <Select.Group>
                                {#if channel}
                                  <Select.Item value={channel.id} label={channelLabel(channel)} />
                                {/if}
                                {#each unlisted as other (other.id)}
                                  <Select.Item value={other.id} label={channelLabel(other)} />
                                {/each}
                              </Select.Group>
                            </Select.Content>
                          </Select.Root>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label="Remove channel"
                            onclick={() => removeChannel(index)}
                          >
                            <XIcon />
                          </Button>
                        </div>
                        {#if channel && isPublicChannel(channel.visibility)}
                          <Badge
                            class="bg-warning text-warning-foreground"
                            title="People outside the room can read what the agent posts here"
                          >
                            <TriangleAlertIcon data-icon="inline-start" />
                            {VISIBILITY_LABEL[channel.visibility]} channel: public repositories only
                          </Badge>
                        {:else if row.channelId !== "" && !channel && data.channels !== null}
                          <Badge variant="destructive">Channel not found in {platform}</Badge>
                        {/if}
                        <TargetFields
                          bind:fields={row.target}
                          repos={data.repos}
                          workspaces={data.workspaces}
                          id="channel-{index}-target"
                        />
                      </div>
                    {/each}
                    <div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={data.channels === null || unlisted.length === 0}
                        onclick={addChannel}
                      >
                        <PlusIcon data-icon="inline-start" />
                        Add a channel
                      </Button>
                    </div>
                    {#if data.channelsTruncated}
                      <Field.FieldDescription>
                        This workspace has more channels than {platform} lists in one read, so a
                        channel you expect may not be here.
                      </Field.FieldDescription>
                    {/if}
                  </div>
                </Field.Field>
              {/if}
            </Field.FieldSet>
        </Field.FieldGroup>
      </div>
      <div hidden={shown !== "access"} class="max-w-2xl">
        <Field.FieldGroup>
            <Field.FieldSet>
              <Field.FieldLegend class="sr-only">Commanders</Field.FieldLegend>
              <Field.FieldDescription>
                Checked on every mention. Mentions from anyone else are ignored.
              </Field.FieldDescription>
              {#if channelled}
                <Select.Root
                  type="single"
                  value={fields.commanders}
                  onValueChange={(value) => {
                    fields.commanders = value as typeof fields.commanders;
                  }}
                >
                  <Select.Trigger id="commanders" class="w-full">
                    {COMMANDERS_LABEL[fields.commanders]}
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Group>
                      <Select.Item value="group" label={COMMANDERS_LABEL.group} />
                      <Select.Item value="room" label={COMMANDERS_LABEL.room} />
                    </Select.Group>
                  </Select.Content>
                </Select.Root>
                {#if fields.commanders === "group"}
                  <Field.Field>
                    <Field.FieldLabel for="commander-group">
                      {groupNoun === "role" ? "Role" : "User group"}
                    </Field.FieldLabel>
                    <Select.Root type="single" bind:value={fields.groupId} disabled={data.groups === null}>
                      <Select.Trigger id="commander-group" class="w-full">{groupLabel}</Select.Trigger>
                      <Select.Content>
                        <Select.Group>
                          {#each data.groups ?? [] as group (group.id)}
                            <Select.Item value={group.id} label={group.name} />
                          {/each}
                        </Select.Group>
                      </Select.Content>
                    </Select.Root>
                    <Field.FieldDescription>
                      {#if data.groups === null}
                        Couldn't load {groupNoun}s from {platform}.
                      {:else}
                        Checked against {platform} on every mention, so membership changes
                        apply right away.
                      {/if}
                    </Field.FieldDescription>
                  </Field.Field>
                {:else}
                  <Field.FieldDescription>
                    Only works in private channels. Mentions in public channels are refused.
                  </Field.FieldDescription>
                {/if}
              {:else}
                <p class="text-sm">
                  Everyone in the group.
                </p>
              {/if}
            </Field.FieldSet>
            <Field.Field>
              <Field.FieldLabel for="starts-per-hour">Runs per hour</Field.FieldLabel>
              <Input
                id="starts-per-hour"
                type="number"
                min="1"
                max={MAX_STARTS_PER_HOUR}
                bind:value={fields.startsPerHour}
              />
              <Field.FieldDescription>
                The most runs mentions can start in an hour. Messages to a run that's already going don't
                count.
              </Field.FieldDescription>
            </Field.Field>
        </Field.FieldGroup>
      </div>
      {#if creating}
        <div hidden={shown !== "review"} class="flex max-w-2xl flex-col gap-8">
          <ReviewSection label="Agents" problem={problems.agents} onchange={() => go("agents")}>
            <dl class="divide-y">
              <ReviewFact
                term="Agents"
                value={fields.agentIds.map(agentName).join(", ") || "—"}
              />
              <ReviewFact
                term="Default"
                value={fields.agentIds.includes(fields.defaultAgentId)
                  ? agentName(fields.defaultAgentId)
                  : "—"}
              />
            </dl>
          </ReviewSection>
          <ReviewSection label="Code" problem={problems.checkout} onchange={() => go("checkout")}>
            <dl class="divide-y">
              <ReviewFact term="Default target" value={targetSummary(fields.defaultTarget)} />
              {#each fields.channels as row, i (i)}
                <ReviewFact
                  term={`#${row.channelName || "channel"}`}
                  value={targetSummary(row.target)}
                />
              {/each}
            </dl>
          </ReviewSection>
          <ReviewSection label="Access" problem={problems.access} onchange={() => go("access")}>
            <dl class="divide-y">
              <ReviewFact term="Who can use it" value={commandersSummary} />
              <ReviewFact term="Runs per hour" value={String(fields.startsPerHour)} />
            </dl>
          </ReviewSection>
        </div>
      {/if}
    {/snippet}

    {#snippet footer()}
      <div class="flex items-center gap-2">
        <Button variant="ghost" href={BACK}>Cancel</Button>
        {#if !creating}
          <Button variant="destructive" type="button" onclick={() => (deleteOpen = true)}>
            Delete
          </Button>
        {/if}
      </div>
      <div class="flex items-center gap-2">
        {#if creating}
          <Button
            variant="outline"
            type="button"
            disabled={index === 0}
            onclick={() => go(STEPS[index - 1].id)}
          >
            <ArrowLeftIcon data-icon="inline-start" />
            Back
          </Button>
          {#if current === "review"}
            <Button type="submit" disabled={saving}>
              {#if saving}
                <Spinner data-icon="inline-start" />
              {:else}
                <PlusIcon data-icon="inline-start" />
              {/if}
              Create chat command
            </Button>
          {:else}
            <Button type="submit">
              Next
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          {/if}
        {:else}
          <Button
            variant="outline"
            size="icon"
            class="max-sm:hidden"
            type="button"
            aria-label="Previous step"
            disabled={index === 0}
            onclick={() => go(STEPS[index - 1].id)}
          >
            <ArrowLeftIcon />
          </Button>
          <Button
            variant="outline"
            size="icon"
            class="max-sm:hidden"
            type="button"
            aria-label="Next step"
            disabled={index === STEPS.length - 1}
            onclick={() => go(STEPS[index + 1].id)}
          >
            <ArrowRightIcon />
          </Button>
          <Button type="submit" disabled={saving}>
            {#if saving}
              <Spinner data-icon="inline-start" />
            {:else}
              <CheckIcon data-icon="inline-start" />
            {/if}
            Save changes
          </Button>
        {/if}
      </div>
    {/snippet}
  </SteppedFlow>
</form>

<AlertDialog.Root bind:open={deleteOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete the chat command in "{data.chatroom.name}"?</AlertDialog.Title>
      <AlertDialog.Description>
        Mentioning the bot there will no longer start runs. Runs it already started keep going, and
        the chat connection stays.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action disabled={deleting} onclick={handleDelete}>
        {#if deleting}
          <Spinner data-icon="inline-start" />
        {/if}
        Delete
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
