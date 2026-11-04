<script lang="ts">
import { invalidate } from "$app/navigation";
import { ApiError } from "$lib/api/call";
import { linkIdentityByProof, mintIdentityChallenge, unlinkIdentity } from "$lib/api/identities";
import type { Identity, IdentityChallenge } from "$lib/api/types";
import CommandBlock from "$lib/components/command-block/command-block.svelte";
import CopyButton from "$lib/components/copy-button/copy-button.svelte";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Spinner } from "$lib/components/ui/spinner";
import { Textarea } from "$lib/components/ui/textarea";
import { formatDateTime } from "$lib/utils/format";
import { isDid, shortenDid } from "$lib/utils/forge";
import Link2Icon from "@lucide/svelte/icons/link-2";
import Unlink2Icon from "@lucide/svelte/icons/unlink-2";
import { toast } from "svelte-sonner";

let { identity }: { identity: Identity | null } = $props();

// Radicle has no OAuth to borrow, so the proof is the one thing the network itself trusts: a
// signature by the key the identity names. The challenge is short-lived, and the whole exchange
// happens in this card.
let challenge = $state<IdentityChallenge | null>(null);
let starting = $state(false);
let did = $state("");
let signature = $state("");
let linking = $state(false);
let unlinking = $state(false);

const didProblem = $derived(
  did.trim() === "" || isDid(did) ? null : "That isn't a DID. It starts with did:key:z.",
);

async function start() {
  starting = true;
  try {
    challenge = await mintIdentityChallenge(fetch, "radicle");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Couldn't start linking");
  } finally {
    starting = false;
  }
}

async function link(event: SubmitEvent) {
  event.preventDefault();
  if (!isDid(did)) {
    toast.error("Paste your DID. It starts with did:key:z.");
    return;
  }
  if (signature.trim() === "") {
    toast.error("Paste the signature the command printed");
    return;
  }
  linking = true;
  try {
    // No nonce goes up: the platform tries every outstanding challenge of this user and spends
    // the one the signature verifies against, which is the only thing a signature can prove.
    await linkIdentityByProof(fetch, "radicle", {
      subject: did.trim(),
      signature: signature.trim(),
    });
    challenge = null;
    did = "";
    signature = "";
    toast.success("Radicle identity linked");
    await invalidate("app:settings");
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) {
      toast.error("The signature did not verify against that identity.");
    } else if (e instanceof ApiError && e.status === 409) {
      toast.error("That identity is already linked to another Ryph account.");
    } else {
      toast.error(e instanceof Error ? e.message : "Could not link the identity");
    }
  } finally {
    linking = false;
  }
}

async function unlink() {
  unlinking = true;
  try {
    await unlinkIdentity(fetch, "radicle");
    toast.success("Radicle identity unlinked");
    await invalidate("app:settings");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Could not unlink the identity");
  } finally {
    unlinking = false;
  }
}
</script>

<!-- One row of the linked-accounts list, like GitHub's. Only linking differs: Radicle has no
     accounts to sign in to, so you prove you hold your key by signing a one-time code, in a
     dialog opened from here. -->
<li class="flex flex-wrap items-center gap-3 px-3 py-2.5">
  <ForgeIcon provider="radicle" class="size-5" />
  <div class="flex min-w-0 flex-1 flex-col">
    <span class="text-sm font-medium">Radicle</span>
    {#if identity}
      <span class="text-muted-foreground flex h-4 min-w-0 items-center gap-1 text-xs">
        <span class="truncate font-mono" title={identity.login}>{shortenDid(identity.login)}</span>
        <!-- A line-height box the button overflows, so the row keeps the height of GitHub's. -->
        <span class="inline-flex h-4 items-center">
          <CopyButton value={identity.login} label="Copy your DID" what="DID copied" />
        </span>
        <span>linked {formatDateTime(identity.linkedAt)}</span>
      </span>
    {:else}
      <span class="text-muted-foreground text-xs">Not linked</span>
    {/if}
  </div>
  {#if identity}
    <Button variant="ghost" size="sm" disabled={unlinking} onclick={unlink}>
      {#if unlinking}
        <Spinner data-icon="inline-start" />
      {:else}
        <Unlink2Icon data-icon="inline-start" />
      {/if}
      Unlink
    </Button>
  {:else}
    <Button variant="outline" size="sm" disabled={starting} onclick={start}>
      {#if starting}
        <Spinner data-icon="inline-start" />
      {:else}
        <Link2Icon data-icon="inline-start" />
      {/if}
      Link
    </Button>
  {/if}
</li>

<Dialog.Root
  open={challenge !== null}
  onOpenChange={(open) => {
    if (!open) challenge = null;
  }}
>
  <Dialog.Content class="sm:max-w-xl">
    <form class="flex flex-col gap-4" onsubmit={link}>
      <Dialog.Header>
        <Dialog.Title>Link your Radicle identity</Dialog.Title>
        <Dialog.Description>
          Radicle has no accounts, so you prove the key is yours by signing a one-time code. Ryph
          then knows which patches and comments are yours.
        </Dialog.Description>
      </Dialog.Header>
      {#if challenge}
        <CommandBlock command={challenge.command} caption="Run this, then paste what it prints" />
        <p class="text-muted-foreground -mt-2 text-xs">
          The code works until {formatDateTime(challenge.expiresAt)}.
        </p>
      {/if}
      <Field.FieldGroup>
        <Field.Field>
          <Field.FieldLabel for="radicle-did">Your DID</Field.FieldLabel>
          <Input
            id="radicle-did"
            bind:value={did}
            placeholder="did:key:z6Mk…"
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            aria-invalid={didProblem !== null}
          />
          {#if didProblem}
            <Field.FieldError>{didProblem}</Field.FieldError>
          {:else}
            <Field.FieldDescription><code>rad self</code> shows it as "DID".</Field.FieldDescription>
          {/if}
        </Field.Field>
        <Field.Field>
          <Field.FieldLabel for="radicle-signature">Signature</Field.FieldLabel>
          <Textarea
            id="radicle-signature"
            bind:value={signature}
            rows={6}
            spellcheck={false}
            class="font-mono text-xs"
            placeholder={"-----BEGIN SSH SIGNATURE-----\n…\n-----END SSH SIGNATURE-----"}
          />
          <Field.FieldDescription>
            Include the <code>BEGIN</code> and <code>END</code> lines.
          </Field.FieldDescription>
        </Field.Field>
      </Field.FieldGroup>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (challenge = null)}>Cancel</Button>
        <Button type="submit" disabled={linking}>
          {#if linking}
            <Spinner data-icon="inline-start" />
          {:else}
            <Link2Icon data-icon="inline-start" />
          {/if}
          Link
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
