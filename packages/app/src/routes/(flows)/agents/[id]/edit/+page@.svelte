<script lang="ts">
import { can } from "$lib/utils/auth/capabilities";
import { goto, pushState } from "$app/navigation";
import { page } from "$app/state";
import { archiveAgent, updateAgent } from "$lib/api/agents";
import type {
  ForgePolicy,
  ModelPolicy,
  NetworkPolicy,
  RunLimits,
  SkillPolicy,
  ToolPolicy,
} from "$lib/api/types";
import SteppedFlow, { type FlowStepItem } from "$lib/components/stepped-flow/stepped-flow.svelte";
import { stepOf } from "$lib/components/stepped-flow/steps";
import UnsavedChangesGuard from "$lib/components/unsaved-changes-guard/unsaved-changes-guard.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Spinner } from "$lib/components/ui/spinner";
import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
import CheckIcon from "@lucide/svelte/icons/check";
import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import {
  AGENT_STEPS,
  type AgentStepId,
  effectiveEmail,
  identityProblem,
} from "../../shared/agent-steps";
import ForgePolicyFields from "../../shared/forge-policy-fields.svelte";
import {
  composeForgePolicy,
  forgePolicyProblem,
  forgePolicyToFields,
  forgeToolsOffered,
  forgeToolsState,
} from "../../shared/forge-policy";
import ModelFields from "../../shared/model-fields.svelte";
import IdentityFields from "../../shared/identity-fields.svelte";
import InstructionsFields from "../../shared/instructions-fields.svelte";
import MemoryFields from "../../shared/memory-fields.svelte";
import { composeMemoryPolicy, memoryPolicyToFields } from "../../shared/memory-policy";
import {
  composeModelPolicy,
  defaultModelThinkingLevels,
  editedDefaultThinking,
  modelPolicyProblem,
  policyToFields,
} from "../../shared/model-policy";
import LimitPolicyFields from "../../shared/limit-policy-fields.svelte";
import {
  composeLimitPolicy,
  limitPolicyProblem,
  limitPolicyToFields,
} from "../../shared/limit-policy";
import NetworkPolicyFields from "../../shared/network-policy-fields.svelte";
import PatchesFields from "../../shared/patches-fields.svelte";
import ArtifactsFields from "../../shared/artifacts-fields.svelte";
import BrowserFields from "../../shared/browser-fields.svelte";
import { browserLocked, browserUnavailableNote } from "../../shared/browser-policy";
import {
  composeNetworkPolicy,
  networkPolicyProblem,
  networkPolicyToFields,
} from "../../shared/network-policy";
import SkillPolicyFields from "../../shared/skill-policy-fields.svelte";
import {
  composeSkillPolicy,
  skillPolicyPatch,
  skillPolicyToFields,
} from "../../shared/skill-policy";
import ToolPolicyFields from "../../shared/tool-policy-fields.svelte";
import { composeToolPolicy, policyToGrants, toolPolicyProblem } from "../../shared/tool-policy";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// The form intentionally seeds from the loaded agent and diverges as the
// user edits, so capturing the initial value is what we want here.
// svelte-ignore state_referenced_locally
let name = $state(data.agent.name);
// svelte-ignore state_referenced_locally
let handle = $state(data.agent.handle ?? "");
// svelte-ignore state_referenced_locally
let email = $state(data.agent.email);
// Not editable: sent back as stored.
// svelte-ignore state_referenced_locally
const harnessKind = data.agent.harnessKind;
// svelte-ignore state_referenced_locally
let systemPrompt = $state(data.agent.systemPrompt ?? "");
// svelte-ignore state_referenced_locally
const seededPolicy = policyToFields(data.agent.modelPolicy);
let providerKeyId = $state(seededPolicy.providerKeyId);
let allowedModels = $state(seededPolicy.allowedModels);
let defaultModel = $state(seededPolicy.defaultModel);
let defaultThinking = $state(seededPolicy.defaultThinking);
// A model that takes no level hides the pick, and nothing is sent for it — once the person has
// moved the key or the model. Until then the stored level goes back as it was.
const sentThinking = $derived(
  editedDefaultThinking(
    seededPolicy,
    providerKeyId,
    defaultModel,
    defaultThinking,
    defaultModelThinkingLevels(
      data.providers,
      data.providerKeys,
      providerKeyId,
      defaultModel,
      data.agent.modelPolicy,
    ),
  ),
);
// svelte-ignore state_referenced_locally
let toolGrants = $state(policyToGrants(data.agent.toolPolicy));
// svelte-ignore state_referenced_locally
const seededMemory = memoryPolicyToFields(data.agent.memoryPolicy);
let remembers = $state(seededMemory.remembers);
let memoryBudget = $state(seededMemory.memoryBudget);
let memoryAgentOnly = $state(seededMemory.memoryAgentOnly);
// svelte-ignore state_referenced_locally
let forgeFields = $state(forgePolicyToFields(data.agent.forgePolicy));
const forgeState = $derived(forgeToolsState(data.toolAccessState, data.mcpServers));
const canGrantForge = $derived(can(data.user, "agents:policy"));
// svelte-ignore state_referenced_locally
let networkFields = $state(networkPolicyToFields(data.agent.networkPolicy));
const canGrantNetwork = $derived(can(data.user, "agents:policy"));
// svelte-ignore state_referenced_locally
let limitFields = $state(limitPolicyToFields(data.agent.limitPolicy));
const canGrantLimits = $derived(can(data.user, "agents:policy"));
// svelte-ignore state_referenced_locally
let skillFields = $state(skillPolicyToFields(data.agent.skillPolicy));
// svelte-ignore state_referenced_locally
let canOpenPatches = $state(data.agent.canOpenPatches);
// svelte-ignore state_referenced_locally
let canPublishArtifacts = $state(data.agent.canPublishArtifacts);
// svelte-ignore state_referenced_locally
let browserEnabled = $state(data.agent.browserEnabled);
// Switching patches back on is an admin's call, so anyone else finds the switch held off.
const patchesLocked = $derived(!data.agent.canOpenPatches && !can(data.user, "agents:policy"));
// So is letting it publish artifacts.
const artifactsLocked = $derived(
  !data.agent.canPublishArtifacts && !can(data.user, "agents:policy"),
);
// And giving it a browser.
const browserHeld = $derived(
  browserLocked(data.agent.browserEnabled, can(data.user, "agents:policy")),
);
let submitting = $state(false);
let archiving = $state(false);

// Whether anything differs from the agent as loaded, for the guard against leaving by accident. One
// string of every field against the same string taken at the start; a successful save sets `saved`
// so the move to the list goes through. The skill policy is taken as it would be saved, so a switch
// turned off and on again, which reorders its list, is no change.
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
    skillPolicy: composeSkillPolicy(skillFields),
    canOpenPatches,
    canPublishArtifacts,
    browserEnabled,
  });
const pristine = untrack(snapshot);
const dirty = $derived(!saved && snapshot() !== pristine);

// The same steps the agent was made in, minus the review: an existing agent has nothing to
// confirm, and Save is on every step. Every step counts as seen, so a problem shows at once.
// The Skills step only for a harness that reads skills: every switch on it would be ignored
// otherwise. With no harness list (manual dev), it is shown, as the Tools step is.
const selectedHarness = $derived(data.harnesses.find((h) => h.kind === harnessKind));
const skillsShown = $derived(selectedHarness === undefined || selectedHarness.skills);
// The Browser switch, held off with the reason under it where the harness gets no browser on this
// deployment, except on an agent that already has it on, so that switch can still be turned off.
// With no harness list, only on an agent that has it on.
const browserNote = $derived(selectedHarness ? browserUnavailableNote(selectedHarness) : null);
const browserShown = $derived(selectedHarness !== undefined || data.agent.browserEnabled);
const STEPS = $derived(
  AGENT_STEPS.filter((step) => step.id !== "review" && (step.id !== "skills" || skillsShown)),
);
const current = $derived(stepOf(page.state, STEPS));
const index = $derived(STEPS.findIndex((step) => step.id === current));

// Every step's reason it cannot be saved as it stands, or null; they drive the marks in the list
// and the save's refusal alike. Each is only asked where the form could have changed the answer,
// so a policy that cannot be shown is never a problem that cannot be fixed.
const problems = $derived<Record<AgentStepId, string | null>>({
  identity: identityProblem(name, handle, email, page.url.hostname),
  model: data.modelAccessEnabled
    ? modelPolicyProblem(providerKeyId, allowedModels, defaultModel)
    : null,
  instructions: null,
  tools: data.toolAccessEnabled ? toolPolicyProblem(toolGrants, data.mcpServers) : null,
  skills: null,
  permissions: (forgeState === "on" && canGrantForge
    ? forgePolicyProblem(forgeFields, data.connectedRepos)
    : null) ??
    (data.egressState === "on" && canGrantNetwork
      ? networkPolicyProblem(networkFields, data.egressCeiling)
      : null),
  limits: data.limits !== null && canGrantLimits
    ? limitPolicyProblem(limitFields, data.limits)
    : null,
  review: null,
});

const steps = $derived<FlowStepItem[]>(STEPS.map((step) => ({
  ...step,
  status: problems[step.id] === null ? "done" : "problem",
})));

// The step on screen lives in the history entry's state (shallow routing), so the browser's
// back and forward buttons walk the steps: `pushState` adds an entry without a navigation —
// no load runs, the leave guard is not asked — and a popstate only hands the state back.
function go(id: AgentStepId) {
  if (id !== current) pushState("", { step: id });
}

/**
 * The policy half of the patch. With model access on the form owns the policy outright. With it
 * off the form cannot compose one — no key rows to compose from — so the only edit it can carry
 * is removal: leaving the field out keeps the standing policy, where a null would revoke it as a
 * side effect of renaming the agent.
 */
function policyPatch(): { modelPolicy?: ModelPolicy | null } {
  if (data.modelAccessEnabled) {
    return {
      modelPolicy: composeModelPolicy(
        providerKeyId,
        allowedModels,
        defaultModel,
        data.providerKeys,
        sentThinking,
      ),
    };
  }
  const removed = data.agent.modelPolicy !== null && providerKeyId === "";
  return removed ? { modelPolicy: null } : {};
}

/** The tool half of the patch, under the same rule: owned outright with tool access on, removal
 * only with it off. */
function toolPolicyPatch(): { toolPolicy?: ToolPolicy | null } {
  if (data.toolAccessEnabled) return { toolPolicy: composeToolPolicy(toolGrants) };
  const removed = data.agent.toolPolicy !== null && toolGrants.length === 0;
  return removed ? { toolPolicy: null } : {};
}

/**
 * The forge half of the patch, under the same rule once more — with one more reason to be
 * removal-only: granting is an admin's call, so for anyone else the form can only take the access
 * away, and leaving the field out keeps what an admin granted.
 */
function forgePolicyPatch(): { forgePolicy?: ForgePolicy | null } {
  const composed = composeForgePolicy(forgeFields);
  if (forgeState === "on" && canGrantForge) return { forgePolicy: composed };
  const removed = data.agent.forgePolicy !== null && composed === null;
  return removed ? { forgePolicy: null } : {};
}

/**
 * The internet half of the patch, and the one that is NOT removal-only when the user cannot
 * change it — it is omitted entirely.
 *
 * Every other policy here can be taken away by anyone, because taking access away needs no
 * privilege. This one has no "take away" that is not also a "give": clearing it hands the agent
 * the deployment's whole allowlist back. So a non-admin, or a form that could not read the
 * ceiling, sends nothing at all and leaves what an admin set exactly as it stands.
 */
function networkPolicyPatch(): { networkPolicy?: NetworkPolicy | null } {
  if (data.egressState !== "on" || !canGrantNetwork) return {};
  return { networkPolicy: composeNetworkPolicy(networkFields) };
}

/** The limits half of the patch, under the egress rule: clearing them hands the agent the
 * deployment's ceiling back, so only an admin who could read the ceiling sends anything. */
function limitPolicyPatch(): { limitPolicy?: RunLimits | null } {
  if (data.limits === null || !canGrantLimits) return {};
  return { limitPolicy: composeLimitPolicy(limitFields) };
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
    const agent = await updateAgent(fetch, data.agent.id, {
      name,
      // Absent leaves a legacy null handle alone; typed, it becomes the command address.
      ...(handle.trim() ? { handle: handle.trim() } : {}),
      // Cleared, the email goes back to the default rather than to nothing.
      email: effectiveEmail(name, handle, email, page.url.hostname),
      harnessKind,
      systemPrompt: systemPrompt.trim() ? systemPrompt : null,
      // null clears the policy — deselecting the key revokes future runs' model access.
      ...policyPatch(),
      // Same for tools: no grants left means the next run has none.
      ...toolPolicyPatch(),
      // And for issues and change requests: nothing ticked means the next run cannot write there.
      ...forgePolicyPatch(),
      // And for the internet: narrowing binds the next run, and clearing hands the deployment's
      // allowlist back — both an admin's call, so both are omitted for anyone else.
      ...networkPolicyPatch(),
      // And for the limits: nothing ticked means the next run is under the ceiling alone.
      ...limitPolicyPatch(),
      // And for skills: back to null is every skill the deployment offers, and no more.
      ...skillPolicyPatch({
        shown: skillsShown,
        offered: data.skills !== null,
        stored: data.agent.skillPolicy,
        fields: skillFields,
      }),
      // And for memory: unticked means the next run starts knowing nothing of previous ones.
      memoryPolicy: composeMemoryPolicy(remembers, memoryBudget, memoryAgentOnly),
      // Sent only when moved: a stale form saved for a rename must not undo a switch someone
      // else flipped since it loaded.
      ...(canOpenPatches === data.agent.canOpenPatches ? {} : { canOpenPatches }),
      ...(canPublishArtifacts === data.agent.canPublishArtifacts ? {} : { canPublishArtifacts }),
      ...(browserEnabled === data.agent.browserEnabled ? {} : { browserEnabled }),
    });
    toast.success(`Saved "${agent.name}"`);
    saved = true;
    await goto("/agents");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to save agent");
  } finally {
    submitting = false;
  }
}

async function handleArchive() {
  archiving = true;

  try {
    await archiveAgent(fetch, data.agent.id);
    toast.success(`Archived "${data.agent.name}"`);
    saved = true;
    await goto("/agents");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to archive agent");
  } finally {
    archiving = false;
  }
}
</script>

<svelte:head>
  <title>Edit {data.agent.name} · Ryph</title>
</svelte:head>

<UnsavedChangesGuard {dirty} />

<form onsubmit={submit} novalidate class="contents">
  <SteppedFlow
    title="Edit agent"
    cancelHref="/agents"
    {steps}
    {current}
    select={(id) => go(id as AgentStepId)}
  >
    {#snippet children(shown: string)}
      <div hidden={shown !== "identity"} class="max-w-2xl flex flex-col gap-6">
        {#if data.agent.archivedAt}
          <div>
            <Badge variant="outline">Archived</Badge>
          </div>
        {/if}
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
          storedPolicy={data.agent.modelPolicy}
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
          {#if browserShown}
            <BrowserFields
              bind:browserEnabled
              unavailable={browserNote}
              savedOn={data.agent.browserEnabled}
              locked={browserHeld}
            />
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
        <PatchesFields bind:canOpenPatches locked={patchesLocked} />
        <ArtifactsFields bind:canPublishArtifacts locked={artifactsLocked} />
      </div>
      <div hidden={shown !== "limits"} class="max-w-2xl">
        <LimitPolicyFields bind:fields={limitFields} limits={data.limits} canGrant={canGrantLimits} />
      </div>
    {/snippet}

    {#snippet footer()}
      <div class="flex items-center gap-2">
        <Button variant="ghost" href="/agents">Cancel</Button>
        {#if !data.agent.archivedAt}
          <Button variant="destructive" type="button" disabled={archiving} onclick={handleArchive}>
            {#if archiving}
              <Spinner data-icon="inline-start" />
            {/if}
            Archive
          </Button>
        {/if}
      </div>
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
