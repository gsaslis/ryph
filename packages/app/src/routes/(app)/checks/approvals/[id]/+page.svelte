<script lang="ts">
import { invalidateAll } from "$app/navigation";
import { approveCheckRun } from "$lib/api/checks";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import * as Alert from "$lib/components/ui/alert";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Card from "$lib/components/ui/card";
import { Spinner } from "$lib/components/ui/spinner";
import { can } from "$lib/utils/auth/capabilities";
import { approvalReturnTo, approvalStateLabel } from "$lib/utils/check-approval";
import { shortCommit } from "$lib/utils/environments";
import { forgeRepoLabel, repoThreadLabel, subjectLabel } from "$lib/utils/forge";
import { formatDateTime } from "$lib/utils/format";
import { providerLabel } from "$lib/utils/providers";
import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import PlayIcon from "@lucide/svelte/icons/play";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const approval = $derived(data.approval);
const provider = $derived(approval.repo.provider);
const threadName = $derived(
  repoThreadLabel(approval.repo, "change_request", approval.changeRequest),
);
const mayApprove = $derived(can(data.user, "patches:review"));
const forgeName = $derived(providerLabel(provider));
// Who may start checks, in each forge's own terms: GitLab's is a role, Developer or above.
const who = $derived(
  provider === "radicle"
    ? "a delegate of"
    : provider === "gitlab"
    ? "Developer access to"
    : "write access to",
);

let approving = $state(false);
let failure = $state<string | null>(null);

async function approve() {
  approving = true;
  failure = null;
  try {
    const { returnTo } = await approveCheckRun(fetch, approval.id);
    // Back to the change request the comment was on, where the checks now show.
    const back = approvalReturnTo(returnTo);
    if (back !== null) {
      window.location.assign(back);
      return;
    }
    await invalidateAll();
  } catch (e) {
    failure = e instanceof Error ? e.message : "The checks could not be approved";
    // The approval may have moved on meanwhile (a newer push, the change request closed).
    await invalidateAll();
  } finally {
    approving = false;
  }
}
</script>

<svelte:head>
  <title>Approve checks · {threadName} · Ryph</title>
</svelte:head>

<div class="flex max-w-2xl flex-col gap-6">
  <PageTitle title="Approve checks">
    {#snippet description()}
      An outside contribution to {forgeRepoLabel(approval.repo)}. Its checks run only once someone
      with {who} the repository approves them.
    {/snippet}
  </PageTitle>

  <Card.Root>
    <Card.Header>
      <Card.Title class="flex flex-wrap items-center gap-2">
        {threadName}
        <Badge variant={approval.state === "approved" ? "default" : "outline"}>
          {approvalStateLabel(approval)}
        </Badge>
      </Card.Title>
      <Card.Description>
        Opened by {subjectLabel(provider, approval.author)}, who can't start checks on this
        repository.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
        <dt class="text-muted-foreground">Commit</dt>
        <dd class="font-mono" title={approval.headSha}>{shortCommit(approval.headSha)}</dd>
        <dt class="text-muted-foreground">Asked</dt>
        <dd>{formatDateTime(approval.createdAt)}</dd>
        {#if approval.state === "approved"}
          <dt class="text-muted-foreground">Approved by</dt>
          <dd>
            {approval.approvedByLogin === null
            ? "a ryph administrator"
            : subjectLabel(provider, approval.approvedByLogin)}
            {#if approval.approvedAt}
              <span class="text-muted-foreground">· {formatDateTime(approval.approvedAt)}</span>
            {/if}
          </dd>
        {/if}
      </dl>
    </Card.Content>
    <Card.Footer class="flex flex-wrap gap-2">
      {#if approval.state === "pending" && mayApprove}
        <Button disabled={approving} onclick={approve}>
          {#if approving}
            <Spinner data-icon="inline-start" />
          {:else}
            <PlayIcon data-icon="inline-start" />
          {/if}
          Approve and run checks
        </Button>
      {/if}
      {#if approval.url}
        <Button variant="outline" href={approval.url} target="_blank" rel="noreferrer">
          <ExternalLinkIcon data-icon="inline-start" />
          Open on {forgeName}
        </Button>
      {/if}
    </Card.Footer>
  </Card.Root>

  {#if failure !== null}
    <Alert.Root variant="destructive">
      <TriangleAlertIcon />
      <Alert.Title>Not approved</Alert.Title>
      <Alert.Description>{failure}</Alert.Description>
    </Alert.Root>
  {/if}

  {#if approval.state === "pending"}
    <p class="text-muted-foreground text-sm">
      Read the change before approving: its checks run its code on this deployment, once, for
      commit <span class="font-mono">{shortCommit(approval.headSha)}</span>. A new push needs
      approving again.
      {#if !mayApprove}
        Approving takes patch review, which your role does not have.
      {/if}
    </p>
  {:else if approval.state === "approved"}
    <p class="text-muted-foreground flex items-center gap-2 text-sm">
      <CircleCheckIcon class="size-4" />
      The checks are running, and report their results on the change request.
    </p>
  {:else if approval.state === "superseded"}
    <p class="text-muted-foreground text-sm">
      The change request has a newer commit since. Approve that one from the comment on the change
      request.
    </p>
  {:else}
    <p class="text-muted-foreground text-sm">
      The change request was merged or closed before anyone approved its checks.
    </p>
  {/if}
</div>
