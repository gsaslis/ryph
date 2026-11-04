<script lang="ts">
import { type Role, ROLES } from "$lib/utils/auth/capabilities";
import { invalidate } from "$app/navigation";
import { page } from "$app/state";
import { createInvite, revokeInvite } from "$lib/api/admin";
import type { Invite } from "$lib/api/types";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import * as Empty from "$lib/components/ui/empty";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";
import { Spinner } from "$lib/components/ui/spinner";
import * as Table from "$lib/components/ui/table";
import { formatDateTime } from "$lib/utils/format";
import CopyIcon from "@lucide/svelte/icons/copy";
import MailPlusIcon from "@lucide/svelte/icons/mail-plus";
import PlusIcon from "@lucide/svelte/icons/plus";
import { toast } from "svelte-sonner";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

let createOpen = $state(false);
let email = $state("");
let role = $state<Role>("member");
let expiresInDays = $state(7);
let maxUses = $state<number | null>(null);
let creating = $state(false);
// The link exists only here, once: the control plane keeps a digest, never the token.
let mintedLink = $state<string | null>(null);

async function submitCreate(event: SubmitEvent) {
  event.preventDefault();
  creating = true;
  try {
    const uses = maxUses === null || Number.isNaN(maxUses) || maxUses < 1 ? null : maxUses;
    const { token } = await createInvite(fetch, {
      email: email.trim() === "" ? null : email.trim(),
      role,
      expiresInDays,
      maxUses: uses !== null && Number.isInteger(uses) && uses > 0 ? uses : null,
    });
    mintedLink = `${page.url.origin}/invite/${token}`;
    email = "";
    role = "member";
    expiresInDays = 7;
    maxUses = null;
    await invalidate("app:admin-invites");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to create invite");
  } finally {
    creating = false;
  }
}

async function copyLink() {
  if (!mintedLink) return;
  try {
    await navigator.clipboard.writeText(mintedLink);
    toast.success("Invite link copied");
  } catch {
    toast.error("Could not copy — select the link and copy it by hand");
  }
}

let revoking = $state<string | null>(null);

async function revoke(invite: Invite) {
  revoking = invite.id;
  try {
    await revokeInvite(fetch, invite.id);
    toast.success("Invite revoked");
    await invalidate("app:admin-invites");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to revoke invite");
  } finally {
    revoking = null;
  }
}

function status(
  invite: Invite,
): { label: string; variant: "secondary" | "outline" | "destructive" } {
  if (invite.revokedAt !== null) return { label: "revoked", variant: "destructive" };
  if (Date.parse(invite.expiresAt) <= Date.now()) return { label: "expired", variant: "outline" };
  if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
    return { label: "used", variant: "outline" };
  }
  return { label: "active", variant: "secondary" };
}
</script>

<div class="flex flex-col gap-6">
  <div class="flex items-center justify-between gap-4">
    <div class="flex flex-col gap-1">
      <h2 class="text-base font-medium">Invites</h2>
      <p class="text-muted-foreground text-sm">
      Links to create an account. A link for an address works once; an open link works for anyone who has it.
    </p>
    </div>
    <Button
      disabled={!data.multiUser}
      onclick={() => {
        mintedLink = null;
        createOpen = true;
      }}
    >
      <PlusIcon data-icon="inline-start" />
      Invite someone
    </Button>
  </div>

  {#if data.invites.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <MailPlusIcon />
        </Empty.Media>
        <Empty.Title>No invites yet</Empty.Title>
        <Empty.Description>Mint a link to bring someone onto this instance.</Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else}
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>For</Table.Head>
          <Table.Head>Role</Table.Head>
          <Table.Head>Uses</Table.Head>
          <Table.Head>Expires</Table.Head>
          <Table.Head>Status</Table.Head>
          <Table.Head class="w-0"><span class="sr-only">Actions</span></Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each data.invites as invite (invite.id)}
          {@const s = status(invite)}
          <Table.Row>
            <Table.Cell class="font-medium">
              {invite.email ?? "Anyone with the link"}
            </Table.Cell>
            <Table.Cell><Badge variant="secondary">{invite.role}</Badge></Table.Cell>
            <Table.Cell>{invite.uses}{invite.maxUses === null ? "" : ` / ${invite.maxUses}`}</Table.Cell>
            <Table.Cell class="text-muted-foreground">{formatDateTime(invite.expiresAt)}</Table.Cell>
            <Table.Cell><Badge variant={s.variant}>{s.label}</Badge></Table.Cell>
            <Table.Cell>
              {#if s.label === "active"}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={revoking === invite.id}
                  onclick={() => revoke(invite)}
                >
                  Revoke
                </Button>
              {/if}
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  {/if}
</div>

<Dialog.Root bind:open={createOpen}>
  <Dialog.Content>
    {#if mintedLink}
      <Dialog.Header>
        <Dialog.Title>Invite link</Dialog.Title>
        <Dialog.Description>
          This is the only time the link is shown — the instance keeps no copy. Send it to the
          person yourself.
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex items-center gap-2">
        <Input readonly value={mintedLink} onfocus={(e) => e.currentTarget.select()} />
        <Button variant="outline" size="icon" onclick={copyLink}>
          <CopyIcon />
          <span class="sr-only">Copy link</span>
        </Button>
      </div>
      <Dialog.Footer>
        <Button
          onclick={() => {
            createOpen = false;
          }}
        >
          Done
        </Button>
      </Dialog.Footer>
    {:else}
      <form onsubmit={submitCreate} class="flex flex-col gap-4">
        <Dialog.Header>
          <Dialog.Title>New invite</Dialog.Title>
          <Dialog.Description>
            Leave the address empty for a link anyone may use.
          </Dialog.Description>
        </Dialog.Header>
        <Field.FieldGroup>
          <Field.Field>
            <Field.FieldLabel for="invite-email">Email</Field.FieldLabel>
            <Input
              id="invite-email"
              type="email"
              bind:value={email}
              placeholder="them@example.com (optional)"
            />
          </Field.Field>
          <Field.Field>
            <Field.FieldLabel for="invite-role">Role</Field.FieldLabel>
            <Select.Root type="single" bind:value={role}>
              <Select.Trigger id="invite-role" class="w-full">{role}</Select.Trigger>
              <Select.Content>
                <Select.Group>
                  {#each ROLES as option (option)}
                    <Select.Item value={option} label={option} />
                  {/each}
                </Select.Group>
              </Select.Content>
            </Select.Root>
          </Field.Field>
          <Field.Field>
            <Field.FieldLabel for="invite-expiry">Expires in (days)</Field.FieldLabel>
            <Input id="invite-expiry" type="number" min={1} max={365} bind:value={expiresInDays} />
          </Field.Field>
          {#if email.trim() === ""}
            <Field.Field>
              <Field.FieldLabel for="invite-uses">Max uses</Field.FieldLabel>
              <Input id="invite-uses" type="number" min={1} bind:value={maxUses} placeholder="unlimited" />
            </Field.Field>
          {/if}
        </Field.FieldGroup>
        <Dialog.Footer>
          <Button type="submit" disabled={creating}>
            {#if creating}
              <Spinner data-icon="inline-start" />
            {/if}
            Create invite
          </Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
