<script lang="ts">
import { can } from "$lib/utils/auth/capabilities";
import { putSkillSettings, type SkillSettingsInput } from "$lib/api/skills";
import type { SkillsOverview } from "$lib/api/types";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import SettingsSection from "$lib/components/settings-section/settings-section.svelte";
import SkillCard from "$lib/components/skill-card/skill-card.svelte";
import ToggleRow from "$lib/components/toggle-row/toggle-row.svelte";
import { Badge } from "$lib/components/ui/badge";
import * as Empty from "$lib/components/ui/empty";
import { Separator } from "$lib/components/ui/separator";
import { Switch } from "$lib/components/ui/switch";
import { skillTitle } from "$lib/utils/skill-presentation";
import { shortDigest } from "$lib/utils/skills";
import FolderGit2Icon from "@lucide/svelte/icons/folder-git-2";
import { tick } from "svelte";
import { toast } from "svelte-sonner";
import OrgRepoConnect from "./org-repo-connect.svelte";
import OrgRepoGuide from "./org-repo-guide.svelte";
import OrgRepoPanel from "./org-repo-panel.svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const canManage = $derived(can(data.user, "skills:manage"));

// What the page shows: the load's overview, replaced by the one every write answers with, and
// back to the load's on the next load.
let overview: SkillsOverview = $derived(data.overview);

// ---- the switches ----
// Every switch is saved together, as the route takes them. A flip shows at once, and the switches
// stay usable while a write is out, so a keyboard user keeps their place: a flip made meanwhile is
// saved once that write settles, so two writes never race. A failed write puts back only the
// switches, as last saved, so an org repo answer that landed meanwhile is kept.
let saving = false;
let queued = false;
let saved: SkillSettingsInput = $derived(switchesOf(data.overview));

function switchesOf(of: SkillsOverview): SkillSettingsInput {
  return {
    disabledCatalogue: of.catalogue.filter((s) => !s.enabled).map((s) => s.name),
    workingRepoSkills: of.workingRepoSkills,
  };
}

function showSwitches(next: SkillSettingsInput) {
  overview = {
    ...overview,
    catalogue: overview.catalogue.map((s) => ({
      ...s,
      enabled: !next.disabledCatalogue.includes(s.name),
    })),
    workingRepoSkills: next.workingRepoSkills,
  };
}

async function saveSwitches() {
  if (saving) {
    queued = true;
    return;
  }
  saving = true;
  try {
    do {
      queued = false;
      const next = switchesOf(overview);
      try {
        const answer = await putSkillSettings(fetch, next);
        saved = next;
        // The org repo is the org actions' to answer for, and a flip made meanwhile is saved next;
        // until then this answer would undo it on screen.
        if (!queued) overview = { ...answer, org: overview.org };
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn't save the skill settings");
        if (!queued) showSwitches(saved);
      }
    } while (queued);
  } finally {
    saving = false;
  }
}

// An org action answers with the whole overview, read before any switch flipped meanwhile, and
// the switch writes build their next body from what is on screen. So only the org repo is taken
// from it; the switches are theirs to answer for, as the org repo is in a switch write's answer.
//
// Connecting the first repo, or disconnecting the last, swaps the connect form for the repo's
// panel or back, and focus would go with the button that did it, to the top of the page. It goes
// to the section's heading instead, which stays.
async function takeOrg(answer: SkillsOverview) {
  const swapped = (overview.org === null) !== (answer.org === null);
  overview = { ...overview, org: answer.org };
  if (!swapped) return;
  await tick();
  document.getElementById("org-skills-title")?.focus();
}

function setCatalogue(name: string, on: boolean) {
  const now = switchesOf(overview);
  const rest = now.disabledCatalogue.filter((n) => n !== name);
  showSwitches({ ...now, disabledCatalogue: on ? rest : [...rest, name] });
  void saveSwitches();
}

function setWorkingRepos(on: boolean) {
  showSwitches({ ...switchesOf(overview), workingRepoSkills: on });
  void saveSwitches();
}
</script>

<svelte:head>
  <title>Skills · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-10">
  <PageTitle title="Skills">
    {#snippet description()}
      Instructions agents read when a task calls for them, up to {overview.limits.skills} in a run.
      When two share a name, the one higher on this page wins.
    {/snippet}
  </PageTitle>

  <SettingsSection id="ryph-skills" title="Ryph skills">
    {#snippet description()}
      Written by Ryph about its own config files. On for every agent unless an admin turns one off
      here. To leave one out for a single agent, use that agent's settings.
      {#if !canManage}
        Only an admin can change these.
      {/if}
    {/snippet}
    {#if overview.catalogue.length === 0}
      <p class="text-muted-foreground text-sm">This deployment ships no Ryph skills.</p>
    {:else}
      <!-- Cards sized against the column they sit in, not the window: one across on a phone or
           beside the section's text, two or three once there is room. -->
      <div class="@container">
        <ul class="grid gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
          {#each overview.catalogue as skill (skill.name)}
            <li class="flex">
              <SkillCard
                id="skill-catalogue-{skill.name}"
                name={skill.name}
                description={skill.description}
                presentation={skill.presentation}
                href="/skills/catalogue/{encodeURIComponent(skill.name)}"
                off={!skill.enabled}
              >
                {#snippet meta()}
                  <Badge
                    variant="outline"
                    class="font-mono font-normal"
                  >
                    {shortDigest(skill.digest)}
                  </Badge>
                {/snippet}
                {#snippet control()}
                  <Switch
                    checked={skill.enabled}
                    disabled={!canManage}
                    aria-label="Use {skillTitle(skill)}"
                    aria-describedby="skill-catalogue-{skill.name}-description"
                    onCheckedChange={(on) => setCatalogue(skill.name, on)}
                  />
                {/snippet}
              </SkillCard>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </SettingsSection>

  <Separator />

  <SettingsSection id="org-skills" title="Org skills">
    {#snippet description()}
      Skills your team keeps in one repository. On for every agent. To leave them out for a single
      agent, use that agent's settings.
    {/snippet}
    {#if overview.org}
      <OrgRepoPanel
        org={overview.org}
        repos={data.connectedRepos}
        {canManage}
        onchange={takeOrg}
      />
    {:else if canManage}
      <OrgRepoGuide />
      <OrgRepoConnect repos={data.connectedRepos} onconnected={takeOrg} />
    {:else}
      <Empty.Root class="border border-dashed py-8">
        <Empty.Header>
          <Empty.Media variant="icon">
            <FolderGit2Icon />
          </Empty.Media>
          <Empty.Title>No org skills repository</Empty.Title>
          <Empty.Description>An admin can connect one here.</Empty.Description>
        </Empty.Header>
      </Empty.Root>
    {/if}
  </SettingsSection>

  <Separator />

  <SettingsSection id="repo-skills" title="Repo skills">
    {#snippet description()}
      Skills in <code>.agents/skills</code> of the repositories an agent works on. On for every
      agent unless an admin turns them off here. To leave them out for a single agent, use that
      agent's settings.
      {#if !canManage}
        Only an admin can change this.
      {/if}
    {/snippet}
    <div class="rounded-lg border">
      <ToggleRow
        id="working-repo-skills"
        label="Load skills from working repositories"
        description="Anyone who can commit to a repository can add instructions for agents working on it."
        disabled={!canManage}
        checked={overview.workingRepoSkills}
        onCheckedChange={setWorkingRepos}
      />
    </div>
  </SettingsSection>
</div>
