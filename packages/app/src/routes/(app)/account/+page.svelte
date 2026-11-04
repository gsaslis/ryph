<script lang="ts">
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as ToggleGroup from "$lib/components/ui/toggle-group";
import { invalidate } from "$app/navigation";
import { goto } from "$app/navigation";
import {
  changePassword,
  createApiToken,
  deleteOwnAccount,
  listApiTokens,
  revokeAllSessions,
  revokeApiToken,
  revokeSession,
  updateProfile,
} from "$lib/api/account";
import { unlinkIdentity } from "$lib/api/identities";
import { logOut, refreshSession } from "$lib/utils/auth/auth";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import {
  deletePasskey,
  passkeyRegistrationOptions,
  registerPasskey,
  renamePasskey,
} from "$lib/api/passkeys";
import type { Passkey } from "$lib/api/types";
import * as Dialog from "$lib/components/ui/dialog";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Spinner } from "$lib/components/ui/spinner";
import { startRegistration } from "@simplewebauthn/browser";
import { formatDateTime } from "$lib/utils/format";
import { providerLabel } from "$lib/utils/providers";
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import Link2Icon from "@lucide/svelte/icons/link-2";
import LogOutIcon from "@lucide/svelte/icons/log-out";
import PencilIcon from "@lucide/svelte/icons/pencil";
import PlusIcon from "@lucide/svelte/icons/plus";
import ScanFaceIcon from "@lucide/svelte/icons/scan-face";
import Trash2Icon from "@lucide/svelte/icons/trash-2";
import Unlink2Icon from "@lucide/svelte/icons/unlink-2";
import { toast } from "svelte-sonner";
import MonitorIcon from "@lucide/svelte/icons/monitor";
import MoonIcon from "@lucide/svelte/icons/moon";
import TerminalIcon from "@lucide/svelte/icons/terminal";
import SunIcon from "@lucide/svelte/icons/sun";
import { setMode, setTheme, theme, userPrefersMode } from "mode-watcher";
import type { PageProps } from "./$types";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import SettingsSection from "$lib/components/settings-section/settings-section.svelte";
import { Checkbox } from "$lib/components/ui/checkbox";
import { Label } from "$lib/components/ui/label";
import { can, CAPABILITIES, SESSION_ONLY_CAPABILITIES } from "$lib/utils/auth/capabilities";
import KeyIcon from "@lucide/svelte/icons/key";
import { Separator } from "$lib/components/ui/separator";
import RadicleIdentity from "./radicle-identity.svelte";

let { data }: PageProps = $props();

let unlinking = $state<string | null>(null);

// ── profile ─────────────────────────────────────────────────────────────────────────────────

// Seeded from the account once; the form owns them after.
// svelte-ignore state_referenced_locally
let profileName = $state(data.me.name);
// svelte-ignore state_referenced_locally
let profileEmail = $state(data.me.unprovenEmail ?? data.me.email);
let savingProfile = $state(false);
// The address changes without proof only for a single-user owner: on a shared instance it is how
// people are told apart, and anyone left over from one keeps theirs.
// An account GitLab registered holds no address at all, only GitLab's word shown here.
let emailLocked = $derived(
  data.multiUser || data.me.role !== "owner" || data.me.unprovenEmail !== null,
);

async function submitProfile(event: SubmitEvent) {
  event.preventDefault();
  savingProfile = true;
  try {
    // The address only where it can change.
    await updateProfile(fetch, {
      name: profileName.trim(),
      ...(emailLocked ? {} : { email: profileEmail.trim() }),
    });
    toast.success("Profile saved");
    // The name and address the app shows come from the access token, which still carries the
    // old ones. A refresh mints a new pair from the saved account; then the layout reads it.
    await refreshSession();
    await Promise.all([invalidate("app:user"), invalidate("app:settings")]);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to save the profile");
  } finally {
    savingProfile = false;
  }
}

// ── password ────────────────────────────────────────────────────────────────────────────────

let currentPassword = $state("");
let newPassword = $state("");
let savingPassword = $state(false);

async function submitPassword(event: SubmitEvent) {
  event.preventDefault();
  savingPassword = true;
  try {
    await changePassword(fetch, {
      currentPassword: data.me.hasPassword ? currentPassword : null,
      newPassword,
    });
    // Every session died with the change, this one included: sign in again with the new one.
    toast.success("Password set — sign in with it");
    await logOut();
    await goto("/login", { invalidateAll: true });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to set the password");
  } finally {
    savingPassword = false;
  }
}

// ── API tokens ──────────────────────────────────────────────────────────────────────────────

// The capabilities a token may carry: those the signed-in user holds, less the ones auth answers
// to a session only. The API refuses both, and the form does not offer what would come back a
// refusal.
const grantable = $derived(
  CAPABILITIES.filter((capability) =>
    can(data.user, capability) && !SESSION_ONLY_CAPABILITIES.includes(capability)
  ),
);
let createTokenOpen = $state(false);
let tokenName = $state("");
let tokenDays = $state(90);
let tokenCaps = $state<string[]>([]);
let creatingToken = $state(false);
// The secret exists only here, once: the control plane keeps a digest, never the token.
let mintedToken = $state<string | null>(null);
let revokingToken = $state<string | null>(null);

function toggleCap(capability: string, on: boolean) {
  tokenCaps = on ? [...tokenCaps, capability] : tokenCaps.filter((c) => c !== capability);
}

async function submitToken(event: SubmitEvent) {
  event.preventDefault();
  creatingToken = true;
  try {
    const { token } = await createApiToken(fetch, {
      name: tokenName.trim(),
      caps: tokenCaps,
      expiresInDays: tokenDays,
    });
    mintedToken = token;
    tokenName = "";
    tokenCaps = [];
    tokenDays = 90;
    await invalidate("app:settings");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to mint the token");
  } finally {
    creatingToken = false;
  }
}

async function revokeToken(id: string) {
  revokingToken = id;
  try {
    await revokeApiToken(fetch, id);
    await invalidate("app:settings");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to revoke the token");
  } finally {
    revokingToken = null;
  }
}

// ── sessions ────────────────────────────────────────────────────────────────────────────────

let revokingSession = $state<string | null>(null);

async function endSession(id: string) {
  revokingSession = id;
  try {
    await revokeSession(fetch, id);
    await invalidate("app:settings");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to end the session");
  } finally {
    revokingSession = null;
  }
}

async function signOutEverywhere() {
  try {
    await revokeAllSessions(fetch);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to sign out everywhere");
    return;
  }
  await logOut();
  await goto("/login", { invalidateAll: true });
}

// ── the way out ─────────────────────────────────────────────────────────────────────────────

let deleteOpen = $state(false);
let deleting = $state(false);

async function deleteAccount() {
  deleting = true;
  try {
    await deleteOwnAccount(fetch, data.user.id);
    await logOut();
    await goto("/login", { invalidateAll: true });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to delete the account");
    deleting = false;
  }
}

/** A user agent reduced to what a person recognizes: the browser and the platform. */
function describeAgent(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = /Firefox\//.test(userAgent)
    ? "Firefox"
    : /Edg\//.test(userAgent)
    ? "Edge"
    : /Chrome\//.test(userAgent)
    ? "Chrome"
    : /Safari\//.test(userAgent)
    ? "Safari"
    : "Browser";
  const platform = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
    ? "Android"
    : /Mac OS X/.test(userAgent)
    ? "macOS"
    : /Windows/.test(userAgent)
    ? "Windows"
    : /Linux/.test(userAgent)
    ? "Linux"
    : "";
  return platform ? `${browser} on ${platform}` : browser;
}

// ── passkeys ────────────────────────────────────────────────────────────────────────────────

let addPasskeyOpen = $state(false);
let passkeyName = $state("");
let addingPasskey = $state(false);

async function addPasskey(event: SubmitEvent) {
  event.preventDefault();
  addingPasskey = true;
  try {
    const { challengeId, options } = await passkeyRegistrationOptions(fetch);
    const response = await startRegistration({
      optionsJSON: options as unknown as Parameters<typeof startRegistration>[0]["optionsJSON"],
    });
    await registerPasskey(fetch, { challengeId, response, name: passkeyName.trim() });
    toast.success(`Passkey "${passkeyName.trim()}" added`);
    addPasskeyOpen = false;
    passkeyName = "";
    await invalidate("app:settings");
  } catch (e) {
    if (!(e instanceof Error && e.name === "NotAllowedError")) {
      toast.error(e instanceof Error ? e.message : "Failed to add the passkey");
    }
  } finally {
    addingPasskey = false;
  }
}

let renameTarget: Passkey | null = $state(null);
let renameValue = $state("");
let renaming = $state(false);

async function submitRename(event: SubmitEvent) {
  event.preventDefault();
  if (!renameTarget) return;
  renaming = true;
  try {
    await renamePasskey(fetch, renameTarget.id, renameValue.trim());
    renameTarget = null;
    await invalidate("app:settings");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to rename the passkey");
  } finally {
    renaming = false;
  }
}

let removingPasskey = $state<string | null>(null);

async function removePasskey(passkey: Passkey) {
  removingPasskey = passkey.id;
  try {
    await deletePasskey(fetch, passkey.id);
    toast.success(`Passkey "${passkey.name}" removed`);
    await invalidate("app:settings");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to remove the passkey");
  } finally {
    removingPasskey = null;
  }
}

async function unlink(provider: string) {
  unlinking = provider;
  try {
    await unlinkIdentity(fetch, provider);
    toast.success(`${providerLabel(provider)} account unlinked`);
    await invalidate("app:settings");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to unlink");
  } finally {
    unlinking = null;
  }
}

// Radicle is an optional platform service, and its identity is proved by a signed challenge
// rather than an OAuth redirect — so it gets its own card, beside the providers people sign in
// through, and only where a repository can actually be connected through it.
const hasRadicle = $derived(data.forgeProviders.includes("radicle"));
const radicleIdentity = $derived(data.identities.find((i) => i.provider === "radicle") ?? null);

// The allowlist is the deployment's, so only an admin is shown it — and only when it could be
// read at all: a ceiling this page could not fetch is not an open one.

const themeOptions = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "Auto", icon: MonitorIcon },
  { value: "h4x0r", label: "h4x0r", icon: TerminalIcon },
] as const;

type Appearance = (typeof themeOptions)[number]["value"];

// h4x0r is a theme, not a mode: it is a dark-mode skin, so choosing it sets both, and choosing
// anything else clears the theme.
const appearance = $derived<Appearance>(
  theme.current === "h4x0r" ? "h4x0r" : userPrefersMode.current,
);

function chooseAppearance(value: Appearance) {
  if (value === "h4x0r") {
    setMode("dark");
    setTheme("h4x0r");
    return;
  }
  setTheme("");
  setMode(value);
}
</script>

<svelte:head>
  <title>Account settings · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-10">
  <PageTitle title="Account settings">
    {#snippet description()}
      How you sign in, and how Ryph looks for you.
    {/snippet}
  </PageTitle>

  <SettingsSection title="Appearance">
    {#snippet description()}
      Choose how Ryph looks. "Auto" follows your system preference.
    {/snippet}
    <ToggleGroup.Root
      type="single"
      variant="outline"
      value={appearance}
      onValueChange={(value) => {
        if (value) chooseAppearance(value as Appearance);
      }}
    >
      {#each themeOptions as option (option.value)}
        <ToggleGroup.Item value={option.value} aria-label="{option.label} theme">
          <option.icon />
          {option.label}
        </ToggleGroup.Item>
      {/each}
    </ToggleGroup.Root>
  </SettingsSection>

  <Separator />

  <SettingsSection title="Profile">
    {#snippet description()}
      {emailLocked
        ? "The name other people see."
        : "Your name and email address."}
    {/snippet}
    <form onsubmit={submitProfile} class="flex max-w-md flex-col gap-4">
      <Field.FieldGroup>
        <Field.Field>
          <Field.FieldLabel for="profile-name">Name</Field.FieldLabel>
          <Input id="profile-name" autocomplete="name" required bind:value={profileName} />
        </Field.Field>
        <Field.Field data-disabled={emailLocked}>
          <Field.FieldLabel for="profile-email">Email</Field.FieldLabel>
          <Input
            id="profile-email"
            type="email"
            autocomplete="email"
            required
            disabled={emailLocked}
            bind:value={profileEmail}
          />
          {#if data.me.unprovenEmail !== null}
            <Field.FieldDescription>
              GitLab gave this address and nobody has proven it, so it signs into nothing and gets
              no mail.
            </Field.FieldDescription>
          {:else if data.multiUser}
            <Field.FieldDescription>It can't be changed.</Field.FieldDescription>
          {:else if emailLocked}
            <Field.FieldDescription>Only the owner can change it.</Field.FieldDescription>
          {/if}
        </Field.Field>
      </Field.FieldGroup>
      <div>
        <Button type="submit" variant="outline" disabled={savingProfile}>
          {#if savingProfile}
            <Spinner data-icon="inline-start" />
          {/if}
          Save profile
        </Button>
      </div>
    </form>
  </SettingsSection>

  <Separator />

  <SettingsSection title="Password">
    {#snippet description()}
      {data.me.hasPassword
          ? "Changing it signs out every session, this one included."
          : "This account has no password; set one to sign in with your email as well."}
    {/snippet}
    <form onsubmit={submitPassword} class="flex max-w-md flex-col gap-4">
      <Field.FieldGroup>
        {#if data.me.hasPassword}
          <Field.Field>
            <Field.FieldLabel for="current-password">Current password</Field.FieldLabel>
            <Input
              id="current-password"
              type="password"
              autocomplete="current-password"
              required
              bind:value={currentPassword}
            />
          </Field.Field>
        {/if}
        <Field.Field>
          <Field.FieldLabel for="new-password">New password</Field.FieldLabel>
          <Input
            id="new-password"
            type="password"
            autocomplete="new-password"
            required
            minlength={8}
            bind:value={newPassword}
          />
          <Field.FieldDescription>At least 8 characters.</Field.FieldDescription>
        </Field.Field>
      </Field.FieldGroup>
      <div>
        <Button type="submit" variant="outline" disabled={savingPassword}>
          {#if savingPassword}
            <Spinner data-icon="inline-start" />
          {:else}
            <KeyRoundIcon data-icon="inline-start" />
          {/if}
          {data.me.hasPassword ? "Change password" : "Set password"}
        </Button>
      </div>
    </form>
  </SettingsSection>

  <Separator />

  <SettingsSection title="Passkeys">
    {#snippet description()}
      Sign in with your device's screen lock or a security key instead of a password. Each
        passkey is bound to this instance's address.
    {/snippet}
    {#each data.passkeys as passkey (passkey.id)}
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-2 text-sm">
          <ScanFaceIcon class="size-4" />
          <span class="font-medium">{passkey.name}</span>
          <span class="text-muted-foreground">
            added {formatDateTime(passkey.createdAt)}{passkey.lastUsedAt
              ? `, last used ${formatDateTime(passkey.lastUsedAt)}`
              : ""}
          </span>
        </div>
        <div class="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onclick={() => {
              renameTarget = passkey;
              renameValue = passkey.name;
            }}
          >
            <PencilIcon />
            <span class="sr-only">Rename {passkey.name}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={removingPasskey === passkey.id}
            onclick={() => removePasskey(passkey)}
          >
            <Trash2Icon />
            <span class="sr-only">Remove {passkey.name}</span>
          </Button>
        </div>
      </div>
    {:else}
      <span class="text-muted-foreground text-sm">No passkeys yet.</span>
    {/each}
    <div>
      <Button
        variant="outline"
        onclick={() => {
          addPasskeyOpen = true;
        }}
      >
        <PlusIcon data-icon="inline-start" />
        Add a passkey
      </Button>
    </div>
  </SettingsSection>

  <Separator />

  <SettingsSection title="Linked accounts">
    {#snippet description()}
      Your accounts on the forges Ryph works with. They decide what you can do with a repository.
      {#if data.providers.length > 0}
        You can also sign in with {data.providers.map(providerLabel).join(" or ")}.
      {/if}
    {/snippet}
    {#if data.providers.length === 0 && !hasRadicle && !data.githubLogin && !data.gitlabLogin}
      <p class="text-muted-foreground text-sm">There are no accounts to link on this instance.</p>
    {:else}
      <ul class="divide-y rounded-lg border">
        {#each data.providers as provider (provider)}
          {@const identity = data.identities.find((i) => i.provider === provider)}
          <li class="flex flex-wrap items-center gap-3 px-3 py-2.5">
            {#if provider === "github" || provider === "gitlab"}
              <ForgeIcon {provider} class="size-5" />
            {:else}
              <Link2Icon class="size-5" />
            {/if}
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="text-sm font-medium">{providerLabel(provider)}</span>
              <span class="text-muted-foreground truncate text-xs">
                {#if identity}
                  @{identity.login}, linked {formatDateTime(identity.linkedAt)}
                {:else}
                  Not linked
                {/if}
              </span>
            </div>
            {#if identity}
              <div class="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  href="/auth/oauth/{provider}/start?intent=link"
                  data-sveltekit-reload
                >
                  <Link2Icon data-icon="inline-start" />
                  Re-link
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={unlinking === provider}
                  onclick={() => unlink(provider)}
                >
                  <Unlink2Icon data-icon="inline-start" />
                  Unlink
                </Button>
              </div>
            {:else}
              <Button
                variant="outline"
                size="sm"
                href="/auth/oauth/{provider}/start?intent=link"
                data-sveltekit-reload
              >
                <Link2Icon data-icon="inline-start" />
                Link
              </Button>
            {/if}
          </li>
        {/each}
        {#if data.githubLogin}
          <li class="flex flex-wrap items-center gap-3 px-3 py-2.5">
            <ForgeIcon provider="github" class="size-5" />
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="text-sm font-medium">GitHub</span>
              <span class="text-muted-foreground text-xs">
                Ryph acts as @{data.githubLogin} on GitHub for everyone who uses it.
              </span>
            </div>
          </li>
        {/if}
        {#if data.gitlabLogin}
          <li class="flex flex-wrap items-center gap-3 px-3 py-2.5">
            <ForgeIcon provider="gitlab" class="size-5" />
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="text-sm font-medium">GitLab</span>
              <span class="text-muted-foreground text-xs">
                Ryph acts as @{data.gitlabLogin} on GitLab for everyone who uses it.
              </span>
            </div>
          </li>
        {/if}
        {#if hasRadicle}
          <RadicleIdentity identity={radicleIdentity} />
        {/if}
      </ul>
    {/if}
  </SettingsSection>

  <Separator />

  <SettingsSection title="API tokens">
    {#snippet description()}
      A credential for a script or an agent, carrying only the capabilities you pick from your
        own. It is traded for a normal access token, and stops working the moment you revoke it.
    {/snippet}
    {#each data.tokens as token (token.id)}
      <div class="flex items-center justify-between gap-4">
        <div class="flex flex-col gap-0.5 text-sm">
          <span class="font-medium">
            <KeyIcon class="mr-1 inline size-4" />
            {token.name}
            {#if token.revokedAt}
              <Badge variant="outline" class="ml-2">Revoked</Badge>
            {:else if token.expiresAt < new Date().toISOString()}
              <Badge variant="outline" class="ml-2">Expired</Badge>
            {/if}
          </span>
          <span class="text-muted-foreground">
            {token.caps.join(", ")} · expires {formatDateTime(token.expiresAt)}
            {#if token.lastUsedAt}
              · used {formatDateTime(token.lastUsedAt)}
            {/if}
          </span>
        </div>
        {#if !token.revokedAt}
          <Button
            variant="ghost"
            size="sm"
            disabled={revokingToken === token.id}
            onclick={() => revokeToken(token.id)}
          >
            Revoke
          </Button>
        {/if}
      </div>
    {:else}
      <span class="text-muted-foreground text-sm">No tokens yet.</span>
    {/each}
    {#if can(data.user, "tokens:write")}
      <div>
        <Button variant="outline" onclick={() => (createTokenOpen = true)}>
          <PlusIcon data-icon="inline-start" />
          Mint a token
        </Button>
      </div>
    {/if}
  </SettingsSection>

  <Separator />

  <SettingsSection title="Sessions">
    {#snippet description()}
      Every browser signed in to your account. Ending one signs it out the next time it needs a
        fresh token, within ten minutes.
    {/snippet}
    {#each data.sessions.sessions as session (session.id)}
      <div class="flex items-center justify-between gap-4">
        <div class="flex flex-col gap-0.5 text-sm">
          <span class="font-medium">
            {describeAgent(session.userAgent)}
            {#if session.id === data.sessions.current}
              <Badge variant="secondary" class="ml-2">This session</Badge>
            {/if}
          </span>
          <span class="text-muted-foreground">
            {session.ip ?? "unknown address"} · signed in {formatDateTime(session.createdAt)}
            {#if session.lastUsedAt}
              · active {formatDateTime(session.lastUsedAt)}
            {/if}
          </span>
        </div>
        {#if session.id !== data.sessions.current}
          <Button
            variant="ghost"
            size="sm"
            disabled={revokingSession === session.id}
            onclick={() => endSession(session.id)}
          >
            End session
          </Button>
        {/if}
      </div>
    {/each}
    <div>
      <Button variant="outline" onclick={signOutEverywhere}>
        <LogOutIcon data-icon="inline-start" />
        Sign out everywhere
      </Button>
    </div>
  </SettingsSection>

  <Separator />

  <SettingsSection title="Delete account">
    {#snippet description()}
      {#if data.multiUser}
        Removes your account, sessions, passkeys, and linked identities for good. Tasks you
        requested stay, attributed to nobody. The last admin cannot leave.
      {:else}
        You're the only user of this instance, so your account stays.
      {/if}
    {/snippet}
    <Button
      variant="destructive"
      disabled={!data.multiUser}
      onclick={() => {
        deleteOpen = true;
      }}
    >
      <Trash2Icon data-icon="inline-start" />
      Delete my account
    </Button>
  </SettingsSection>
</div>

<AlertDialog.Root bind:open={deleteOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete your account?</AlertDialog.Title>
      <AlertDialog.Description>
        This cannot be undone. You are signed out immediately and nothing about your account
        remains on this instance.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action disabled={deleting} onclick={deleteAccount}>
        {#if deleting}
          <Spinner data-icon="inline-start" />
        {/if}
        Delete account
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<Dialog.Root
  bind:open={createTokenOpen}
  onOpenChange={(open) => {
    if (!open) mintedToken = null;
  }}
>
  <Dialog.Content>
    {#if mintedToken !== null}
      <Dialog.Header>
        <Dialog.Title>Your new token</Dialog.Title>
        <Dialog.Description>
          Copy it now. It is shown once, and the control plane keeps only a digest.
        </Dialog.Description>
      </Dialog.Header>
      <Input readonly value={mintedToken} onfocus={(e) => e.currentTarget.select()} />
      <p class="text-muted-foreground text-sm">
        A script never sends this secret as a bearer. It posts it to
        <code>POST /v1/auth/token</code> as
        <code>{"{"} "token": "&lt;the secret above&gt;" {"}"}</code> and gets back an access
        token, which is the bearer it then sends. Each one is good for ten minutes; trade the
        secret again when it runs out.
      </p>
      <Dialog.Footer>
        <Button onclick={() => (createTokenOpen = false)}>Done</Button>
      </Dialog.Footer>
    {:else}
      <form onsubmit={submitToken} class="flex flex-col gap-4">
        <Dialog.Header>
          <Dialog.Title>Mint a token</Dialog.Title>
          <Dialog.Description>
            Name it after what will hold it, and give it only what that needs.
          </Dialog.Description>
        </Dialog.Header>
        <Field.Field>
          <Field.FieldLabel for="token-name">Name</Field.FieldLabel>
          <Input id="token-name" required bind:value={tokenName} placeholder="deploy script" />
        </Field.Field>
        <Field.Field>
          <Field.FieldLabel for="token-days">Expires in (days)</Field.FieldLabel>
          <Input id="token-days" type="number" min={1} max={365} bind:value={tokenDays} />
        </Field.Field>
        <Field.Field>
          <Field.FieldLabel>Capabilities</Field.FieldLabel>
          <div class="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto text-sm">
            {#each grantable as capability (capability)}
              <div class="flex items-center gap-2">
                <Checkbox
                  id="cap-{capability}"
                  checked={tokenCaps.includes(capability)}
                  onCheckedChange={(on) => toggleCap(capability, on === true)}
                />
                <Label for="cap-{capability}" class="font-mono text-xs">{capability}</Label>
              </div>
            {/each}
          </div>
        </Field.Field>
        <Dialog.Footer>
          <Button type="submit" disabled={creatingToken || tokenCaps.length === 0}>
            {#if creatingToken}
              <Spinner data-icon="inline-start" />
            {/if}
            Mint
          </Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={addPasskeyOpen}>
  <Dialog.Content>
    <form onsubmit={addPasskey} class="flex flex-col gap-4">
      <Dialog.Header>
        <Dialog.Title>Add a passkey</Dialog.Title>
        <Dialog.Description>
          Name it after the device or key that holds it; your browser asks for the rest.
        </Dialog.Description>
      </Dialog.Header>
      <Field.Field>
        <Field.FieldLabel for="passkey-name">Name</Field.FieldLabel>
        <Input id="passkey-name" required bind:value={passkeyName} placeholder="MacBook" />
      </Field.Field>
      <Dialog.Footer>
        <Button type="submit" disabled={addingPasskey}>
          {#if addingPasskey}
            <Spinner data-icon="inline-start" />
          {/if}
          Continue
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root
  open={renameTarget !== null}
  onOpenChange={(open) => {
    if (!open) renameTarget = null;
  }}
>
  <Dialog.Content>
    <form onsubmit={submitRename} class="flex flex-col gap-4">
      <Dialog.Header>
        <Dialog.Title>Rename passkey</Dialog.Title>
      </Dialog.Header>
      <Field.Field>
        <Field.FieldLabel for="passkey-rename">Name</Field.FieldLabel>
        <Input id="passkey-rename" required bind:value={renameValue} />
      </Field.Field>
      <Dialog.Footer>
        <Button type="submit" disabled={renaming}>
          {#if renaming}
            <Spinner data-icon="inline-start" />
          {/if}
          Save
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
