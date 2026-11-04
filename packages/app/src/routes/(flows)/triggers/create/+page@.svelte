<script lang="ts">
import { goto, pushState } from "$app/navigation";
import { page } from "$app/state";
import { createAutomation } from "$lib/api/automations";
import type { Automation } from "$lib/api/types";
import {
  formatLabel,
  isPresetVerification,
  presetById,
  type PresetId,
  type PresetVerification,
  responseSummary,
} from "$lib/automations/presets";
import ReviewFact from "$lib/components/stepped-flow/review-fact.svelte";
import ReviewSection from "$lib/components/stepped-flow/review-section.svelte";
import SteppedFlow, { type FlowStepItem } from "$lib/components/stepped-flow/stepped-flow.svelte";
import { stepOf } from "$lib/components/stepped-flow/steps";
import UnsavedChangesGuard from "$lib/components/unsaved-changes-guard/unsaved-changes-guard.svelte";
import * as Alert from "$lib/components/ui/alert";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import WebhookSetup from "$lib/components/webhook-setup/webhook-setup.svelte";
import { forgeRepoLabel } from "$lib/utils/forge";
import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
import PlusIcon from "@lucide/svelte/icons/plus";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import { untrack } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { toast } from "svelte-sonner";
import AgentTargetFields from "../shared/agent-target-fields.svelte";
import {
  AUTOMATION_STEPS,
  type AutomationStepId,
  blankResponse,
  blankTarget,
  blankTrigger,
  composeFormat,
  composeResponse,
  composeTarget,
  composeTrigger,
  DEFAULT_HEADER,
  instructionsProblem,
  presetOf,
  responseChoiceOf,
  responseConflict,
  responseProblem,
  secretToPaste,
  settleResponseChoice,
  sharedConversationNoun,
  targetProblem,
  triggerProblem,
} from "../shared/automation-steps";
import InstructionsFields from "../shared/instructions-fields.svelte";
import ResponseFields from "../shared/response-fields.svelte";
import TriggerFields from "../shared/trigger-fields.svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

let name = $state("");
let trigger = $state(blankTrigger());
let target = $state(blankTarget());
let instructions = $state("");
let response = $state(blankResponse());
// The room fields' verdict on the picked room: archived, or one with channels and no private
// channel to open a response in.
let roomBlocked = $state(false);
let submitting = $state(false);

// Whether anything differs from a blank form, for the guard against leaving by accident. One
// string of every field against the same string taken at the start; a successful create sets
// `saved` so the move on goes through.
let saved = $state(false);
const snapshot = () => JSON.stringify({ name, trigger, target, instructions, response });
const pristine = untrack(snapshot);
const dirty = $derived(!saved && snapshot() !== pristine);

const preset = $derived(trigger.preset === null ? null : presetById(trigger.preset));

/** Set after a webhook is created: how to connect its sender, with the minted secret shown this
 * one time, so it gets a step of its own rather than a dialog a stray click could close. */
let created = $state<
  {
    id: string;
    name: string;
    url: string;
    /** The minted secret; null when the sender's own is pasted instead. */
    secret: string | null;
    pasted: boolean;
    preset: PresetId;
    verification: Extract<Automation["trigger"], { kind: "webhook" }>["verification"];
  } | null
>(null);
const connectStep = $derived.by(() => {
  const vendor = created === null || created.preset === "other"
    ? null
    : presetById(created.preset).name;
  return {
    id: "connect",
    label: vendor === null ? "Connect the sender" : `Connect ${vendor}`,
    heading: vendor === null ? "Connect the sender" : `Connect ${vendor}`,
    description: created?.pasted
      ? `Follow these steps${
        vendor === null ? "" : ` in ${vendor}`
      }, then paste its signing secret here.`
      : `Follow these steps${vendor === null ? "" : ` in ${vendor}`}.`,
  };
});

// The step on screen, and the ones that have been left at least once — a step is marked as done
// or as a problem only once it has been seen. Every step stays rendered and the others hidden, so
// a step's own state (a room's channel list) survives leaving and coming back.
const current = $derived<AutomationStepId | "connect">(
  created !== null ? "connect" : stepOf(page.state, AUTOMATION_STEPS),
);
// Recorded on arrival, not on departure, so a step never flickers to "todo" on the way out.
const visited = new SvelteSet<string>();
$effect(() => {
  const here = current;
  untrack(() => visited.add(here));
});
// Once a create was attempted every problem shows, seen or not.
let attempted = $state(false);

// Every step's reason it cannot be saved as it stands — in the operator's words — or null.
const problems = $derived<Record<AutomationStepId, string | null>>({
  trigger: triggerProblem(name, trigger),
  agent: targetProblem(target, data.agents),
  instructions: instructionsProblem(instructions),
  response: responseProblem(response, trigger, data.chatrooms, roomBlocked),
  review: null,
});
// A response choice another step's change no longer fits: marked at once, wherever the person is.
const responseConflicted = $derived(responseConflict(response, trigger, data.chatrooms) !== null);
const broken = $derived(AUTOMATION_STEPS.filter((step) => problems[step.id] !== null));

const steps = $derived<FlowStepItem[]>([
  ...AUTOMATION_STEPS.map((step) => ({ ...step, status: statusOf(step.id) })),
  ...(created !== null ? [{ ...connectStep, status: "todo" as const }] : []),
]);

function statusOf(id: AutomationStepId): FlowStepItem["status"] {
  if (created !== null) return "done";
  if (id === "review") return "todo";
  if (id === "response" && responseConflicted) return "problem";
  const problem = problems[id] !== null;
  if (problem) return attempted || (visited.has(id) && id !== current) ? "problem" : "todo";
  return visited.has(id) || id === current ? "done" : "todo";
}

const index = $derived(AUTOMATION_STEPS.findIndex((step) => step.id === current));

// The step on screen lives in the history entry's state (shallow routing), so the browser's
// back and forward buttons walk the steps. Once the automation exists there is nothing to go
// back to: the form is done, and the secret's step is the only one left.
function go(id: AutomationStepId) {
  if (created !== null || id === current) return;
  // Until the response step is seen its choice follows the trigger's default. Once seen, what was
  // on screen is the person's, and a later trigger change that no longer fits it is reported on
  // the step, never quietly swapped. Every way onto a step the first time passes through here; the
  // browser's history only revisits steps already seen.
  if (id === "response") response = settleResponseChoice(response, trigger);
  pushState("", { step: id });
}

function next() {
  const step = AUTOMATION_STEPS[index + 1];
  if (step) go(step.id);
}

function back() {
  const step = AUTOMATION_STEPS[index - 1];
  if (step) go(step.id);
}

// Enter in a field moves on; only the review's button creates.
function submit(event: SubmitEvent) {
  event.preventDefault();
  if (created !== null) return;
  if (current === "review") void create();
  else next();
}

async function create() {
  attempted = true;
  const problem = AUTOMATION_STEPS.find((step) => problems[step.id] !== null);
  if (problem) {
    toast.error(problems[problem.id] ?? "Something on this step needs fixing.");
    go(problem.id);
    return;
  }
  submitting = true;
  // A sender that makes its own secret is created without one; its secret is pasted after, and
  // the placeholder the service holds until then is never shown.
  const pasted = secretToPaste(trigger);
  try {
    const result = await createAutomation(fetch, {
      name: name.trim(),
      trigger: composeTrigger(trigger),
      agentId: target.agentId,
      target: composeTarget(target),
      instructions,
      response: composeResponse(response, trigger, data.chatrooms),
    });
    saved = true;
    if (result.automation.trigger.kind === "webhook") {
      created = {
        id: result.automation.id,
        name: result.automation.name,
        url: `${data.automationsOrigin}${result.automation.trigger.path}`,
        secret: pasted ? null : result.secret,
        pasted,
        preset: trigger.preset ?? "other",
        verification: result.automation.trigger.verification,
      };
    } else {
      toast.success(`Created "${result.automation.name}"`);
      await goto(`/triggers/${result.automation.id}`);
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to create automation");
  } finally {
    submitting = false;
  }
}

// The review's lines, each the step's fields said in a few words.
const agentName = $derived(data.agents.find((a) => a.id === target.agentId)?.name ?? "—");
const targetSummary = $derived.by(() => {
  if (target.kind === "workspace") {
    const name = data.workspaces.find((w) => w.workspace.id === target.workspaceId)?.workspace
      .name;
    return name === undefined ? "—" : `Workspace ${name}`;
  }
  const repo = data.repos.find((r) => r.id === target.connectedRepoId);
  if (repo === undefined) return "—";
  const ref = target.ref.trim();
  return ref === "" ? forgeRepoLabel(repo) : `${forgeRepoLabel(repo)} at ${ref}`;
});
const triggerSummary = $derived(
  trigger.kind === "webhook"
    ? "A request from another service"
    : `A schedule: ${presetOf(trigger.cron)?.toLowerCase() ?? trigger.cron}, ${trigger.timezone}`,
);
const senderSummary = $derived(
  preset === null ? "—" : preset.id === "other" ? formatLabel(composeFormat(trigger)) : preset.name,
);
const checkSummary = $derived.by(() => {
  // A known sender left at its own settings is said in its terms; the header only matters once
  // Advanced changed it, or for a sender of the person's own.
  if (preset !== null && preset.id !== "other") {
    const v = trigger.verification === "standard-webhooks"
      ? { kind: trigger.verification }
      : { kind: trigger.verification, header: trigger.header, prefix: trigger.prefix };
    if (isPresetVerification(preset, v as PresetVerification)) {
      return preset.secretSource === "pasted"
        ? `${preset.name}'s signing secret, pasted in after creating`
        : "A secret made here, shown after creating";
    }
  }
  const header = trigger.header.trim() || DEFAULT_HEADER[trigger.verification];
  const how = trigger.verification === "standard-webhooks"
    ? "A Standard Webhooks signature"
    : trigger.verification === "hmac-sha256"
    ? `A signature in ${header}`
    : `The secret in ${header}`;
  return secretToPaste(trigger) ? `${how}, with ${preset?.name ?? "the sender"}'s secret` : how;
});
const responseLine = $derived(
  responseSummary(
    responseChoiceOf(response, trigger),
    trigger.kind === "schedule" ? null : (preset ?? presetById("other")),
  ),
);
const roomName = $derived.by(() => {
  if (response.chatroomId === "") return "Run page only";
  const name = data.chatrooms.find((r) => r.id === response.chatroomId)?.name ??
    response.chatroomId;
  const noun = sharedConversationNoun(response, data.chatrooms);
  return noun === null ? name : `${name}, all in one ${noun}`;
});
</script>

<svelte:head>
  <title>New automation · Ryph</title>
</svelte:head>

<UnsavedChangesGuard {dirty} />

<form onsubmit={submit} novalidate class="contents">
  <SteppedFlow
    cancelHref="/triggers"
    title="New automation"
    {steps}
    {current}
    select={(id) => go(id as AutomationStepId)}
  >
    {#snippet children(shown: string)}
      <div hidden={shown !== "trigger"} class="max-w-2xl">
        <TriggerFields bind:name bind:fields={trigger} />
      </div>
      <div hidden={shown !== "agent"} class="max-w-2xl">
        <AgentTargetFields
          bind:fields={target}
          agents={data.agents}
          repos={data.repos}
          workspaces={data.workspaces}
        />
      </div>
      <div hidden={shown !== "instructions"} class="max-w-2xl">
        <InstructionsFields bind:instructions />
      </div>
      <div hidden={shown !== "response"} class="max-w-2xl">
        <ResponseFields
          bind:fields={response}
          bind:blocked={roomBlocked}
          rooms={data.chatrooms}
          {trigger}
        />
      </div>
      <div hidden={shown !== "review"} class="flex max-w-2xl flex-col gap-8">
        {#if broken.length > 0}
          <Alert.Root variant="destructive">
            <TriangleAlertIcon />
            <Alert.Title>Fix {broken.length === 1 ? "this step" : "these steps"} to create</Alert.Title>
            <Alert.Description>
              <ul class="flex flex-col gap-1">
                {#each broken as step (step.id)}
                  <li>
                    <button
                      type="button"
                      class="font-medium underline underline-offset-3"
                      onclick={() => go(step.id)}
                    >
                      {step.label}
                    </button>: {problems[step.id]}
                  </li>
                {/each}
              </ul>
            </Alert.Description>
          </Alert.Root>
        {/if}
        <ReviewSection label="Trigger" problem={problems.trigger} onchange={() => go("trigger")}>
          <dl class="divide-y">
            <ReviewFact term="Name" value={name.trim() || "—"} />
            <ReviewFact term="Starts when" value={triggerSummary} />
            {#if trigger.kind === "webhook"}
              <ReviewFact term="Sends from" value={senderSummary} />
              <ReviewFact term="Checked with" value={checkSummary} />
              <ReviewFact term="Rate limit" value="{trigger.firesPerMinute} a minute" />
            {:else}
              <ReviewFact term="Cron expression" value={trigger.cron.trim()} mono />
              <ReviewFact term="Timezone" value={trigger.timezone.trim()} />
            {/if}
          </dl>
        </ReviewSection>
        <ReviewSection label="Response" problem={problems.response} onchange={() => go("response")}>
          <dl class="divide-y">
            <ReviewFact term="Each time" value={responseLine} />
            {#if responseChoiceOf(response, trigger) !== "run"}
              <ReviewFact term="Talks in" value={roomName} />
              <ReviewFact
                term="If nobody has replied"
                value="Ends after {response.idleMinutes} minutes of quiet"
              />
              <ReviewFact
                term="After someone replies"
                value="Ends after {response.attendedIdleMinutes} minutes of quiet"
              />
            {/if}
          </dl>
        </ReviewSection>
        <ReviewSection label="Agent and code" problem={problems.agent} onchange={() => go("agent")}>
          <dl class="divide-y">
            <ReviewFact term="Agent" value={agentName} />
            <ReviewFact term="Checks out" value={targetSummary} />
          </dl>
        </ReviewSection>
        <ReviewSection
          label="Instructions"
          problem={problems.instructions}
          onchange={() => go("instructions")}
        >
          {#if instructions.trim()}
            <p class="text-muted-foreground line-clamp-4 text-sm whitespace-pre-line">
              {instructions.trim()}
            </p>
          {:else}
            <p class="text-muted-foreground text-sm">None yet.</p>
          {/if}
        </ReviewSection>
      </div>
      {#if created !== null}
        <div hidden={shown !== "connect"} class="flex max-w-2xl flex-col gap-6">
          {#if created.secret !== null}
            <Alert.Root>
              <TriangleAlertIcon />
              <Alert.Title>Copy the secret before leaving</Alert.Title>
              <Alert.Description>
                It's never shown again. If it's lost, make a new one from the automation's page.
              </Alert.Description>
            </Alert.Root>
          {/if}
          <WebhookSetup
            automationId={created.id}
            preset={created.preset}
            pasted={created.pasted}
            context={{
              url: created.url,
              secret: created.secret,
              verification: created.verification,
              name: created.name,
            }}
          />
        </div>
      {/if}
    {/snippet}

    {#snippet footer()}
      {#if created !== null}
        <span></span>
        <Button href="/triggers/{created.id}">
          Open the automation
          <ArrowRightIcon data-icon="inline-end" />
        </Button>
      {:else}
        <Button variant="ghost" href="/triggers">Cancel</Button>
        <div class="flex items-center gap-2">
          <Button variant="outline" type="button" disabled={index === 0} onclick={back}>
            <ArrowLeftIcon data-icon="inline-start" />
            Back
          </Button>
          {#if current === "review"}
            <Button type="submit" disabled={submitting || broken.length > 0}>
              {#if submitting}
                <Spinner data-icon="inline-start" />
              {:else}
                <PlusIcon data-icon="inline-start" />
              {/if}
              Create automation
            </Button>
          {:else}
            <Button type="submit">
              Next
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          {/if}
        </div>
      {/if}
    {/snippet}
  </SteppedFlow>
</form>
