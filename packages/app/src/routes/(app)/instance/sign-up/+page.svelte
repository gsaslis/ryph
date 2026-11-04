<script lang="ts">
import PageTitle from "$lib/components/page-title/page-title.svelte";
import SingleUserNotice from "$lib/components/single-user-notice/single-user-notice.svelte";
import { invalidate } from "$app/navigation";
import { mintResetLink, updateAuthSettings } from "$lib/api/admin";
import type { User } from "$lib/api/types";
import * as Alert from "$lib/components/ui/alert";
import { Button } from "$lib/components/ui/button";
import SettingsSection from "$lib/components/settings-section/settings-section.svelte";
import { Separator } from "$lib/components/ui/separator";
import { Checkbox } from "$lib/components/ui/checkbox";
import * as Dialog from "$lib/components/ui/dialog";
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import { formatDateTime } from "$lib/utils/format";
import CopyIcon from "@lucide/svelte/icons/copy";
import { providerLabel } from "$lib/utils/providers";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

let saving = $state(false);

async function toggle(key: "allowOpenRegistration" | "allowForgeOrgJoin", value: boolean) {
  saving = true;
  try {
    await updateAuthSettings(fetch, { [key]: value });
    await invalidate("app:admin-authentication");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to save");
  } finally {
    saving = false;
  }
}

const forgeNames = $derived(data.providers.map(providerLabel).join(", "));

let minting = $state<string | null>(null);
let minted = $state<{ user: User; link: string } | null>(null);

async function settle(user: User) {
  minting = user.id;
  try {
    minted = { user, link: await mintResetLink(fetch, user.id) };
    await invalidate("app:admin-authentication");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to mint the link");
  } finally {
    minting = null;
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
</script>

<svelte:head>
  <title>Sign-up & email · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-10">
  <PageTitle title="Sign-up & email">
    {#snippet description()}
      Who can create an account, and the email used to verify addresses. Invites always work.
    {/snippet}
  </PageTitle>

  <SettingsSection id="registration" title="Who can sign up">
    {#snippet description()}
      Both options work on their own. With both off, people can only join through an invite.
    {/snippet}
    {#if !data.settings.multiUser}
      <SingleUserNotice />
    {/if}
    <div class="flex items-start gap-3">
      <Checkbox
        id="forge-org-join"
        checked={data.settings.allowForgeOrgJoin}
        disabled={saving || data.providers.length === 0 || !data.settings.multiUser}
        onCheckedChange={(v) => toggle("allowForgeOrgJoin", v === true)}
      />
      <div class="flex flex-col gap-1">
        <Label for="forge-org-join">Members of your {forgeNames || "forge"} org</Label>
        <p class="text-muted-foreground text-sm">
          {#if data.providers.length === 0}
            No forge is set up on this instance, so there's no org to check.
          {:else}
            They sign in with their {forgeNames} account. Membership is checked each time, and the
            App needs the "Members: read" permission.
          {/if}
        </p>
      </div>
    </div>

    <div class="flex items-start gap-3">
      <Checkbox
        id="open-registration"
        checked={data.settings.allowOpenRegistration}
        disabled={saving || !data.settings.multiUser}
        onCheckedChange={(v) => toggle("allowOpenRegistration", v === true)}
      />
      <div class="flex flex-col gap-1">
        <Label for="open-registration">Anyone with an email address</Label>
        <p class="text-muted-foreground text-sm">
          New accounts stay unverified until they confirm their address.
        </p>
      </div>
    </div>

    {#if data.settings.allowOpenRegistration}
      <Alert.Root variant="destructive">
        <TriangleAlertIcon />
        <Alert.Title>Anyone can create an account</Alert.Title>
        <Alert.Description>
          Every account can see the shared tasks, agents and repos. Changing a repository still
          needs a linked forge account with access to it.
          {#if !data.settings.mailerConfigured}
            This instance can't send email, so you'll need to send each new person their
            verification link yourself.
          {/if}
        </Alert.Description>
      </Alert.Root>
    {/if}
  </SettingsSection>

  <Separator />

  <SettingsSection id="email" title="Email">
    {#snippet description()}
      {#if data.settings.mailerConfigured}
        Verification and password reset links are sent by email.
      {:else}
        No mail server is set up (<code>RYPH_SMTP_URL</code> and <code>RYPH_MAIL_FROM</code>), so
        you send those links yourself.
      {/if}
    {/snippet}
    {#if data.settings.mailerConfigured}
      <p class="text-sm">Sending is set up.</p>
    {:else}
      <div class="flex flex-col gap-2">
        <h3 class="text-sm font-medium">Password reset requests</h3>
        <ul class="divide-y rounded-lg border text-sm">
          {#each data.resetRequests as user (user.id)}
            <li class="flex items-center justify-between gap-4 px-3 py-2.5">
              <div class="flex min-w-0 flex-col">
                <span class="truncate font-medium">{user.name ?? user.email}</span>
                <span class="text-muted-foreground truncate text-xs">
                  {#if user.name}{user.email}, {/if}asked
                  {user.resetRequestedAt ? formatDateTime(user.resetRequestedAt) : ""}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={minting === user.id}
                onclick={() => settle(user)}
              >
                Create link
              </Button>
            </li>
          {:else}
            <li class="text-muted-foreground px-3 py-2.5">Nobody is waiting for one.</li>
          {/each}
        </ul>
      </div>
    {/if}
  </SettingsSection>
</div>

<Dialog.Root
  open={minted !== null}
  onOpenChange={(open) => {
    if (!open) minted = null;
  }}
>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Link for {minted?.user.name || minted?.user.email}</Dialog.Title>
      <Dialog.Description>
        Shown once — the instance keeps no copy. Hand it to them yourself; it works one time and
        expires in an hour.
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
