<script lang="ts">
import { ApiError } from "$lib/api/call";
import { connectRadicleRepo } from "$lib/api/repos";
import type { ConnectedRepo, RadicleRepoInfo, SubmissionPolicy } from "$lib/api/types";
import CommandBlock from "$lib/components/command-block/command-block.svelte";
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import RadicleRepoDetails from "$lib/components/radicle-repo-details/radicle-repo-details.svelte";
import * as Alert from "$lib/components/ui/alert";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import { Spinner } from "$lib/components/ui/spinner";
import { isRid, shortenDid } from "$lib/utils/forge";
import { withBackTo } from "$lib/utils/safe-path";
import LinkIcon from "@lucide/svelte/icons/link-2";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import { toast } from "svelte-sonner";
import UnavailableStep from "../unavailable-step.svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// Where leaving the flow goes: the page that opened it, else the repositories.
const exitHref = $derived(data.backTo ?? "/repos");
const backHref = $derived(data.multiForge ? withBackTo("/repos/connect", data.backTo) : exitHref);

const policyLabels: Record<SubmissionPolicy, string> = {
  "require-approval": "Require approval",
  auto: "Auto-submit agent submissions",
};

let repoRef = $state("");
let submissionPolicy: SubmissionPolicy = $state("require-approval");
let connecting = $state(false);

/** What came back: the row, and what Ryph's node then knew about the repository. */
let connected = $state<{ repo: ConnectedRepo; radicle: RadicleRepoInfo } | null>(null);

/**
 * A refusal worth a screen rather than a toast: Ryph's node asked the network for the
 * repository and got nothing back, which one of its delegates fixes with one command.
 *
 * It covers two situations Radicle cannot tell apart from our side — a private repository whose
 * allow list Ryph is not on (the fetch is refused at the other node and never explained, and
 * the repository is never gossiped) and an id no peer is offering. The platform's `detail` says
 * which reading its evidence supports, so it is shown verbatim.
 */
let notAllowed = $state<{ did: string; command: string; detail: string | null } | null>(null);

/**
 * The other refusal worth a screen: "not_delegate". It covers two different situations — the
 * caller HAS a linked Radicle identity and it is not a delegate of this repository, or they have
 * none at all and there was no DID to check in the first place. The platform's `detail` is what
 * tells them apart, so it is shown verbatim, and the way out of the second is a link.
 *
 * Neither is the whole story any more: a Ryph admin connects a repository whoever delegates it,
 * because what connecting decides is how THIS deployment spends its own node and budget, not
 * anything Radicle has an opinion about. So this screen is what a non-admin sees, and the way
 * out of it can also be asking one.
 */
let notDelegate = $state<{ detail: string | null } | null>(null);

/** Whether Ryph's node is up. Null when the platform did not say, which is not a claim. */
const nodeDown = $derived(data.identity?.node?.running === false);

const ridProblem = $derived(
  repoRef.trim() === "" || isRid(repoRef)
    ? null
    : "That is not a repository id — it starts with rad:z, and `rad .` prints it inside a working copy.",
);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (!isRid(repoRef)) {
    toast.error("Paste the repository id — it starts with rad:z");
    return;
  }
  connecting = true;
  notAllowed = null;
  notDelegate = null;
  try {
    connected = await connectRadicleRepo(fetch, {
      repoRef: repoRef.trim(),
      submissionPolicy,
    });
  } catch (e) {
    handleFailure(e);
  } finally {
    connecting = false;
  }
}

/** The connect refusals each say something a person can act on, so none of them is "failed". */
function handleFailure(e: unknown) {
  if (!(e instanceof ApiError)) {
    toast.error(e instanceof Error ? e.message : "Failed to connect the repository");
    return;
  }
  const body = e.body as Record<string, unknown> | null;
  const code = body && typeof body.error === "string" ? body.error : null;
  if (
    code === "not_allowed" && typeof body?.did === "string" && typeof body?.command === "string"
  ) {
    notAllowed = {
      did: body.did,
      command: body.command,
      detail: typeof body.detail === "string" ? body.detail : null,
    };
    return;
  }
  switch (code) {
    case "not_delegate":
      notDelegate = { detail: typeof body?.detail === "string" ? body.detail : null };
      return;
    case "radicle_unreachable":
      toast.error(
        data.mine
          ? "This machine's Radicle node did not answer. Try again in a moment."
          : "ryph's Radicle node did not answer. Try again in a moment.",
      );
      return;
    default:
      toast.error(e.message);
  }
}
</script>

<svelte:head>
  <title>Connect a Radicle repository · Ryph</title>
</svelte:head>

{#if data.unavailable}
  <UnavailableStep headline="Connect a Radicle repository" {exitHref} />
{:else if connected}
  <!-- The success screen exists for one sentence: unless the people who work on this repository
       follow Ryph (in user mode, the identity it acts as), they will never see a patch it opens. -->
  <FlowStep
  headline="Connected {connected.radicle.name}"
  description={data.mine
    ? "This machine's Radicle node now seeds this repository."
    : "ryph's node now seeds this repository. One thing left, and it is not optional."}
>
    <RadicleRepoDetails repoRef={connected.repo.repoRef} info={connected.radicle} mine={data.mine} />

    {#snippet leftActions()}
      <!-- With Radicle the only forge, /repos/connect redirects back to this same page, which
           keeps its state — so start the form over here instead. -->
      {#if data.multiForge}
        <Button variant="ghost" href={withBackTo("/repos/connect", data.backTo)}>Connect another</Button>
      {:else}
        <Button
          variant="ghost"
          onclick={() => {
            connected = null;
            repoRef = "";
          }}
        >
          Connect another
        </Button>
      {/if}
    {/snippet}
    {#snippet actions()}
      <Button href={exitHref}>Done</Button>
    {/snippet}
  </FlowStep>
{:else if notDelegate}
  <FlowStep
  headline="ryph cannot connect this repository as you"
  description="Connecting a repository spends this deployment's resources on it, so it is a delegate's to do — or a Ryph admin's."
>
    <div class="flex flex-col gap-4 text-sm">
      {#if notDelegate.detail}
        <p>{notDelegate.detail}</p>
      {/if}
      <p class="text-muted-foreground">
        Two things can be behind this: the identity Ryph knows you by is not a delegate of this
        repository, or you have not linked a Radicle identity at all — and then there was no DID
        to check. Linking one is a card in your settings, and it takes one signature. A Ryph admin
        can connect any repository the node can fetch, whoever delegates it.
      </p>
    </div>

    {#snippet leftActions()}
      <Button
        variant="ghost"
        onclick={() => {
          notDelegate = null;
        }}
      >
        Back
      </Button>
    {/snippet}
    {#snippet actions()}
      <Button href="/account">
        <LinkIcon data-icon="inline-start" />
        Radicle identity settings
      </Button>
    {/snippet}
  </FlowStep>
{:else if notAllowed}
  <FlowStep
  headline={data.mine
    ? "This machine's node could not fetch this repository"
    : "ryph could not fetch this repository"}
  description={data.mine
    ? "It may be private and this machine's identity is not on its allow list, or no peer is offering it."
    : "Radicle keeps a private repository to an allow list; one Ryph is not on the list of looks exactly like one nobody is offering, and so does a node with nobody to ask."}
>
    <div class="flex flex-col gap-4 text-sm">
      {#if notAllowed.detail}
        <p>{notAllowed.detail}</p>
      {/if}
      <p>
        {#if data.mine}
          If it is private, a delegate has to add this machine's identity to it with this command.
          It names the DID
        {:else}
          If it is private, a delegate of the repository has to add Ryph's identity to it. Send them
          this command — it names Ryph's DID,
        {/if}
        <span class="font-mono text-xs" title={notAllowed.did}>{shortenDid(notAllowed.did)}</span>.
      </p>
      <CommandBlock
        command={notAllowed.command}
        caption="Run by a delegate, inside a working copy of the repository"
      />
      <p class="text-muted-foreground">
        {#if data.mine}
          If it is public, check the id, and that a node holding it is online. Then connect it again.
        {:else}
          If it is public, check the id instead: a repository reaches Ryph only once a node that
          holds it is connected to the network. Either way, connect it again afterwards — nothing
          here was saved.
        {/if}
      </p>
    </div>

    {#snippet leftActions()}
      <Button
        variant="ghost"
        onclick={() => {
          notAllowed = null;
        }}
      >
        Back
      </Button>
    {/snippet}
  </FlowStep>
{:else}
  <form onsubmit={submit}>
  <FlowStep
    headline="Connect a Radicle repository"
    description="Radicle addresses a repository by its id — there is no owner and no name in it, so paste the id itself."
  >
      <Field.FieldGroup>
        <Field.Field>
          <Field.FieldLabel for="radicle-rid">Repository id</Field.FieldLabel>
          <Input
            id="radicle-rid"
            bind:value={repoRef}
            placeholder="rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5"
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            aria-invalid={ridProblem !== null}
          />
          {#if ridProblem}
            <Field.FieldError>{ridProblem}</Field.FieldError>
          {:else}
            <Field.FieldDescription>
              Run <code>rad .</code> inside a working copy, or copy it from the repository's page
              on a Radicle explorer.{data.mine
                ? " Only an admin can connect a repository here."
                : " A delegate of the repository can connect it, as can a Ryph admin."}
            </Field.FieldDescription>
          {/if}
        </Field.Field>

        <Field.Field>
          <Field.FieldLabel for="submission-policy">Submission policy</Field.FieldLabel>
          <Select.Root type="single" bind:value={submissionPolicy}>
            <Select.Trigger id="submission-policy" class="w-full">
              {policyLabels[submissionPolicy]}
            </Select.Trigger>
            <Select.Content>
              <Select.Group>
                <Select.Item value="require-approval" label="Require approval" />
                <Select.Item value="auto" label="Auto-submit agent submissions" />
              </Select.Group>
            </Select.Content>
          </Select.Root>
          <Field.FieldDescription>
            "Require approval" holds every patch for human review before it is pushed to the
            repository. "Auto-submit agent submissions" pushes one only when the agent explicitly
            submits its work. Leftover work captured when a run ends always waits for human approval.
          </Field.FieldDescription>
        </Field.Field>
      </Field.FieldGroup>

      {#if nodeDown && data.mine}
        <Alert.Root variant="destructive" class="mt-6">
          <TriangleAlertIcon />
          <Alert.Title>This machine's Radicle node is not running</Alert.Title>
          <Alert.Description>
            Start it with <code>rad node start</code>, then connect.
          </Alert.Description>
        </Alert.Root>
      {:else if nodeDown}
        <Alert.Root variant="destructive" class="mt-6">
          <TriangleAlertIcon />
          <Alert.Title>Ryph's Radicle node is not running</Alert.Title>
          <Alert.Description>
            Its identity is readable, but the node itself is down — it is not talking to any peer,
            so it cannot seed this repository or fetch it. Connecting will fail until it is back.
          </Alert.Description>
        </Alert.Root>
      {/if}

      <!-- With the person's own node, Ryph's patches are signed as them, so there is no
           separate identity to follow; the next screen says per repository who sees them. -->
      {#if !data.identity && data.mine}
        <Alert.Root variant="destructive" class="mt-6">
          <TriangleAlertIcon />
          <Alert.Title>No Radicle identity on this machine</Alert.Title>
          <Alert.Description>
            Create one with <code>rad auth</code> and start the node with <code>rad node start</code>,
            then come back.
          </Alert.Description>
        </Alert.Root>
      {:else if !data.identity}
        <Alert.Root variant="destructive" class="mt-6">
          <TriangleAlertIcon />
          <Alert.Title>This deployment has no Radicle node</Alert.Title>
          <Alert.Description>
            Its identity could not be read, so connecting will not work. Set the platform's
            Radicle service up first.
          </Alert.Description>
        </Alert.Root>
      {:else if !data.mine}
        <Alert.Root class="mt-6">
          <TriangleAlertIcon />
          <Alert.Title>Maintainers will have to follow Ryph</Alert.Title>
          <Alert.Description>
            A Radicle node only fetches the work of a repository's delegates and of the peers it
            follows, so Ryph's patches stay invisible on a maintainer's machine until they follow
            Ryph's node{data.identity.alias ? ` ("${data.identity.alias}")` : ""}. This is the line
            to send them; the next screen repeats it beside the repository it is for.
            <div class="mt-3">
              <CommandBlock
                command={data.identity.followCommand ?? data.identity.followCommands.inWorkingCopy}
                caption="Run by a maintainer, inside a working copy of the repository"
              />
            </div>
          </Alert.Description>
        </Alert.Root>
      {/if}

      {#snippet leftActions()}
        <Button variant="ghost" href={backHref}>
          {data.multiForge ? "Back" : "Cancel"}
        </Button>
      {/snippet}

      {#snippet actions()}
        <Button type="submit" disabled={connecting || data.identity === null}>
          {#if connecting}
            <Spinner data-icon="inline-start" />
          {:else}
            <LinkIcon data-icon="inline-start" />
          {/if}
          Connect
        </Button>
      {/snippet}
    </FlowStep>
</form>
{/if}
