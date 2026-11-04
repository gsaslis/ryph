<script lang="ts">
import type { RepoChecks } from "$lib/api/types";
import CheckStateIcon from "$lib/components/check-state-icon/check-state-icon.svelte";
import * as Alert from "$lib/components/ui/alert";
import { Button } from "$lib/components/ui/button";
import { Skeleton } from "$lib/components/ui/skeleton";
import * as Table from "$lib/components/ui/table";
import { checkStateLabel, timeoutLabel } from "$lib/utils/checks";
import { shortCommit } from "$lib/utils/environments";
import { formatDateTime, formatRelativeTime } from "$lib/utils/format";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

let {
  checks,
  connectedRepoId,
}: {
  /** Read off the forge, so streamed (`streamRepoChecks`, narrowed to this repository): null
   * while it is still being read. */
  checks: Promise<RepoChecks[] | null>;
  connectedRepoId: string;
} = $props();

// The last answer, held while the next one is read: the page re-reads on every change made on
// it, and a skeleton in place of the checks each time would flash. Kept per repository, so
// another repository's page never shows this one's.
type Shown =
  | { repoId: string; read: "ok"; repo: RepoChecks | null }
  | { repoId: string; read: "failed"; error: string };
let shown = $state<Shown | null>(null);
$effect(() => {
  const answer = checks;
  const repoId = connectedRepoId;
  let current = true;
  answer.then(
    (all) => {
      if (!current || all === null) return;
      shown = { repoId, read: "ok", repo: all.find((r) => r.connectedRepoId === repoId) ?? null };
    },
    (e: unknown) => {
      if (!current) return;
      shown = { repoId, read: "failed", error: e instanceof Error ? e.message : "" };
    },
  );
  return () => {
    current = false;
  };
});
const view = $derived(shown !== null && shown.repoId === connectedRepoId ? shown : null);
</script>

<!-- What the repository's checks file declares on its default branch, each check beside how it
     did in the newest full run there. -->
{#if view === null}
  <div class="flex flex-col gap-2">
  <Skeleton class="h-4 w-56" />
  <Skeleton class="h-24 w-full" />
</div>
{:else if view.read === "failed"}
  <p class="text-muted-foreground text-sm">
    Checks couldn't be read{view.error ? ` (${view.error})` : ""}.
  </p>
{:else if view.repo === null}
  <p class="text-muted-foreground text-sm">No checks for this repository.</p>
{:else}
  {@const repo = view.repo}
  {@const file = repo.file}
  <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
    <span class="text-muted-foreground">
      {#if (file.state === "declared" || file.state === "invalid") && file.path !== null && file.commit !== null}
        <code>{file.path}</code> on {repo.defaultBranch} at
        <span class="font-mono">{shortCommit(file.commit)}</span>
      {:else if file.state === "none"}
        No checks file on {repo.defaultBranch}
      {:else if file.state === "invalid"}
        The checks file on {repo.defaultBranch}
      {:else}
        The checks file couldn't be read
      {/if}
    </span>
    {#if repo.latest}
      <a
        href="/checks/{repo.latest.id}"
        class="flex items-center gap-1.5 hover:underline"
        title={formatDateTime(repo.latest.createdAt)}
      >
        <CheckStateIcon state={repo.latest.state} class="size-3.5" />
        {checkStateLabel(repo.latest.state)}
        <span class="text-muted-foreground">{formatRelativeTime(repo.latest.createdAt)}</span>
      </a>
    {/if}
  </div>

  {#if file.state === "declared"}
    {@const services = [...new Set(file.checks.flatMap((c) => c.services))]}
    {#if file.warning}
      <p class="text-destructive text-sm">{file.warning}</p>
    {/if}
    <Table.Root class="table-fixed">
  <colgroup>
    <col class="w-[30%]" />
    <col />
    <col class="w-20" />
  </colgroup>
  <Table.Header>
    <Table.Row class="hover:bg-transparent">
      <Table.Head class="pl-3">Check</Table.Head>
      <Table.Head>Runs</Table.Head>
      <Table.Head class="pr-3 text-right">Timeout</Table.Head>
    </Table.Row>
  </Table.Header>
  <Table.Body>
        {#each file.checks as check (check.name)}
          {@const result = repo.latest?.checks.find((c) => c.name === check.name)}
          <Table.Row>
            <Table.Cell class="pl-3">
              <span class="flex min-w-0 items-center gap-2">
                {#if result}
                  <span title={checkStateLabel(result.state)}>
                    <CheckStateIcon state={result.state} class="size-3.5" />
                  </span>
                {:else}
                  <CheckStateIcon state="queued" class="size-3.5 opacity-40" />
                {/if}
                <span class="truncate font-mono text-xs font-medium">{check.name}</span>
              </span>
            </Table.Cell>
            <Table.Cell>
              <code class="text-muted-foreground block truncate text-xs" title={check.run}>
                {check.run}
              </code>
            </Table.Cell>
            <Table.Cell class="text-muted-foreground pr-3 text-right text-xs tabular-nums">
              {timeoutLabel(check.timeoutSeconds)}
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
</Table.Root>
    {#if file.setup.length > 0 || services.length > 0}
      <dl
  class="text-muted-foreground grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
        {#if file.setup.length > 0}
          <dt>Setup</dt>
          <dd class="flex min-w-0 flex-col">
            {#each file.setup as step, i (i)}
              <code class="truncate" title={step}>{step}</code>
            {/each}
          </dd>
        {/if}
        {#if services.length > 0}
          <dt>Services</dt>
          <dd class="font-mono">{services.join(", ")}</dd>
        {/if}
      </dl>
    {/if}
  {:else if file.state === "invalid"}
    <Alert.Root variant="destructive">
  <TriangleAlertIcon />
  <Alert.Title>The checks file has an error</Alert.Title>
  <Alert.Description class="font-mono text-xs">{file.error}</Alert.Description>
</Alert.Root>
  {:else if file.state === "unread"}
    <p class="text-muted-foreground text-sm">{file.error}</p>
  {/if}

  <div>
  <Button variant="outline" size="sm" href="/checks?repo={connectedRepoId}">
      See all runs
    </Button>
</div>
{/if}
