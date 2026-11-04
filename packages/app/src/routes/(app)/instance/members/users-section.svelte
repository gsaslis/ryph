<script lang="ts">
import { ROLES } from "$lib/utils/auth/capabilities";
import { invalidate } from "$app/navigation";
import { deleteUser, mintResetLink, mintVerificationLink, updateUser } from "$lib/api/admin";
import type { User } from "$lib/api/types";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
import { Input } from "$lib/components/ui/input";
import { Spinner } from "$lib/components/ui/spinner";
import * as Table from "$lib/components/ui/table";
import { formatDateTime } from "$lib/utils/format";
import CopyIcon from "@lucide/svelte/icons/copy";
import MoreHorizontalIcon from "@lucide/svelte/icons/more-horizontal";
import { toast } from "svelte-sonner";
import type { PageData } from "./$types";
import { refreshWhileLive } from "$lib/utils/live-refresh.svelte";

let { data }: { data: PageData } = $props();

// An unproven account changes on its own once its link is opened, so the list keeps asking
// while one is on it.
refreshWhileLive("app:admin-users", () => data.users.some((u) => u.emailVerifiedAt === null));

let busy = $state<string | null>(null);

async function patch(user: User, change: { role?: User["role"]; status?: User["status"] }) {
  busy = user.id;
  try {
    await updateUser(fetch, user.id, change);
    toast.success(`Updated ${user.name || user.email}`);
    await invalidate("app:admin-users");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to update user");
  } finally {
    busy = null;
  }
}

// A minted link exists only here, once: the control plane keeps a digest, never the token.
let minted = $state<{ kind: "reset" | "verify"; user: User; link: string } | null>(null);

async function mint(user: User, kind: "reset" | "verify") {
  busy = user.id;
  try {
    const link = kind === "reset"
      ? await mintResetLink(fetch, user.id)
      : await mintVerificationLink(fetch, user.id);
    minted = { kind, user, link };
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to mint the link");
  } finally {
    busy = null;
  }
}

async function copyMinted() {
  if (!minted) return;
  try {
    await navigator.clipboard.writeText(minted.link);
    toast.success("Link copied");
  } catch {
    toast.error("Could not copy — select the link and copy it by hand");
  }
}

let deleteTarget: User | null = $state(null);
let deleting = $state(false);

async function submitDelete() {
  if (!deleteTarget) return;
  deleting = true;
  try {
    await deleteUser(fetch, deleteTarget.id);
    toast.success(`Deleted ${deleteTarget.name || deleteTarget.email}`);
    deleteTarget = null;
    await invalidate("app:admin-users");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to delete user");
  } finally {
    deleting = false;
  }
}
</script>

<div class="flex flex-col gap-6">
  <div class="flex flex-col gap-1">
    <h2 class="text-base font-medium">People</h2>
    <p class="text-muted-foreground text-sm">
      Everyone with an account. Deactivating someone signs them out everywhere. The last admin can't be demoted or removed.
    </p>
  </div>

  <Table.Root>
    <Table.Header>
      <Table.Row>
        <Table.Head>Name</Table.Head>
        <Table.Head>Email</Table.Head>
        <Table.Head>Role</Table.Head>
        <Table.Head>Status</Table.Head>
        <Table.Head>Joined</Table.Head>
        <Table.Head class="w-0"><span class="sr-only">Actions</span></Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#each data.users as user (user.id)}
        <Table.Row>
          <Table.Cell class="font-medium">
            {#if user.name}
              {user.name}
            {:else}
              <span class="text-muted-foreground">No name yet</span>
            {/if}
            {#if user.id === data.user.id}
              <span class="text-muted-foreground">(you)</span>
            {/if}
          </Table.Cell>
          <Table.Cell>
            {#if user.unprovenEmail !== null}
              <!-- GitLab's word for it: the account holds a stand-in, never this address. -->
              {user.unprovenEmail}
              <Badge
                variant="outline"
                class="ml-2"
                title="GitLab gave this address and nobody proved it. It signs into nothing and gets no mail."
              >
                Unproven
              </Badge>
            {:else}
              {user.email}
            {/if}
            {#if user.emailVerifiedAt === null}
              <Badge variant="outline" class="ml-2">Unverified</Badge>
            {/if}
          </Table.Cell>
          <Table.Cell>
            <Badge variant={user.role === "owner" ? "default" : "secondary"}>{user.role}</Badge>
          </Table.Cell>
          <Table.Cell>
            <Badge variant={user.status === "active" ? "secondary" : "destructive"}>
              {user.status}
            </Badge>
          </Table.Cell>
          <Table.Cell class="text-muted-foreground">{formatDateTime(user.createdAt)}</Table.Cell>
          <Table.Cell>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <Button
                    {...props}
                    variant="ghost"
                    size="icon"
                    disabled={busy === user.id || !data.multiUser}
                  >
                    {#if busy === user.id}
                      <Spinner />
                    {:else}
                      <MoreHorizontalIcon />
                    {/if}
                    <span class="sr-only">Actions for {user.name || user.email}</span>
                  </Button>
                {/snippet}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end">
                <DropdownMenu.Group>
                  {#each ROLES.filter((role) => role !== user.role) as role (role)}
                    <DropdownMenu.Item onclick={() => patch(user, { role })}>
                      Make {role}
                    </DropdownMenu.Item>
                  {/each}
                  {#if user.status === "active"}
                    <DropdownMenu.Item onclick={() => patch(user, { status: "deactivated" })}>
                      Deactivate
                    </DropdownMenu.Item>
                  {:else}
                    <DropdownMenu.Item onclick={() => patch(user, { status: "active" })}>
                      Reactivate
                    </DropdownMenu.Item>
                  {/if}
                  <DropdownMenu.Separator />
                  <!-- An owner changes their password signed in, never through a link; an account
                       without a proven address has none a password could sign in with. -->
                  {#if user.role !== "owner" && user.unprovenEmail === null}
                    <DropdownMenu.Item onclick={() => mint(user, "reset")}>
                      Password reset link
                    </DropdownMenu.Item>
                  {/if}
                  {#if user.emailVerifiedAt === null}
                    <DropdownMenu.Item onclick={() => mint(user, "verify")}>
                      Verification link
                    </DropdownMenu.Item>
                  {/if}
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    variant="destructive"
                    onclick={() => {
                      deleteTarget = user;
                    }}
                  >
                    Delete
                  </DropdownMenu.Item>
                </DropdownMenu.Group>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </Table.Cell>
        </Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
</div>

<Dialog.Root
  open={minted !== null}
  onOpenChange={(open) => {
    if (!open) minted = null;
  }}
>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>
        {minted?.kind === "reset" ? "Password reset link" : "Verification link"} for {minted?.user.name || minted?.user.email}
      </Dialog.Title>
      <Dialog.Description>
        Shown once — the instance keeps no copy. Hand it to them yourself; it works one time and
        {minted?.kind === "reset" ? "expires in an hour." : "expires in 24 hours."}
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex items-center gap-2">
      <Input readonly value={minted?.link ?? ""} onfocus={(e) => e.currentTarget.select()} />
      <Button variant="outline" size="icon" onclick={copyMinted}>
        <CopyIcon />
        <span class="sr-only">Copy link</span>
      </Button>
    </div>
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root
  open={deleteTarget !== null}
  onOpenChange={(open) => {
    if (!open) deleteTarget = null;
  }}
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete {deleteTarget?.name}?</AlertDialog.Title>
      <AlertDialog.Description>
        Their account, sessions, and linked identities are removed for good. Tasks they requested
        stay, attributed to nobody.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action disabled={deleting} onclick={submitDelete}>
        {#if deleting}
          <Spinner data-icon="inline-start" />
        {/if}
        Delete user
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
