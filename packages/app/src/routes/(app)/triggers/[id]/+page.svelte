<script lang="ts">
import ObjectHeader from "$lib/components/object-header/object-header.svelte";
import { goto, invalidate } from "$app/navigation";
import {
  deleteAutomation,
  disableAutomation,
  enableAutomation,
  rotateAutomationSecret,
} from "$lib/api/automations";
import { CONVERSATION_NOUN, TERMINAL_RUN_STATES } from "$lib/api/types";
import { PRESET_ICONS } from "$lib/automations/preset-icons";
import {
  awaitingPaste,
  formatLabel,
  presetOfFormat,
  responseSummary,
  secretIsPasted,
} from "$lib/automations/presets";
import PasteSecret from "$lib/components/webhook-setup/paste-secret.svelte";
import WebhookSetup from "$lib/components/webhook-setup/webhook-setup.svelte";
import RunStateBadge from "$lib/components/run-state-badge/run-state-badge.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import * as Alert from "$lib/components/ui/alert";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
import { Spinner } from "$lib/components/ui/spinner";
import * as Dialog from "$lib/components/ui/dialog";
import * as Sheet from "$lib/components/ui/sheet";
import * as Empty from "$lib/components/ui/empty";
import { formatDateTime, formatRelativeTime } from "$lib/utils/format";
import { refreshWhileLive } from "$lib/utils/live-refresh.svelte";
import { forgeRepoLabel } from "$lib/utils/forge";
import CircleSlashIcon from "@lucide/svelte/icons/circle-slash";
import ClockIcon from "@lucide/svelte/icons/clock";
import CopyIcon from "@lucide/svelte/icons/copy";
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import ListChecksIcon from "@lucide/svelte/icons/list-checks";
import MoreHorizontalIcon from "@lucide/svelte/icons/more-horizontal";
import MessagesSquareIcon from "@lucide/svelte/icons/messages-square";
import PlugIcon from "@lucide/svelte/icons/plug";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import WebhookIcon from "@lucide/svelte/icons/webhook";
import PauseIcon from "@lucide/svelte/icons/pause";
import PencilIcon from "@lucide/svelte/icons/pencil";
import PlayIcon from "@lucide/svelte/icons/play";
import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
import Trash2Icon from "@lucide/svelte/icons/trash-2";
import ZapIcon from "@lucide/svelte/icons/zap";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";
import { type ActivityRow, activityRows, lasted } from "./activity";

let { data }: PageProps = $props();

const automation = $derived(data.automation);
const currentAgent = $derived(data.agents.find((a) => a.id === automation.agentId));
const agentName = $derived(currentAgent?.name ?? automation.agentId);
// What the runs check out, as the page says it: the repo (and ref), or the workspace by name.
const targetLabel = $derived.by(() => {
  const target = automation.target;
  if (target.kind === "workspace") {
    const name = data.workspaces.find((w) => w.workspace.id === target.workspaceId)?.workspace
      .name ?? target.workspaceId;
    return name;
  }
  const repo = data.repos.find((r) => r.id === target.connectedRepoId);
  const name = (repo ? forgeRepoLabel(repo) : null) ??
    target.connectedRepoId;
  return target.ref ? `${name} (${target.ref})` : name;
});
// The history, one row per run or response, a page at a time.
const rows = $derived(activityRows(data.fires, data.responses));
const PAGE = 20;
let shownRows = $state(PAGE);

// A fire's outcome is its birth record ("started" = it became a run) and never changes;
// the run's CURRENT state comes from the tasks list, kept fresh by the same poll.
const taskStates = $derived(new Map(data.tasks.map((t) => [t.id, t])));
const ingestionUrl = $derived(
  automation.trigger.kind === "webhook"
    ? `${data.automationsOrigin}${automation.trigger.path}`
    : null,
);

// An enabled automation can fire at any moment, and a fire's run keeps moving even after a
// pause — so the page stays fresh while either is true, and goes quiet only when the
// automation is paused AND every linked run has settled.
refreshWhileLive(
  "app:automation",
  () =>
    automation.enabled ||
    data.fires.some((fire) => {
      const task = fire.taskId === null ? undefined : taskStates.get(fire.taskId);
      return task !== undefined && !TERMINAL_RUN_STATES.includes(task.state);
    }),
);

// The sender, as the automation's format names it, and whether its secret is its own (pasted
// here) or one minted here and shown once.
const webhook = $derived(automation.trigger.kind === "webhook" ? automation.trigger : null);
const sender = $derived(webhook === null ? null : presetOfFormat(webhook.format));
const pasted = $derived(webhook !== null && secretIsPasted(webhook.verification, webhook.format));
const awaiting = $derived(webhook !== null && awaitingPaste(webhook.verification, webhook.format));
const vendor = $derived(sender === null || sender.id === "other" ? "the sender" : sender.name);

// What each start does, as the page's one sentence says it: the same words the create flow's
// review uses.
const responseSentence = $derived.by(() => {
  const summary = responseSummary(automation.response?.correlation ?? "run", sender);
  if (!automation.response?.chatroomId) return `${summary}.`;
  const posted = automation.response.postAlert
    ? ` The first message shows the ${sender?.eventNoun ?? "request"}.`
    : "";
  const room = data.chatrooms.find((r) => r.id === automation.response?.chatroomId);
  const shared = automation.response.conversation === "shared" && room !== undefined
    ? ` Every response continues in the same ${CONVERSATION_NOUN[room.kind]}.`
    : "";
  return `${summary}, in ${chatroomName(automation.response.chatroomId)}.${posted}${shared}`;
});

// The setup steps, reopened: to connect the sender again, or to test it. A freshly minted secret
// opens them with the secret filled in, the one time it is known.
let setupOpen = $state(false);
let setupSecret = $state<string | null>(null);
let replaceOpen = $state(false);
let rotating = $state(false);
let deleteOpen = $state(false);
let newSecretOpen = $state(false);

function chatroomName(id: string): string {
  return data.chatrooms.find((room) => room.id === id)?.name ?? id;
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Couldn't copy. Select it and copy it yourself.");
  }
}

async function toggleEnabled() {
  try {
    if (automation.enabled) {
      await disableAutomation(fetch, automation.id);
      toast.success("Paused. Nothing new starts until you resume.");
    } else {
      await enableAutomation(fetch, automation.id);
      toast.success("Resumed");
    }
    await invalidate("app:automation");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to update automation");
  }
}

async function rotate() {
  newSecretOpen = false;
  rotating = true;
  try {
    setupSecret = await rotateAutomationSecret(fetch, automation.id);
    setupOpen = true;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to rotate the secret");
  } finally {
    rotating = false;
  }
}

async function handleDelete() {
  try {
    await deleteAutomation(fetch, automation.id);
    toast.success(`Deleted "${automation.name}"`);
    await goto("/triggers");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to delete automation");
  }
}
</script>

<svelte:head>
  <title>{automation.name} · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-10">
  <ObjectHeader title={automation.name}>
    {#snippet icon()}
      {#if automation.trigger.kind === "webhook"}
        <WebhookIcon />
      {:else}
        <ClockIcon />
      {/if}
    {/snippet}
    {#snippet badge()}
      {#if automation.enabled}
        <Badge variant="secondary">Enabled</Badge>
      {:else}
        <Badge variant="outline">Paused</Badge>
      {/if}
    {/snippet}
    {#snippet actions()}
        <Button variant="outline" onclick={toggleEnabled}>
          {#if automation.enabled}
            <PauseIcon data-icon="inline-start" />
            Pause
          {:else}
            <PlayIcon data-icon="inline-start" />
            Resume
          {/if}
        </Button>
        <Button href="/triggers/{automation.id}/edit">
          <PencilIcon data-icon="inline-start" />
          Edit
        </Button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="outline" size="icon" aria-label="More actions">
                <MoreHorizontalIcon />
              </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Group>
            <DropdownMenu.Item variant="destructive" onclick={() => (deleteOpen = true)}>
              <Trash2Icon />
              Delete
            </DropdownMenu.Item>
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
    <!-- What it does, in one sentence: the edit flow has the rest. -->
    <p class="text-muted-foreground text-sm">
      Runs <span class="text-foreground font-medium">{agentName}</span> on
      <span class="text-foreground font-medium">{targetLabel}</span>.
      {responseSentence}
    </p>
  </ObjectHeader>

  {#if currentAgent === undefined || currentAgent.archivedAt !== null}
    <Alert.Root variant="destructive">
      <TriangleAlertIcon />
      <Alert.Title>
        {currentAgent === undefined ? "Its agent no longer exists" : "Its agent is archived"}
      </Alert.Title>
      <Alert.Description>
        Nothing starts until you pick another agent.
        <a href="/triggers/{automation.id}/edit?step=agent" class="underline underline-offset-4">
          Choose an agent
        </a>
      </Alert.Description>
    </Alert.Root>
  {/if}

  <!-- The one piece of setup used from here rather than while editing: where to send, the steps
       that connect the sender, and a new secret when the old one leaks. -->
  {#if webhook !== null && sender !== null && ingestionUrl}
    {@const SenderIcon = PRESET_ICONS[sender.id]}
    <section class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <h2 class="text-base font-medium">Webhook</h2>
        <p class="text-muted-foreground flex items-center gap-1.5 text-sm">
          <SenderIcon class="size-4" />
          Sends from
          <span class="text-foreground font-medium">{formatLabel(webhook.format)}</span>
        </p>
      </div>
      {#if awaiting}
        <Alert.Root>
          <KeyRoundIcon />
          <Alert.Title>Paste the signing secret from {vendor}</Alert.Title>
          <Alert.Description>
            Until it's saved, requests from {vendor} are turned away.
            <button
              type="button"
              class="underline underline-offset-4"
              onclick={() => (replaceOpen = true)}
            >
              Paste it now
            </button>
          </Alert.Description>
        </Alert.Root>
      {/if}
      <div class="flex flex-wrap items-center gap-2">
        <div
          class="bg-muted/50 flex min-w-0 flex-1 items-center gap-2 rounded-lg border py-1 pr-1 pl-3"
        >
          <code class="min-w-0 flex-1 truncate font-mono text-sm" title={ingestionUrl}>
            {ingestionUrl}
          </code>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy the URL"
            onclick={() => copy(ingestionUrl, "URL")}
          >
            <CopyIcon />
          </Button>
        </div>
        <Button
          variant="outline"
          onclick={() => {
            setupSecret = null;
            setupOpen = true;
          }}
        >
          <PlugIcon data-icon="inline-start" />
          Setup steps
        </Button>
        {#if pasted}
          <Button variant="outline" onclick={() => (replaceOpen = true)}>
            <KeyRoundIcon data-icon="inline-start" />
            {awaiting ? "Paste secret" : "Replace secret"}
          </Button>
        {:else}
          <Button variant="outline" disabled={rotating} onclick={() => (newSecretOpen = true)}>
            {#if rotating}
              <Spinner data-icon="inline-start" />
            {:else}
              <RefreshCwIcon data-icon="inline-start" />
            {/if}
            New secret
          </Button>
        {/if}
      </div>
    </section>
  {:else if automation.trigger.kind === "schedule"}
    <section class="flex flex-col gap-3">
      <h2 class="text-base font-medium">Schedule</h2>
      <div class="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span>
          <code class="font-mono">{automation.trigger.cron}</code>
          <span class="text-muted-foreground">({automation.trigger.timezone})</span>
        </span>
        <span class="text-muted-foreground">
          Next run
          {#if automation.trigger.nextDueAt && automation.enabled}
            <span title={formatDateTime(automation.trigger.nextDueAt)}>
              {formatRelativeTime(automation.trigger.nextDueAt)}
            </span>
          {:else}
            paused
          {/if}
        </span>
      </div>
    </section>
  {/if}

  <section class="flex flex-col gap-3">
    <div class="flex flex-col gap-1">
      <h2 class="text-base font-medium">Activity</h2>
      <p class="text-muted-foreground text-sm">
        What this trigger has started, most recent first.
      </p>
    </div>
    {#if rows.length === 0}
      <Empty.Root class="border border-dashed">
        <Empty.Header>
          <Empty.Media variant="icon">
            <ZapIcon />
          </Empty.Media>
          <Empty.Title>Nothing yet</Empty.Title>
          <Empty.Description>
            {automation.trigger.kind === "webhook"
              ? "Runs appear here once a request arrives."
              : "Runs appear here once the schedule comes around."}
          </Empty.Description>
        </Empty.Header>
      </Empty.Root>
    {:else}
      <!-- Rows keep to one line and the list scrolls sideways when the panel is narrower than them,
           rather than every row folding into a tower of wrapped words. -->
      <div class="overflow-x-auto rounded-lg border">
        <ul class="min-w-fit divide-y">
          {#each rows.slice(0, shownRows) as row (row.key)}
            {@render activityRow(row)}
          {/each}
        </ul>
      </div>
      {#if rows.length > shownRows}
        <Button variant="outline" class="w-fit" onclick={() => (shownRows += PAGE)}>
          Show more
        </Button>
      {/if}
    {/if}
  </section>
</div>

{#snippet activityRow(row: ActivityRow)}
  <li
  class={[
      "relative flex items-center gap-4 px-4 py-3 text-sm whitespace-nowrap",
      row.kind !== "skipped" && "hover:bg-muted/40 transition-colors",
    ]}
>
    <span class="text-muted-foreground w-48 shrink-0 whitespace-nowrap tabular-nums" title={formatDateTime(row.at)}>
      {formatDateTime(row.at)}
    </span>
    {#if row.kind === "response"}
      {@const r = row.response}
      <a
        href="/tasks/{row.taskId}"
        class="flex min-w-0 flex-1 items-center gap-2 font-medium after:absolute after:inset-0 focus-visible:outline-none"
      >
        <MessagesSquareIcon class="text-muted-foreground size-4 shrink-0" />
        {#if r.title}
          <span class="max-w-96 truncate" title={r.title}>{r.title}</span>
        {:else}
          Response
        {/if}
        <span class="text-muted-foreground font-normal">
          {r.alerts}
          {r.alerts === 1 ? "fire" : "fires"}{#if r.closedAt}, {lasted(new Date(r.closedAt).getTime() - new Date(r.openedAt).getTime())}{/if}
        </span>
      </a>
      <span class="flex items-center gap-2">
        {#if r.agentName}<span class="text-muted-foreground">{r.agentName}</span>{/if}
        {#if r.state !== "closed"}
          <Badge variant="secondary">{r.state === "attended" ? "Open, attended" : "Open"}</Badge>
        {:else if r.runState}
          <RunStateBadge state={r.runState} />
        {/if}
      </span>
    {:else if row.kind === "run"}
      {@const task = taskStates.get(row.taskId)}
      <a
        href="/tasks/{row.taskId}"
        class="flex min-w-0 flex-1 items-center gap-2 font-medium after:absolute after:inset-0 focus-visible:outline-none"
      >
        <ListChecksIcon class="text-muted-foreground size-4 shrink-0" />
        Run
      </a>
      {#if task}
        <RunStateBadge state={task.state} phase={task.phase} />
      {/if}
    {:else}
      <span class="text-muted-foreground flex min-w-0 flex-1 items-center gap-2">
        <CircleSlashIcon class="size-4 shrink-0" />
        {row.label}
        {#if row.detail}
          <span class="max-w-80 truncate text-xs" title={row.detail}>{row.detail}</span>
        {/if}
      </span>
    {/if}
  </li>
{/snippet}

{#if webhook !== null && sender !== null && ingestionUrl}
  <Sheet.Root
  bind:open={setupOpen}
  onOpenChange={(open) => {
      // The secret is shown while the steps are open, and forgotten once they close.
      if (!open) setupSecret = null;
    }}
>
  <Sheet.Content side="right" class="w-full overflow-y-auto sm:max-w-xl">
    <Sheet.Header>
      <Sheet.Title>
          {sender.id === "other" ? "Connect the sender" : `Connect ${sender.name}`}
        </Sheet.Title>
      <Sheet.Description>
          Follow these steps in {sender.id === "other" ? "the sender" : sender.name}. The next
          request it sends shows up below.
        </Sheet.Description>
    </Sheet.Header>
    <div class="flex flex-col gap-6 px-4 pb-6">
        {#if setupSecret !== null}
          <Alert.Root>
            <TriangleAlertIcon />
            <Alert.Title>New secret made</Alert.Title>
            <Alert.Description>
              The old one stopped working. Copy this one into {vendor} now. It's shown only here.
            </Alert.Description>
          </Alert.Root>
        {/if}
        {#if setupOpen}
          <WebhookSetup
            automationId={automation.id}
            preset={sender.id}
            {pasted}
            {awaiting}
            onlyNew
            onsaved={() => void invalidate("app:automation")}
            context={{
              url: ingestionUrl,
              secret: setupSecret,
              verification: webhook.verification,
              name: automation.name,
            }}
          />
        {/if}
      </div>
  </Sheet.Content>
</Sheet.Root>

  <Dialog.Root bind:open={replaceOpen}>
  <Dialog.Content>
      <Dialog.Header>
        <Dialog.Title>{awaiting ? "Paste the secret" : "Replace the secret"}</Dialog.Title>
        <Dialog.Description>
          {awaiting
            ? `Copy the signing secret from ${vendor} and paste it here.`
            : `Make a new signing secret in ${vendor} and paste it here. Requests signed with the old one stop being accepted.`}
        </Dialog.Description>
      </Dialog.Header>
      {#if replaceOpen}
        <PasteSecret
          automationId={automation.id}
          {vendor}
          verification={webhook.verification}
          replacing={!awaiting}
          onsaved={() => void invalidate("app:automation")}
        />
      {/if}
      <Dialog.Footer>
        <Button variant="outline" onclick={() => (replaceOpen = false)}>Done</Button>
      </Dialog.Footer>
    </Dialog.Content>
</Dialog.Root>
{/if}

<AlertDialog.Root bind:open={newSecretOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Make a new secret?</AlertDialog.Title>
      <AlertDialog.Description>
        The current secret stops working right away, so requests from {vendor} are turned away
        until you paste the new one there.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={rotate}>Make a new secret</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={deleteOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete "{automation.name}"?</AlertDialog.Title>
      <AlertDialog.Description>
        {automation.trigger.kind === "webhook"
          ? "Requests to its webhook address will fail, and its history is deleted."
          : "It stops running on its schedule, and its history is deleted."}
        You can't undo this.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={handleDelete}>Delete</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
