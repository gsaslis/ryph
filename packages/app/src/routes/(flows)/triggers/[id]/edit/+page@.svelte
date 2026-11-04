<script lang="ts">
import { goto, pushState } from "$app/navigation";
import { page } from "$app/state";
import { updateAutomation } from "$lib/api/automations";
import SteppedFlow, { type FlowStepItem } from "$lib/components/stepped-flow/stepped-flow.svelte";
import { stepOf } from "$lib/components/stepped-flow/steps";
import UnsavedChangesGuard from "$lib/components/unsaved-changes-guard/unsaved-changes-guard.svelte";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
import CheckIcon from "@lucide/svelte/icons/check";
import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import AgentTargetFields from "../../shared/agent-target-fields.svelte";
import {
  AUTOMATION_STEPS,
  type AutomationStepId,
  composeResponse,
  composeTarget,
  instructionsProblem,
  responseProblem,
  responseToFields,
  targetProblem,
  targetToFields,
  triggerPatch,
  triggerProblem,
  triggerToFields,
} from "../../shared/automation-steps";
import InstructionsFields from "../../shared/instructions-fields.svelte";
import ResponseFields from "../../shared/response-fields.svelte";
import TriggerFields from "../../shared/trigger-fields.svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// The form seeds from the automation as loaded and diverges as the operator edits, so reading
// the loaded value once is what is wanted here.
// svelte-ignore state_referenced_locally
let name = $state(data.automation.name);
// svelte-ignore state_referenced_locally
let trigger = $state(triggerToFields(data.automation.trigger));
// svelte-ignore state_referenced_locally
let target = $state(targetToFields(data.automation));
// svelte-ignore state_referenced_locally
let instructions = $state(data.automation.instructions);
// svelte-ignore state_referenced_locally
let response = $state(responseToFields(data.automation.response));
let roomBlocked = $state(false);
let submitting = $state(false);

// Whether anything differs from the automation as loaded, for the guard against leaving by
// accident; a successful save sets `saved` so the move back goes through.
let saved = $state(false);
const snapshot = () => JSON.stringify({ name, trigger, target, instructions, response });
const pristine = untrack(snapshot);
const dirty = $derived(!saved && snapshot() !== pristine);

// The same steps the automation was made in, minus the review: an existing one has nothing to
// confirm, and Save is on every step. Every step counts as seen, so a problem shows at once. A
// link from the automation's page can open straight onto a step (`?step=`).
const STEPS = AUTOMATION_STEPS.filter((step) => step.id !== "review");
const current = $derived(stepOf(page.state, STEPS, page.url.searchParams.get("step")));
const index = $derived(STEPS.findIndex((step) => step.id === current));

const problems = $derived<Record<AutomationStepId, string | null>>({
  trigger: triggerProblem(name, trigger),
  agent: targetProblem(target, data.agents),
  instructions: instructionsProblem(instructions),
  response: responseProblem(response, trigger, data.chatrooms, roomBlocked),
  review: null,
});

const steps = $derived<FlowStepItem[]>(STEPS.map((step) => ({
  ...step,
  status: problems[step.id] === null ? "done" : "problem",
})));

const webhookUrl = $derived(
  data.automation.trigger.kind === "webhook"
    ? `${data.automationsOrigin}${data.automation.trigger.path}`
    : null,
);

// The step on screen lives in the history entry's state (shallow routing), so the browser's
// back and forward buttons walk the steps without a navigation.
function go(id: AutomationStepId) {
  if (id !== current) pushState("", { step: id });
}

async function submit(event: SubmitEvent) {
  event.preventDefault();
  const problem = STEPS.find((step) => problems[step.id] !== null);
  if (problem) {
    toast.error(problems[problem.id] ?? "Something on this step needs fixing.");
    go(problem.id);
    return;
  }
  submitting = true;
  try {
    const automation = await updateAutomation(fetch, data.automation.id, {
      name: name.trim(),
      agentId: target.agentId,
      target: composeTarget(target),
      instructions,
      // null clears the policy back to a plain run each time.
      response: composeResponse(response, trigger, data.chatrooms),
      // The trigger's revisable half only: a webhook's format and rate limit, a schedule's cron
      // and zone.
      ...triggerPatch(trigger),
    });
    toast.success(`Saved "${automation.name}"`);
    saved = true;
    await goto(`/triggers/${automation.id}`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to save automation");
  } finally {
    submitting = false;
  }
}
</script>

<svelte:head>
  <title>Edit {data.automation.name} · Ryph</title>
</svelte:head>

<UnsavedChangesGuard {dirty} />

<form onsubmit={submit} novalidate class="contents">
  <SteppedFlow
    cancelHref="/triggers/{data.automation.id}"
    title="Edit automation"
    {steps}
    {current}
    select={(id) => go(id as AutomationStepId)}
  >
    {#snippet children(shown: string)}
      <div hidden={shown !== "trigger"} class="max-w-2xl">
        <TriggerFields bind:name bind:fields={trigger} fixed url={webhookUrl} />
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
    {/snippet}

    {#snippet footer()}
      <Button variant="ghost" href="/triggers/{data.automation.id}">Cancel</Button>
      <div class="flex items-center gap-2">
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
        <Button type="submit" disabled={submitting}>
          {#if submitting}
            <Spinner data-icon="inline-start" />
          {:else}
            <CheckIcon data-icon="inline-start" />
          {/if}
          Save changes
        </Button>
      </div>
    {/snippet}
  </SteppedFlow>
</form>
