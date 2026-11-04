<script lang="ts">
import { can } from "$lib/utils/auth/capabilities";
import ObjectHeader from "$lib/components/object-header/object-header.svelte";
import RepoChecksPanel from "$lib/components/repo-checks-panel/repo-checks-panel.svelte";
import RepoServicesPanel from "$lib/components/repo-services-panel/repo-services-panel.svelte";
import AsyncPanel from "$lib/components/async-panel/async-panel.svelte";
import { goto, invalidate } from "$app/navigation";
import { isWebLink } from "$lib/api/forge";
import { ApiError } from "$lib/api/call";
import {
  addCommandAllowlistEntry,
  archiveConnectedRepo,
  getRepoGitlabHook,
  type GitlabHookStatus,
  removeCommandAllowlistEntry,
  updateConnectedRepo,
} from "$lib/api/repos";
import type { CommandAllowlistEntry, SubmissionPolicy } from "$lib/api/types";
import CommandBlock from "$lib/components/command-block/command-block.svelte";
import CopyButton from "$lib/components/copy-button/copy-button.svelte";
import EnvironmentPanel from "$lib/components/environment-panel/environment-panel.svelte";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import GitlabHookPanel from "$lib/components/gitlab-hook/gitlab-hook-panel.svelte";
import SettingsSection from "$lib/components/settings-section/settings-section.svelte";
import SizeClassSelect from "$lib/components/size-class-select/size-class-select.svelte";
import * as Alert from "$lib/components/ui/alert";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import { Separator } from "$lib/components/ui/separator";
import { Spinner } from "$lib/components/ui/spinner";
import { Switch } from "$lib/components/ui/switch";
import * as ToggleGroup from "$lib/components/ui/toggle-group";
import { formatDateTime } from "$lib/utils/format";
import { changeRequestNoun, isDid, localRepoName, shortenDid } from "$lib/utils/forge";
import { gitlabProjectPage } from "$lib/utils/gitlab";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import EyeIcon from "@lucide/svelte/icons/eye";
import GitBranchIcon from "@lucide/svelte/icons/git-branch";
import GlobeIcon from "@lucide/svelte/icons/globe";
import LockIcon from "@lucide/svelte/icons/lock";
import PlusIcon from "@lucide/svelte/icons/plus";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import UnplugIcon from "@lucide/svelte/icons/unplug";
import XIcon from "@lucide/svelte/icons/x";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const repo = $derived(data.repo);
const radicle = $derived(data.radicle);
// Radicle user mode: the node and identity are the machine owner's, and Ryph's patches are signed
// as them. Any member may be looking, so the copy names the identity, never "you".
const mine = $derived(data.radicleMine);
const who = $derived(radicle ? (radicle.alias ?? shortenDid(radicle.did)) : null);
const canManageResources = $derived(can(data.user, "resources:manage"));
// The webhook's token and its rotation stand behind repos:manage (and Maintainer, asked live).
const canManageRepos = $derived(can(data.user, "repos:manage"));
const github = $derived(repo.provider === "github");
const gitlab = $derived(repo.provider === "gitlab");
const local = $derived(repo.provider === "local");
// GitHub's and GitLab's addresses are names people read; a RID and a path are not.
const named = $derived(github || gitlab);
// Only an App installation, or GitLab's bot, can push to a fork's branch; a deployment acting as
// one person never can.
const forkPushable = $derived(
  (github && repo.installationId !== null) || (gitlab && data.gitlab?.mode === "bot"),
);
// What a run's work becomes on this forge, in the forge's own word.
const change = $derived(changeRequestNoun(repo.provider));
// Where "Open on …" goes: GitLab's row carries the clone URL, whose page is the same path.
const repoPage = $derived(gitlab ? gitlabProjectPage(repo.url) : repo.url);
const title = $derived(
  named
    ? (repo.repoRef.split("/").at(-1) ?? repo.repoRef)
    : local
    ? localRepoName(repo.repoRef)
    : (radicle?.name ?? repo.repoRef),
);

// ---- submission policy ----
// Held locally so the toggle moves on click; a failed write puts it back.
let policy: SubmissionPolicy = $derived(repo.submissionPolicy);
// A local repo has no pull request or patch to open: approved work lands as a branch in it.
const policyNote = $derived(
  local
    ? policy === "auto"
      ? "The work is added as a branch in the repository as soon as the run finishes, with no review in between."
      : "Every change waits in Patches until someone approves it, then appears as a branch in the repository."
    : policy === "auto"
    ? `The ${change} opens as soon as the run finishes, with no review in between.`
    : `Every ${change} waits in Patches until someone approves it.`,
);

async function changePolicy(next: string) {
  // A single toggle group can be emptied by clicking the pressed item; that is not a choice.
  if (next !== "auto" && next !== "require-approval") return;
  if (next === repo.submissionPolicy) return;
  policy = next;
  try {
    await updateConnectedRepo(fetch, repo.id, { submissionPolicy: next });
    await invalidate("app:repo");
  } catch (e) {
    policy = repo.submissionPolicy;
    toast.error(e instanceof Error ? e.message : "Failed to change the policy");
  }
}

async function changeSize(sizeClass: string | null) {
  try {
    await updateConnectedRepo(fetch, repo.id, { sizeClass });
    toast.success(sizeClass === null ? "Runs use the default size" : `Runs are ${sizeClass}`);
    await invalidate("app:repo");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to change the size");
  }
}

// ---- pushing to fork branches (a GitHub App or a GitLab bot only) ----
// Held locally so the switch moves on click; a failed write puts it back.
let forkPushes = $derived(repo.allowForkPushes);

async function changeForkPushes(next: boolean) {
  forkPushes = next;
  try {
    await updateConnectedRepo(fetch, repo.id, { allowForkPushes: next });
    await invalidate("app:repo");
  } catch (e) {
    forkPushes = repo.allowForkPushes;
    toast.error(e instanceof Error ? e.message : "Failed to change the setting");
  }
}

// ---- the GitLab webhook (bot mode only) ----
// Read when asked, never on load: the token is shown only to a Maintainer of the project, and
// the control plane checks that live.
let hook = $state.raw<GitlabHookStatus | null>(null);
let hookLoading = $state(false);

async function showHook() {
  hookLoading = true;
  try {
    hook = await getRepoGitlabHook(fetch, repo.id);
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 403
        ? "Only a Maintainer of the project on GitLab can see its webhook."
        : e instanceof Error
        ? e.message
        : "Failed to read the webhook",
    );
  } finally {
    hookLoading = false;
  }
}

// ---- who may /ryph: the repository's delegates, and the allowlist beside them ----
// Held locally after each write, because every call answers with the whole list.
let entries: CommandAllowlistEntry[] | null = $derived(data.allowlist);

let subject = $state("");
let adding = $state(false);
let removing = $state<string | null>(null);

const subjectProblem = $derived(
  subject.trim() === "" || isDid(subject) ? null : "A DID starts with did:key:z.",
);

async function addEntry(event: SubmitEvent) {
  event.preventDefault();
  if (!isDid(subject)) return;
  adding = true;
  try {
    entries = await addCommandAllowlistEntry(fetch, repo.id, subject.trim());
    subject = "";
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to add the identity");
  } finally {
    adding = false;
  }
}

async function removeEntry(entrySubject: string) {
  removing = entrySubject;
  try {
    entries = await removeCommandAllowlistEntry(fetch, repo.id, entrySubject);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to remove the identity");
  } finally {
    removing = null;
  }
}

// ---- disconnect ----
let disconnectOpen = $state(false);
let disconnecting = $state(false);

async function disconnect() {
  disconnecting = true;
  try {
    await archiveConnectedRepo(fetch, repo.id);
    toast.success(`Disconnected ${title}`);
    await goto("/repos", { invalidateAll: true });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to disconnect the repository");
    disconnecting = false;
  }
}
</script>

<svelte:head>
  <title>{title} · Ryph</title>
</svelte:head>

{#snippet openRepo()}
  {#if isWebLink(repoPage)}
    <Button variant="outline" href={repoPage} target="_blank" rel="noreferrer">
      <ExternalLinkIcon data-icon="inline-start" />
      {github ? "Open on GitHub" : gitlab ? "Open on GitLab" : "Open in explorer"}
    </Button>
  {/if}
{/snippet}

<div class="flex flex-col gap-10">
  <ObjectHeader {title} actions={isWebLink(repoPage) ? openRepo : undefined}>
    {#snippet icon()}
      <ForgeIcon provider={repo.provider} class="text-foreground" />
    {/snippet}
    <div class="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span class="flex min-w-0 items-center gap-1">
        <span class={["truncate", !named && "font-mono text-xs"]} title={repo.repoRef}>
          {repo.repoRef}
        </span>
        <!-- Held to the line's height, so the button's hit area does not push the lines apart. -->
        <span class="inline-flex h-5 items-center">
          <CopyButton
            value={repo.repoRef}
            label={github
            ? "Copy the repository name"
            : gitlab
            ? "Copy the project path"
            : local
            ? "Copy the path"
            : "Copy the repository id"}
            what={github
            ? "Repository name copied"
            : gitlab
            ? "Project path copied"
            : local
            ? "Path copied"
            : "Repository id copied"}
          />
        </span>
      </span>
      <span class="flex items-center gap-1.5">
        <GitBranchIcon class="size-3.5" />
        {repo.defaultBranch}
      </span>
      {#if radicle}
        <span class="flex items-center gap-1.5">
          {#if radicle.visibility === "private"}
            <LockIcon class="size-3.5" /> Private
          {:else}
            <GlobeIcon class="size-3.5" /> Public
          {/if}
        </span>
      {/if}
    </div>
  </ObjectHeader>

  <!-- The one thing that silently breaks every run here, above everything else. -->
  {#if radicle && radicle.visibility === "private" && !radicle.isAllowed}
    <Alert.Root variant="destructive">
      <TriangleAlertIcon />
      <Alert.Title>{mine ? "This machine's node can't fetch this repository" : "Ryph can't fetch this repository"}</Alert.Title>
      <Alert.Description class="flex flex-col gap-3">
        <span>
          It's private and {mine ? `${who} isn't` : "Ryph isn't"} on its allow list, so no run can
          check it out. A delegate can fix it from a working copy:
        </span>
        <CommandBlock command={`rad id update --allow ${radicle.did}`} />
      </Alert.Description>
    </Alert.Root>
  {/if}

  <SettingsSection
    id="submission"
    title="Submitting work"
    description={local
      ? "What happens to a run's work once the run finishes cleanly."
      : `What happens to a run's ${change} once the run finishes cleanly.`}
  >
    <ToggleGroup.Root
      type="single"
      variant="outline"
      value={policy}
      onValueChange={changePolicy}
      class="w-fit"
    >
      <ToggleGroup.Item value="require-approval">Wait for approval</ToggleGroup.Item>
      <ToggleGroup.Item value="auto">Submit automatically</ToggleGroup.Item>
    </ToggleGroup.Root>
    <p class="text-muted-foreground text-sm">{policyNote}</p>
  </SettingsSection>

  <Separator />

  {#if forkPushable}
    <SettingsSection
      id="fork-pushes"
      title="Changes from forks"
      description="Runs on a fork's {change} check out its code either way. This decides whether they can push to its branch."
    >
      <div class="flex items-center gap-3">
        <Switch id="allow-fork-pushes" checked={forkPushes} onCheckedChange={changeForkPushes} />
        <Label for="allow-fork-pushes">Push to fork branches</Label>
      </div>
      <p class="text-muted-foreground text-sm">
        {#if gitlab}
          Only when the author allows commits from members who can merge, and
          @{data.gitlab?.login} can merge into the target branch. As a Developer it can't merge
          into a protected branch, so there the run says it can't push, and its commits go nowhere.
        {:else}
          Only when the author allows edits from maintainers. Otherwise the run says it can't push,
          and its commits go nowhere.
        {/if}
      </p>
    </SettingsSection>

    <Separator />
  {/if}

  <SettingsSection
    id="size"
    title="Machine size"
    description="How much CPU, memory and disk a run on this repository gets."
  >
    <SizeClassSelect
      value={repo.sizeClass}
      sizes={data.sizes}
      canChange={canManageResources}
      onChange={changeSize}
    />
  </SettingsSection>

  <Separator />

  <SettingsSection id="environment" title="Environment">
    {#snippet description()}
      The image a run starts on, built from <code>.ryph/Dockerfile</code> and
      <code>.ryph/setup.yml</code> with a warm checkout inside. A workspace's own environment
      overrides it.
    {/snippet}
    <AsyncPanel>
      <EnvironmentPanel
        subject={{ kind: "repo", id: repo.id }}
        environment={data.environment}
        definition={data.environmentDefinition}
        canManage={canManageResources}
      />
    </AsyncPanel>
  </SettingsSection>

  <Separator />

  <SettingsSection id="services" title="Services">
    {#snippet description()}
      Databases and caches started alongside runs. Checks start only the services they request.
    {/snippet}
    <AsyncPanel>
      <RepoServicesPanel
        services={data.services}
        connectedRepoId={repo.id}
        defaultBranch={repo.defaultBranch}
      />
    </AsyncPanel>
  </SettingsSection>

  <Separator />

  <SettingsSection id="checks" title="Checks">
    {#snippet description()}
      What <code>.ryph/checks.yml</code> runs before {local
        ? "an agent's work is added as a branch"
        : `an agent opens a ${change}`}, and how each check did last on {repo.defaultBranch}.
    {/snippet}
    <AsyncPanel>
      <RepoChecksPanel checks={data.checks} connectedRepoId={repo.id} />
    </AsyncPanel>
  </SettingsSection>

  {#if repo.provider === "radicle"}
    <Separator />

    <SettingsSection id="access" title="Who can summon agents">
      {#snippet description()}
        People who can start a run with <code>/ryph</code> in an issue or patch. Delegates always
        can. Anyone else needs to be listed here and to have a Ryph account linked to their DID.
      {/snippet}
      <ul class="divide-y rounded-lg border text-sm">
        {#each radicle?.delegates ?? [] as delegate (delegate)}
          <li class="flex items-center gap-3 px-3 py-2">
            <span class="min-w-0 flex-1 truncate font-mono text-xs" title={delegate}>
              {shortenDid(delegate)}
            </span>
            <Badge variant="secondary">Delegate</Badge>
          </li>
        {/each}
        {#each entries ?? [] as entry (entry.subject)}
          <li class="flex items-center gap-3 px-3 py-2">
            <span class="min-w-0 flex-1 truncate font-mono text-xs" title={entry.subject}>
              {shortenDid(entry.subject)}
            </span>
            <span class="text-muted-foreground text-xs">
              Added {formatDateTime(entry.createdAt)}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove {entry.subject}"
              disabled={removing === entry.subject}
              onclick={() => removeEntry(entry.subject)}
            >
              {#if removing === entry.subject}
                <Spinner />
              {:else}
                <XIcon />
              {/if}
            </Button>
          </li>
        {/each}
        {#if !radicle && (entries ?? []).length === 0}
          <li class="text-muted-foreground px-3 py-2">
            The delegates couldn't be read from {mine ? "this machine's Radicle node" : "Ryph's node"}.
          </li>
        {/if}
      </ul>

      {#if entries === null}
        <p class="text-muted-foreground text-sm">Only an admin can change this list.</p>
      {:else}
        <form onsubmit={addEntry}>
          <Field.Field data-invalid={subjectProblem !== null}>
            <Field.FieldLabel for="allowlist-subject" class="sr-only">
              Add an identity
            </Field.FieldLabel>
            <div class="flex items-start gap-2">
              <Input
                id="allowlist-subject"
                bind:value={subject}
                placeholder="did:key:z6Mk…"
                spellcheck={false}
                autocapitalize="off"
                autocomplete="off"
                aria-invalid={subjectProblem !== null}
              />
              <Button type="submit" variant="outline" disabled={adding || !isDid(subject)}>
                {#if adding}
                  <Spinner data-icon="inline-start" />
                {:else}
                  <PlusIcon data-icon="inline-start" />
                {/if}
                Add
              </Button>
            </div>
            {#if subjectProblem}
              <Field.FieldError>{subjectProblem}</Field.FieldError>
            {:else}
              <Field.FieldDescription>
                <code>rad self</code> prints a person's DID.
              </Field.FieldDescription>
            {/if}
          </Field.Field>
        </form>
      {/if}
    </SettingsSection>

    <Separator />

    <SettingsSection id="following" title={mine ? "Following" : "Following ryph"}>
      {#snippet description()}
        A Radicle node only fetches patches from delegates and from peers it follows.
      {/snippet}
      {#if !radicle}
        <p class="text-muted-foreground text-sm">
          {mine ? "This machine's Radicle node" : "Ryph's node"} couldn't be reached{data.radicleError ? ` (${data.radicleError})` : ""}.
        </p>
      {:else}
        <div class="flex items-center gap-2 text-sm">
          <span class="text-muted-foreground">{mine ? "Acting as" : "Ryph's identity"}</span>
          <span class="font-mono text-xs" title={radicle.did}>{shortenDid(radicle.did)}</span>
          {#if radicle.alias}
            <span class="text-muted-foreground">({radicle.alias})</span>
          {/if}
          <CopyButton
            value={radicle.did}
            label={mine ? "Copy the DID" : "Copy Ryph's DID"}
            what="DID copied"
          />
        </div>
        {#if radicle.isDelegate && mine}
          <p class="text-sm">
            {who} is a delegate here, so everyone who seeds this repository sees the patches Ryph
            opens as {who}.
          </p>
        {:else if radicle.isDelegate}
          <p class="text-sm">
            Ryph is a delegate here, so everyone who seeds this repository already sees its
            patches.
          </p>
        {:else}
          <Alert.Root>
            <TriangleAlertIcon />
            <Alert.Title>
              {mine
                ? `Maintainers won't see Ryph's patches until they follow ${who}`
                : "Maintainers won't see Ryph's patches until they follow it"}
            </Alert.Title>
            <Alert.Description class="flex flex-col gap-3">
              <span>Share one of these with everyone who works on this repository.</span>
              <div class="flex w-full flex-col gap-3">
                <CommandBlock
                  command={radicle.followCommands.inWorkingCopy}
                  caption="Inside a working copy"
                />
                <CommandBlock command={radicle.followCommands.anywhere} caption="Anywhere" />
              </div>
            </Alert.Description>
          </Alert.Root>
        {/if}
      {/if}
    </SettingsSection>
  {/if}

  {#if gitlab && data.gitlab?.mode === "bot" && canManageRepos}
    <Separator />

    <SettingsSection id="webhook" title="Webhook">
      {#snippet description()}
        GitLab tells Ryph about <code>/ryph</code> comments, merge requests and pushes through a
        webhook on the project, which a Maintainer adds there.
      {/snippet}
      {#if hook}
        <GitlabHookPanel status={hook} repoId={repo.id} webUrl={repoPage} />
      {:else}
        <Button variant="outline" class="w-fit" onclick={showHook} disabled={hookLoading}>
          {#if hookLoading}
            <Spinner data-icon="inline-start" />
          {:else}
            <EyeIcon data-icon="inline-start" />
          {/if}
          Show webhook settings
        </Button>
      {/if}
    </SettingsSection>
  {/if}

  <Separator />

  <SettingsSection id="connection" title="Connection">
    {#snippet description()}
      Connected {formatDateTime(repo.createdAt)}
      {#if github && repo.installationId}
        through GitHub App installation #{repo.installationId}.
      {:else if github && data.githubLogin}
        on GitHub. Ryph acts as @{data.githubLogin} there for everyone who uses it.
      {:else if github}
        on GitHub.
      {:else if gitlab && data.gitlab?.mode === "user"}
        on GitLab. Ryph acts as @{data.gitlab.login} there for everyone who uses it.
      {:else if gitlab && data.gitlab}
        on GitLab, through @{data.gitlab.login}.
      {:else if gitlab}
        on GitLab.
      {:else if local}
        from this machine.
      {:else}
        {#if mine && who}
          through this machine's Radicle node. Ryph acts as {who} there for everyone who uses it.
        {:else if mine}
          through this machine's Radicle node.
        {:else}
          through Ryph's Radicle node.
        {/if}
      {/if}
    {/snippet}
    <div class="flex flex-wrap gap-2">
      {#if github && repo.installationId}
        <!-- Resolved when clicked, so an account renamed since still lands on its own page. -->
        <Button
          variant="outline"
          href="/repos/{encodeURIComponent(repo.id)}/installation-settings"
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLinkIcon data-icon="inline-start" />
          Manage installation
        </Button>
      {/if}
      <Button variant="destructive" onclick={() => (disconnectOpen = true)}>
        <UnplugIcon data-icon="inline-start" />
        Disconnect
      </Button>
    </div>
  </SettingsSection>
</div>

<AlertDialog.Root bind:open={disconnectOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Disconnect {title}?</AlertDialog.Title>
      <AlertDialog.Description>
        New tasks can't target it, and its pending patches stop submitting. Nothing changes {github
          ? "on GitHub"
          : gitlab
          ? "on GitLab"
          : local
          ? "in the repository itself"
          : "on the Radicle network"}, and you can reconnect it at any time.
        {#if gitlab && data.gitlab?.mode === "bot"}
          If you won't, remove its webhook on GitLab too.
        {/if}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action disabled={disconnecting} onclick={disconnect}>
        {#if disconnecting}
          <Spinner data-icon="inline-start" />
        {/if}
        Disconnect
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
