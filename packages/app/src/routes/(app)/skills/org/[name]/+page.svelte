<script lang="ts">
import { page } from "$app/state";
import SkillFacts, { type ExtraFact } from "$lib/components/skill-facts/skill-facts.svelte";
import SkillFiles from "$lib/components/skill-files/skill-files.svelte";
import SkillExamplePrompt from "$lib/components/skill-header/skill-example-prompt.svelte";
import SkillHeader from "$lib/components/skill-header/skill-header.svelte";
import * as Alert from "$lib/components/ui/alert";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { shortCommit } from "$lib/utils/environments";
import { formatDateTime } from "$lib/utils/format";
import { presentationFacts, skillTitle } from "$lib/utils/skill-presentation";
import { commitUrl, shortDigest, skillDirUrl } from "$lib/utils/skills";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const skill = $derived(data.skill);
const repo = $derived(data.org?.repo ?? null);
// The version on screen: the current one, unless the address asks for an older one.
const older = $derived(data.shownVersion);
const shownDigest = $derived(older?.digest ?? skill.digest);
// An archived repo's skills are kept for reading, but runs get none of them.
const archived = $derived(data.org?.archived ?? false);
// The folder as the version on screen has it: an older one at the commit it was last seen in,
// since the branch may hold other files by now or no such folder at all. An older version whose
// commit is not known has no link.
const dirRef = $derived(older === null ? data.org?.effectiveBranch : older.lastSync.commit);
const dirUrl = $derived(repo && dirRef ? skillDirUrl(repo, dirRef, skill.name) : null);

/** A commit as a fact: linked to the forge where it has a page. */
function commitFact(term: string, commit: string | null): ExtraFact[] {
  if (commit === null) return [];
  return [{
    term,
    value: shortCommit(commit),
    href: repo ? commitUrl(repo, commit) : null,
    mono: true,
  }];
}

// The presentation is the current version's, as the other details are: an older one shows its
// own name and description, and none of the current one's display name, icon or extras.
const presentation = $derived(older === null ? skill.presentation : null);
const title = $derived(skillTitle({ ...skill, presentation }));
const facts = $derived<ExtraFact[]>(
  older === null
    ? [...commitFact("Synced from", data.org?.current?.commit ?? null), ...presentationFacts(skill)]
    : commitFact("Last seen in", older.lastSync.commit),
);

/** Where one version was first and last seen, in a few words. */
function seen(at: string, commit: string | null): string {
  return commit === null ? formatDateTime(at) : `${formatDateTime(at)} in ${shortCommit(commit)}`;
}
</script>

<svelte:head>
  <title>{title} · Skills · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-8">
  <SkillHeader
    name={skill.name}
    description={skill.description}
    {presentation}
    summary={older?.description}
  >
    {#snippet tags()}
      <Badge variant="secondary">Org</Badge>
    {/snippet}
    {#snippet actions()}
      {#if dirUrl}
        <Button variant="outline" href={dirUrl} target="_blank" rel="noreferrer noopener">
          <ExternalLinkIcon data-icon="inline-start" />
          Open in the repository
        </Button>
      {/if}
    {/snippet}
  </SkillHeader>

  {#if archived}
    <Alert.Root variant="destructive">
      <TriangleAlertIcon />
      <Alert.Title>Agents don't get this skill</Alert.Title>
      <Alert.Description>
        <p>The org skills repository was disconnected on the Repositories page.</p>
      </Alert.Description>
    </Alert.Root>
  {/if}
  {#if older}
    <Alert.Root>
      <Alert.Title>An older version</Alert.Title>
      <Alert.Description>
        <p>
          {#if archived}
            The last synced version is {shortDigest(skill.digest)}.
          {:else if older.digest === skill.digest}
            Its files are the same as the current version's.
          {:else}
            Agents get version {shortDigest(skill.digest)} now.
          {/if}
          <a href={page.url.pathname}>Show the current version</a>. License and the other details
          are shown for the current version only.
        </p>
      </Alert.Description>
    </Alert.Root>
  {:else if skill.warnings.length > 0}
    <Alert.Root variant="destructive">
      <TriangleAlertIcon />
      <Alert.Title>
        {skill.warnings.length} warning{skill.warnings.length === 1 ? "" : "s"}
      </Alert.Title>
      <Alert.Description>
        <ul class="flex flex-col gap-1">
          {#each skill.warnings as warning, i (i)}
            <li><span class="font-mono text-xs">{warning.path}</span>: {warning.message}</li>
          {/each}
        </ul>
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if presentation?.defaultPrompt}
    <SkillExamplePrompt prompt={presentation.defaultPrompt} />
  {/if}

  <SkillFacts
    digest={shownDigest}
    bytes={data.shownBytes}
    frontmatter={older === null ? skill.frontmatter : {}}
    extra={facts}
  />

  <section class="flex flex-col gap-3" aria-labelledby="files-title">
    <h2 id="files-title" class="text-sm font-semibold">Files</h2>
    <SkillFiles files={data.shownFiles} />
  </section>

  {#if data.versions.length > 0}
    <section class="flex flex-col gap-3" aria-labelledby="versions-title">
      <div class="flex flex-col gap-1">
        <h2 id="versions-title" class="text-sm font-semibold">Versions</h2>
        <p class="text-muted-foreground text-sm">
          Every change to this skill's files on {data.org?.effectiveBranch ?? "its branch"}, newest
          first.
        </p>
      </div>
      <ol class="divide-y rounded-lg border">
        {#each data.versions as version (version.firstSync.id)}
          {@const isCurrent = version === data.versions[0] && version.digest === skill.digest}
          {@const isShown = older === null ? isCurrent : version.firstSync.id === older.firstSync.id}
          <li class={["flex flex-col gap-1 px-4 py-3", isShown && "bg-muted/40"]}>
            <div class="flex flex-wrap items-center gap-2">
              <a
                href={isCurrent
                  ? page.url.pathname
                  : `${page.url.pathname}?version=${encodeURIComponent(version.firstSync.id)}`}
                aria-current={isShown ? "page" : undefined}
                class="font-mono text-sm font-medium underline-offset-4 hover:underline"
                title={version.digest}
              >
                {shortDigest(version.digest)}
              </a>
              {#if isCurrent}
                <Badge variant="secondary">Current</Badge>
              {/if}
            </div>
            <p class="text-muted-foreground text-xs">
              {#if version.firstSync.id === version.lastSync.id}
                Seen {seen(version.firstSync.at, version.firstSync.commit)}
              {:else}
                First seen {seen(version.firstSync.at, version.firstSync.commit)}, last seen
                {seen(version.lastSync.at, version.lastSync.commit)}
              {/if}
            </p>
            {#if version.description !== skill.description}
              <p class="text-muted-foreground line-clamp-2 text-xs" title={version.description}>
                {version.description}
              </p>
            {/if}
          </li>
        {/each}
      </ol>
    </section>
  {/if}
</div>
