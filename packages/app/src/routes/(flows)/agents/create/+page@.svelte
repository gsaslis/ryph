<script lang="ts">
import { can } from "$lib/utils/auth/capabilities";
import { goto, pushState } from "$app/navigation";
import { page } from "$app/state";
import { createAgent } from "$lib/api/agents";
import SteppedFlow, { type FlowStepItem } from "$lib/components/stepped-flow/stepped-flow.svelte";
import ReviewFact from "$lib/components/stepped-flow/review-fact.svelte";
import ReviewSection from "$lib/components/stepped-flow/review-section.svelte";
import { stepOf } from "$lib/components/stepped-flow/steps";
import UnsavedChangesGuard from "$lib/components/unsaved-changes-guard/unsaved-changes-guard.svelte";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
import PlusIcon from "@lucide/svelte/icons/plus";
import { untrack } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { toast } from "svelte-sonner";
import {
  AGENT_STEPS,
  type AgentStepId,
  effectiveEmail,
  identityProblem,
} from "../shared/agent-steps";
import ForgePolicyFields from "../shared/forge-policy-fields.svelte";
import {
  composeForgePolicy,
  forgePolicyProblem,
  forgePolicyToFields,
  forgeToolsOffered,
  forgeToolsState,
} from "../shared/forge-policy";
import ModelFields from "../shared/model-fields.svelte";
import IdentityFields from "../shared/identity-fields.svelte";
import InstructionsFields from "../shared/instructions-fields.svelte";
import MemoryFields from "../shared/memory-fields.svelte";
import { composeMemoryPolicy } from "../shared/memory-policy";
import type { ModelPolicy } from "$lib/api/types";
import {
  composeModelPolicy,
  defaultModelThinkingLevels,
  modelPolicyProblem,
} from "../shared/model-policy";
import {
  offersThinking,
  THINKING_LABELS,
  thinkingToSend,
} from "$lib/components/model-picker/thinking";
import { formatElapsed } from "$lib/utils/format";
import LimitPolicyFields from "../shared/limit-policy-fields.svelte";
import {
  composeLimitPolicy,
  limitPolicyProblem,
  limitPolicyToFields,
} from "../shared/limit-policy";
import NetworkPolicyFields from "../shared/network-policy-fields.svelte";
import PatchesFields from "../shared/patches-fields.svelte";
import ArtifactsFields from "../shared/artifacts-fields.svelte";
import BrowserFields from "../shared/browser-fields.svelte";
import {
  browserLocked,
  browserUnavailableNote,
  createBrowserEnabled,
} from "../shared/browser-policy";
import {
  composeNetworkPolicy,
  grantedHosts,
  networkPolicyProblem,
  networkPolicyToFields,
} from "../shared/network-policy";
import SkillPolicyFields from "../shared/skill-policy-fields.svelte";
import { composeSkillPolicy, skillPolicyToFields, skillsSummary } from "../shared/skill-policy";
import ToolPolicyFields from "../shared/tool-policy-fields.svelte";
import { composeToolPolicy, type ToolGrant, toolPolicyProblem } from "../shared/tool-policy";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

let name = $state("");
let handle = $state("");
let email = $state("");
// Every agent runs on pi for now; the server still takes the kind, so it is sent as one.
const harnessKind = "pi";
let systemPrompt = $state("");
let providerKeyId = $state("");
let allowedModels = $state<ModelPolicy["allowedModels"]>("*");
let defaultModel = $state("");
let defaultThinking = $state<ModelPolicy["defaultThinking"]>(null);
let toolGrants = $state<ToolGrant[]>([]);
// A new agent remembers unless told not to — the orchestrator's default, mirrored here so the
// form shows what will be saved.
let remembers = $state(true);
let memoryBudget = $state("2000");
let memoryAgentOnly = $state(false);
let forgeFields = $state(forgePolicyToFields(null));
const forgeState = $derived(forgeToolsState(data.toolAccessState, data.mcpServers));
const canGrantForge = $derived(can(data.user, "agents:policy"));
// A new agent gets the deployment's allowlist — the null policy, and the permissive default of
// the four, because an agent that cannot reach a package manager cannot run most repos' setup.
let networkFields = $state(networkPolicyToFields(null));
const canGrantNetwork = $derived(can(data.user, "agents:policy"));
// A new agent runs under the deployment's ceiling — the null policy.
let limitFields = $state(limitPolicyToFields(null));
const canGrantLimits = $derived(can(data.user, "agents:policy"));
// A new agent may read every skill the deployment offers: the null policy.
let skillFields = $state(skillPolicyToFields(null));
let canOpenPatches = $state(true);
// Both are on by default, where the creator may grant them; anyone else's form holds them off.
// svelte-ignore state_referenced_locally
let canPublishArtifacts = $state(can(data.user, "agents:policy"));
// svelte-ignore state_referenced_locally
let browserEnabled = $state(can(data.user, "agents:policy"));
const canGrantBrowser = $derived(can(data.user, "agents:policy"));
const browserHeld = $derived(browserLocked(false, canGrantBrowser));
// Letting an agent publish artifacts is an administrator's call too.
const artifactsHeld = $derived(!can(data.user, "agents:policy"));
let submitting = $state(false);

// Whether anything differs from a blank form, for the guard against leaving by accident. One
// string of every field against the same string taken at the start; a successful create sets
// `saved` so the move to the list goes through.
let saved = $state(false);
const snapshot = () =>
  JSON.stringify({
    name,
    handle,
    email,
    harnessKind,
    systemPrompt,
    providerKeyId,
    allowedModels,
    defaultModel,
    defaultThinking,
    toolGrants,
    remembers,
    memoryBudget,
    memoryAgentOnly,
    forgeFields,
    networkFields,
    limitFields,
    skillFields,
    canOpenPatches,
    canPublishArtifacts,
    browserEnabled,
  });
const pristine = untrack(snapshot);
const dirty = $derived(!saved && snapshot() !== pristine);

// The step on screen, and the ones that have been left at least once. A step is marked as done
// or as a problem only once it has been seen: a list of five red marks before a single field
// was typed into would be a scolding, not a guide. Every step stays rendered and the others are
// hidden, so a step's own state — a probe's answer — survives leaving and coming back, and the
// effects that keep the steps consistent (a key archived elsewhere dropping out of the picker) run
// whichever step is on screen.
// The Skills step only for a harness that reads skills: every switch on it would be ignored
// otherwise. With no harness list (manual dev), it is shown, as the Tools step is.
const selectedHarness = $derived(data.harnesses.find((h) => h.kind === harnessKind));
const skillsShown = $derived(selectedHarness === undefined || selectedHarness.skills);
// The Browser switch is held off, with the reason under it, where the harness gets no browser on
// this deployment: a switch that can never take effect would read as a broken browser in every
// run, and one that is missing says nothing about why. With no harness list, it is not shown.
const browserOffered = $derived(selectedHarness?.browser === true);
const browserNote = $derived(selectedHarness ? browserUnavailableNote(selectedHarness) : null);
const STEPS = $derived(AGENT_STEPS.filter((step) => step.id !== "skills" || skillsShown));
const current = $derived(stepOf(page.state, STEPS));
// Recorded on arrival, not on departure: a step is "done" while it is on screen anyway, and
// marking it on the way out would leave one render in which it is neither current nor visited —
// a flicker to "todo" and back that remounts its mark.
const visited = new SvelteSet<AgentStepId>();
$effect(() => {
  const here = current;
  untrack(() => visited.add(here));
});
// Once a create was attempted every problem shows, seen or not.
let attempted = $state(false);

// Every step's reason it cannot be saved as it stands — in the operator's words — or null. The
// policy checks are the ones the submit ran before; here they also drive the marks in the list.
const problems = $derived<Record<AgentStepId, string | null>>({
  identity: identityProblem(name, handle, email, page.url.hostname),
  model: modelPolicyProblem(providerKeyId, allowedModels, defaultModel),
  instructions: null,
  tools: toolPolicyProblem(toolGrants, data.mcpServers),
  skills: null,
  permissions: (forgeState === "on" && canGrantForge
    ? forgePolicyProblem(forgeFields, data.connectedRepos)
    : null) ??
    (canGrantNetwork ? networkPolicyProblem(networkFields, data.egressCeiling) : null),
  limits: canGrantLimits ? limitPolicyProblem(limitFields, data.limits) : null,
  review: null,
});

const steps = $derived<FlowStepItem[]>(STEPS.map((step) => ({
  ...step,
  status: statusOf(step.id),
})));

function statusOf(id: AgentStepId): FlowStepItem["status"] {
  if (id === "review") return "todo";
  const problem = problems[id] !== null;
  if (problem) return attempted || (visited.has(id) && id !== current) ? "problem" : "todo";
  return visited.has(id) || id === current ? "done" : "todo";
}

const index = $derived(STEPS.findIndex((step) => step.id === current));

// The step on screen lives in the history entry's state (shallow routing), so the browser's
// back and forward buttons walk the steps: `pushState` adds an entry without a navigation —
// no load runs, the leave guard is not asked — and a popstate to one of these entries only
// hands the state back.
function go(id: AgentStepId) {
  if (id !== current) pushState("", { step: id });
}

function next() {
  const step = STEPS[index + 1];
  if (step) go(step.id);
}

function back() {
  const step = STEPS[index - 1];
  if (step) go(step.id);
}

// Enter in a field moves on; only the review's button creates.
function submit(event: SubmitEvent) {
  event.preventDefault();
  if (current === "review") void create();
  else next();
}

async function create() {
  attempted = true;
  const problem = STEPS.find((step) => problems[step.id] !== null);
  if (problem) {
    toast.error(problems[problem.id] ?? "Something on this step needs fixing.");
    go(problem.id);
    return;
  }
  submitting = true;

  try {
    const modelPolicy = composeModelPolicy(
      providerKeyId,
      allowedModels,
      defaultModel,
      data.providerKeys,
      sentThinking,
    );
    const toolPolicy = composeToolPolicy(toolGrants);
    // Only a form that could show the section can have ticked anything in it.
    const forgePolicy = forgeState === "on" && canGrantForge
      ? composeForgePolicy(forgeFields)
      : null;
    // Only a form that could show the section can have narrowed anything in it; otherwise the
    // field is left out entirely, which the orchestrator reads as the deployment's ceiling.
    const networkPolicy = data.egressState === "on" && canGrantNetwork
      ? composeNetworkPolicy(networkFields)
      : null;
    // Only a form that could read the ceiling can have capped anything under it.
    const limitPolicy = data.limits !== null && canGrantLimits
      ? composeLimitPolicy(limitFields)
      : null;
    // Only a form that showed the step can have turned anything off in it.
    const skillPolicy = skillsShown && data.skills !== null
      ? composeSkillPolicy(skillFields)
      : null;
    const agent = await createAgent(fetch, {
      name,
      ...(handle.trim() ? { handle: handle.trim() } : {}),
      email: effectiveEmail(name, handle, email, page.url.hostname),
      harnessKind,
      ...(systemPrompt.trim() ? { systemPrompt } : {}),
      ...(modelPolicy ? { modelPolicy } : {}),
      ...(toolPolicy ? { toolPolicy } : {}),
      ...(forgePolicy ? { forgePolicy } : {}),
      ...(networkPolicy ? { networkPolicy } : {}),
      ...(limitPolicy ? { limitPolicy } : {}),
      ...(skillPolicy ? { skillPolicy } : {}),
      memoryPolicy: composeMemoryPolicy(remembers, memoryBudget, memoryAgentOnly),
      canOpenPatches,
      canPublishArtifacts: canPublishArtifacts && !artifactsHeld,
      browserEnabled: createBrowserEnabled(browserEnabled, {
        offered: browserOffered,
        canGrant: canGrantBrowser,
      }),
    });
    toast.success(`Created agent "${agent.name}"`);
    saved = true;
    await goto(data.backTo ?? "/agents");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to create agent");
  } finally {
    submitting = false;
  }
}

// The review's lines, each the step's fields said in a few words.
const selectedKey = $derived(data.providerKeys.find((key) => key.id === providerKeyId));
const thinkingLevels = $derived(
  defaultModelThinkingLevels(data.providers, data.providerKeys, providerKeyId, defaultModel),
);
// A model that takes no level hides the pick, and nothing is sent for it.
const sentThinking = $derived(thinkingToSend(defaultThinking, thinkingLevels));
const grantedServers = $derived(
  toolGrants.map((g) => data.mcpServers.find((s) => s.id === g.serverId)?.name ?? g.serverId),
);
const forgeSummary = $derived.by(() => {
  if (composeForgePolicy(forgeFields) === null) return "Not granted";
  const writes = [
    forgeFields.read && "read",
    forgeFields.createIssues && "create issues",
    forgeFields.comment && "comment",
    forgeFields.review && "review",
    forgeFields.closeIssues && "close issues",
  ].filter((w) => w !== false);
  return writes.join(", ");
});
const networkSummary = $derived(
  networkFields.mode === "deployment"
    ? "Whatever this deployment allows"
    : `Narrowed to ${grantedHosts(networkFields, data.egressCeiling).length} hosts`,
);
const skillSummary = $derived(
  data.skills === null ? null : skillsSummary(skillFields, data.skills),
);
const limitSummary = $derived.by(() => {
  const policy = composeLimitPolicy(limitFields);
  if (policy === null) return "The deployment's ceiling";
  const parts = [
    policy.wallClockMs !== null && `${formatElapsed(policy.wallClockMs)} wall clock`,
    policy.spendUsd !== null && `$${policy.spendUsd} spend`,
    policy.callsInFlight !== null && `${policy.callsInFlight} calls in flight`,
  ].filter((p) => p !== false);
  return parts.length > 0 ? parts.join(", ") : "The deployment's ceiling";
});
</script>

<svelte:head>
  <title>New agent · Ryph</title>
</svelte:head>

<UnsavedChangesGuard {dirty} />

<form onsubmit={submit} novalidate class="contents">
  <SteppedFlow
    title="New agent"
    cancelHref={data.backTo ?? "/agents"}
    {steps}
    {current}
    select={(id) => go(id as AgentStepId)}
  >
    {#snippet children(shown: string)}
      <div hidden={shown !== "identity"} class="max-w-2xl">
        <IdentityFields bind:name bind:handle bind:email />
      </div>
      <div hidden={shown !== "model"} class="max-w-2xl">
        <ModelFields
          bind:providerKeyId
          bind:allowedModels
          bind:defaultModel
          bind:defaultThinking
          harness={selectedHarness}
          providerKeys={data.providerKeys}
          providers={data.providers}
          modelAccessEnabled={data.modelAccessEnabled}
          storedPolicy={null}
        />
      </div>
      <div hidden={shown !== "instructions"} class="max-w-2xl">
        <InstructionsFields bind:systemPrompt />
      </div>
      <div hidden={shown !== "tools"} class="flex flex-col gap-10">
        <ToolPolicyFields
          bind:grants={toolGrants}
          mcpServers={data.mcpServers}
          toolAccessState={data.toolAccessState}
          harness={selectedHarness}
          catalogue={data.catalogueEntries}
        />
        <div class="flex max-w-2xl flex-col gap-10">
          <MemoryFields bind:remembers bind:memoryBudget bind:memoryAgentOnly />
          {#if selectedHarness}
            <BrowserFields bind:browserEnabled unavailable={browserNote} locked={browserHeld} />
          {/if}
        </div>
      </div>
      <div hidden={shown !== "skills"} class="max-w-2xl">
        <SkillPolicyFields bind:fields={skillFields} overview={data.skills} />
      </div>
      <div hidden={shown !== "permissions"} class="flex max-w-2xl flex-col gap-10">
        <ForgePolicyFields
          bind:fields={forgeFields}
          connectedRepos={data.connectedRepos}
          {forgeState}
          offered={forgeToolsOffered(data.forgeProviders)}
          harness={selectedHarness}
          canGrant={canGrantForge}
        />
        <NetworkPolicyFields
          bind:fields={networkFields}
          ceiling={data.egressCeiling}
          egressState={data.egressState}
          canGrant={canGrantNetwork}
        />
        <PatchesFields bind:canOpenPatches />
        <ArtifactsFields bind:canPublishArtifacts locked={artifactsHeld} />
      </div>
      <div hidden={shown !== "limits"} class="max-w-2xl">
        <LimitPolicyFields bind:fields={limitFields} limits={data.limits} canGrant={canGrantLimits} />
      </div>
      <div hidden={shown !== "review"} class="max-w-2xl flex flex-col gap-8">
        <ReviewSection label="Identity" problem={problems.identity} onchange={() => go("identity")}>
          <dl class="divide-y">
            <ReviewFact term="Name" value={name || "—"} />
            <ReviewFact term="Handle" value={handle.trim() || "Derived from the name"} />
            <ReviewFact term="Email" value={effectiveEmail(name, handle, email, page.url.hostname) || "—"} />
          </dl>
        </ReviewSection>
        <ReviewSection label="Model" problem={problems.model} onchange={() => go("model")}>
          <dl class="divide-y">
            <ReviewFact
              term="Provider key"
              value={selectedKey ? `${selectedKey.label} (${selectedKey.provider})` : "No model access"}
            />
            {#if selectedKey}
              <ReviewFact term="Allowed models" value={allowedModels === "*" ? "Any" : allowedModels.join(", ")} mono />
              <ReviewFact term="Default model" value={defaultModel.trim() || "Harness default"} mono />
              {#if offersThinking(thinkingLevels)}
                <ReviewFact
                  term="Thinking level"
                  value={defaultThinking === null ? "Harness default" : THINKING_LABELS[defaultThinking]}
                />
              {/if}
            {/if}
          </dl>
        </ReviewSection>
        <ReviewSection label="Instructions" problem={problems.instructions} onchange={() => go("instructions")}>
          {#if systemPrompt.trim()}
            <p class="text-muted-foreground line-clamp-4 text-sm whitespace-pre-line">
              {systemPrompt.trim()}
            </p>
          {:else}
            <p class="text-muted-foreground text-sm">None.</p>
          {/if}
        </ReviewSection>
        <ReviewSection label="Tools and memory" problem={problems.tools} onchange={() => go("tools")}>
          <dl class="divide-y">
            <ReviewFact term="Tool servers" value={grantedServers.length > 0 ? grantedServers.join(", ") : "None"} />
            <ReviewFact
              term="Memory"
              value={remembers ? `Remembers${memoryAgentOnly ? " (this agent only)" : ""}, ${memoryBudget.trim() || "2000"}-token brief` : "Does not remember"}
            />
            {#if browserOffered}
              <ReviewFact term="Browser" value={browserEnabled ? "Has a browser" : "No browser"} />
            {/if}
          </dl>
        </ReviewSection>
        {#if skillsShown}
          <ReviewSection label="Skills" problem={problems.skills} onchange={() => go("skills")}>
            {#if skillSummary}
              <dl class="divide-y">
                <ReviewFact term="Ryph skills" value={skillSummary.catalogue} />
                <ReviewFact term="Org skills" value={skillSummary.org} />
                <ReviewFact term="Repo skills" value={skillSummary.workingRepos} />
              </dl>
            {:else}
              <p class="text-muted-foreground text-sm">Every skill this deployment offers.</p>
            {/if}
          </ReviewSection>
        {/if}
        <ReviewSection label="Permissions" problem={problems.permissions} onchange={() => go("permissions")}>
          <dl class="divide-y">
            <ReviewFact term="Issues and change requests" value={forgeSummary} />
            <ReviewFact term="Internet access" value={networkSummary} />
            <ReviewFact term="Patches" value={canOpenPatches ? "Can open patches" : "Can't open patches"} />
            <ReviewFact
              term="Artifacts"
              value={canPublishArtifacts ? "Can publish artifacts everyone can see" : "Can't publish artifacts"}
            />
          </dl>
        </ReviewSection>
        <ReviewSection label="Limits" problem={problems.limits} onchange={() => go("limits")}>
          <dl class="divide-y">
            <ReviewFact term="Limits" value={limitSummary} />
          </dl>
        </ReviewSection>
      </div>
    {/snippet}

    {#snippet footer()}
      <Button variant="ghost" href={data.backTo ?? "/agents"}>Cancel</Button>
      <div class="flex items-center gap-2">
        <Button variant="outline" type="button" disabled={index === 0} onclick={back}>
          <ArrowLeftIcon data-icon="inline-start" />
          Back
        </Button>
        {#if current === "review"}
          <Button type="submit" disabled={submitting}>
            {#if submitting}
              <Spinner data-icon="inline-start" />
            {:else}
              <PlusIcon data-icon="inline-start" />
            {/if}
            Create agent
          </Button>
        {:else}
          <Button type="submit">
            Next
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        {/if}
      </div>
    {/snippet}
  </SteppedFlow>
</form>
