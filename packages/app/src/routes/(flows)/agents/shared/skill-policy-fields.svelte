<script lang="ts">
import type { SkillPolicy, SkillsOverview } from "$lib/api/types";
import SkillRow from "$lib/components/skill-row/skill-row.svelte";
import ToggleRow from "$lib/components/toggle-row/toggle-row.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import { Switch } from "$lib/components/ui/switch";
import { forgeRepoLabel } from "$lib/utils/forge";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import XIcon from "@lucide/svelte/icons/x";
import { tick } from "svelte";
import {
  clearSkillChoice,
  type HiddenSkillChoice,
  hiddenSkillChoices,
  isDefaultSkillPolicy,
  skillPolicyToFields,
  skillsOffOnScreen,
  switchName,
} from "./skill-policy";

let {
  fields = $bindable(),
  overview,
}: {
  /** The agent's policy as the form holds it: the lists name what is off. */
  fields: SkillPolicy;
  /** What the deployment offers; null when it could not be read, and then nothing here changes. */
  overview: SkillsOverview | null;
} = $props();

// The org repo's skills, when there is a repo runs can get them from at all.
const org = $derived(overview?.org && !overview.org.archived ? overview.org : null);
const orgSkills = $derived(org?.current?.skills ?? []);
// The header speaks of what the switches show. A policy can also name skills no switch shows, kept
// so they stay off if they come back; those are named on their own line rather than making the
// header say something is off while every switch is on.
const isDefault = $derived(isDefaultSkillPolicy(fields));
const offOnScreen = $derived(overview !== null && skillsOffOnScreen(fields, overview));
const hidden = $derived(overview === null ? [] : hiddenSkillChoices(fields, overview));

// "Use the defaults" goes away once pressed, since there is nothing left to reset. Focus would go
// with it to the top of the form, so it moves to the line that now says the defaults are in use.
let status = $state<HTMLElement | null>(null);

async function useDefaults() {
  fields = skillPolicyToFields(null);
  await tick();
  status?.focus();
}

// A choice kept for a skill no switch shows is cleared on its own, so dropping one does not cost
// every other choice on the agent. Its button goes with it, so focus moves to the next one along,
// or to the status line once none is left.
let hiddenList = $state<HTMLElement | null>(null);

async function clearHidden(choice: HiddenSkillChoice, index: number) {
  fields = clearSkillChoice(fields, choice);
  await tick();
  const buttons = hiddenList?.querySelectorAll("button") ?? [];
  const next = buttons[Math.min(index, buttons.length - 1)];
  if (next) next.focus();
  else status?.focus();
}
</script>

{#if overview === null}
  <Field.FieldSet>
  <Field.FieldLegend>Skills</Field.FieldLegend>
  <Field.FieldDescription>
      Skills couldn't be loaded, so this agent's skill settings stay as they are. Everything else
      on this form saves as usual.
    </Field.FieldDescription>
</Field.FieldSet>
{:else}
  <div class="flex flex-col gap-10">
  <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div class="text-muted-foreground flex flex-col gap-1 text-sm">
        <p bind:this={status} tabindex="-1" class="outline-none">
          {#if isDefault}
            Uses the defaults: every skill this deployment offers.
          {:else if offOnScreen}
            Some skills are off for this agent.
          {:else}
            Every skill this deployment offers is on.
          {/if}
        </p>
        {#if hidden.length > 0}
          <p id="hidden-skill-choices">Kept off for this agent if offered again:</p>
          <ul
            bind:this={hiddenList}
            aria-labelledby="hidden-skill-choices"
            class="flex flex-wrap gap-1.5"
          >
            {#each hidden as choice, i (`${choice.kind}:${choice.label}`)}
              <li>
                <Badge variant="secondary" class="gap-1 pr-1 font-normal">
                  {choice.label}
                  <button
                    type="button"
                    class="hover:bg-foreground/10 focus-visible:ring-ring/50 -my-0.5 flex size-4 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-2"
                    aria-label="Stop keeping {choice.label} off"
                    title="Stop keeping {choice.label} off"
                    onclick={() => clearHidden(choice, i)}
                  >
                    <XIcon class="size-3" aria-hidden="true" />
                  </button>
                </Badge>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
      {#if !isDefault}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onclick={useDefaults}
        >
          Use the defaults
        </Button>
      {/if}
    </div>

  <Field.FieldSet>
      <Field.FieldLegend>Ryph skills</Field.FieldLegend>
      <Field.FieldDescription>Written by Ryph about its own config files.</Field.FieldDescription>
      {#if overview.catalogue.length === 0}
        <p class="text-muted-foreground text-sm">This deployment ships no Ryph skills.</p>
      {:else}
        <div class="divide-y rounded-lg border">
          {#each overview.catalogue as skill (skill.name)}
            {@const on = skill.enabled && !fields.catalogue.disabled.includes(skill.name)}
            <SkillRow
              id="skill-catalogue-{skill.name}"
              name={skill.name}
              description={skill.description}
              href="/skills/catalogue/{encodeURIComponent(skill.name)}"
              newTab
              off={!on}
            >
              {#snippet meta()}
                {#if !skill.enabled}
                  <Badge variant="outline">Turned off by an admin</Badge>
                {/if}
              {/snippet}
              {#snippet control()}
                <Switch
                  checked={on}
                  disabled={!skill.enabled}
                  aria-label="Use {skill.name}"
                  aria-describedby="skill-catalogue-{skill.name}-meta skill-catalogue-{skill.name}-description"
                  onCheckedChange={(next) => {
                    fields.catalogue.disabled = switchName(fields.catalogue.disabled, skill.name, next);
                  }}
                />
              {/snippet}
            </SkillRow>
          {/each}
        </div>
      {/if}
    </Field.FieldSet>

  <Field.FieldSet>
      <Field.FieldLegend>Org skills</Field.FieldLegend>
      <Field.FieldDescription>Skills your team keeps in one repository.</Field.FieldDescription>
      {#if org === null}
        <p class="text-muted-foreground text-sm">
          {overview.org?.archived
            ? "The org skills repository was disconnected, so there are none to use."
            : "No org skills repository is connected."}
        </p>
      {:else}
        <div class="rounded-lg border">
          <ToggleRow
            id="org-skills"
            label="Use org skills"
            description="From {forgeRepoLabel(org.repo)}"
            bind:checked={fields.org.enabled}
          />
        </div>
        {#if fields.org.enabled}
          {#if org.current === null}
            <p class="text-muted-foreground text-sm">
              {org.lastFailure ? "Org skills couldn't be synced yet." : "Org skills aren't synced yet."}
              <a
                href="/skills"
                target="_blank"
                rel="noreferrer"
                class="inline-flex items-center gap-1 underline underline-offset-4"
              >
                See Skills
                <ExternalLinkIcon class="size-3.5 shrink-0" aria-hidden="true" />
                <span class="sr-only">(opens in a new tab)</span>
              </a>
            </p>
          {:else if orgSkills.length === 0}
            <p class="text-muted-foreground text-sm">The repository has no skills yet.</p>
          {:else}
            <div class="divide-y rounded-lg border">
              {#each orgSkills as skill (skill.name)}
                {@const on = !fields.org.disabled.includes(skill.name)}
                <SkillRow
                  id="skill-org-{skill.name}"
                  name={skill.name}
                  description={skill.description}
                  href="/skills/org/{encodeURIComponent(skill.name)}"
                  newTab
                  off={!on}
                >
                  {#snippet control()}
                    <Switch
                      checked={on}
                      aria-label="Use {skill.name}"
                      aria-describedby="skill-org-{skill.name}-description"
                      onCheckedChange={(next) => {
                        fields.org.disabled = switchName(fields.org.disabled, skill.name, next);
                      }}
                    />
                  {/snippet}
                </SkillRow>
              {/each}
            </div>
          {/if}
        {/if}
      {/if}
    </Field.FieldSet>

  <Field.FieldSet>
    <Field.FieldLegend>Repo skills</Field.FieldLegend>
    <Field.FieldDescription>
        Skills in <code>.agents/skills</code> and <code>.claude/skills</code> of the repositories the agent works on.
      </Field.FieldDescription>
    <div class="rounded-lg border">
      <ToggleRow
        id="repo-skills"
        label="Load skills from working repositories"
        description={overview.workingRepoSkills
            ? "Anyone who can commit to a repository can add instructions for agents working on it."
            : "Turned off by an admin for every agent."}
        disabled={!overview.workingRepoSkills}
        checked={overview.workingRepoSkills && fields.workingRepos.enabled}
        onCheckedChange={(next) => {
            fields.workingRepos.enabled = next;
          }}
      />
    </div>
  </Field.FieldSet>
</div>
{/if}
