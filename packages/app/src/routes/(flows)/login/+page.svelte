<script lang="ts">
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Spinner } from "$lib/components/ui/spinner";
import { LINK_PROBLEMS } from "$lib/utils/auth/link-problems";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import { providerLabel } from "$lib/utils/providers";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
import FingerprintIcon from "@lucide/svelte/icons/scan-face";
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import { signInWithPasskey as authenticateWithPasskey, signInWithPassword } from "./login";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

// Single-user, the way in is the link printed at boot; a password works too once one is set.
const description = $derived(
  data.linkProblem
    ? LINK_PROBLEMS[data.linkProblem]
    : data.multiUser
    ? "Log in to your Ryph instance."
    : "Use the sign-in link ryph printed when it started, or your password. Run ryph login for a new link.",
);

let email = $state("");
let password = $state("");
let submitting = $state(false);
let passkeyBusy = $state(false);

async function signInWithPasskey() {
  passkeyBusy = true;
  try {
    await authenticateWithPasskey(data.backTo);
  } finally {
    passkeyBusy = false;
  }
}

async function submit(event: SubmitEvent) {
  event.preventDefault();
  submitting = true;

  try {
    await signInWithPassword(email, password, data.backTo);
  } finally {
    submitting = false;
  }
}
</script>

<svelte:head>
  <title>Log in · Ryph</title>
</svelte:head>

<form onsubmit={submit}>
  <FlowStep headline="Welcome back" description={description}>
    <Field.FieldGroup>
      <Field.Field>
        <Field.FieldLabel for="email">Email</Field.FieldLabel>
        <Input
          id="email"
          type="email"
          autocomplete="email"
          required
          bind:value={email}
          placeholder="you@example.com"
        />
      </Field.Field>
      <Field.Field>
        <Field.FieldLabel for="password">Password</Field.FieldLabel>
        <Input
          id="password"
          type="password"
          autocomplete="current-password"
          required
          bind:value={password}
        />
      </Field.Field>
    </Field.FieldGroup>

    <div class="flex flex-col gap-2 pt-4">
      <Button variant="outline" disabled={passkeyBusy} onclick={signInWithPasskey}>
        {#if passkeyBusy}
          <Spinner data-icon="inline-start" />
        {:else}
          <FingerprintIcon data-icon="inline-start" />
        {/if}
        Sign in with a passkey
      </Button>
      {#if data.providers.length > 0}
        {#each data.providers as provider (provider)}
          <Button
            variant="outline"
            href="/auth/oauth/{provider}/start?intent=login{data.backTo
              ? `&backTo=${encodeURIComponent(data.backTo)}`
              : ''}"
            data-sveltekit-reload
          >
            {#if provider === "github" || provider === "gitlab"}
              <ForgeIcon {provider} />
            {:else}
              <KeyRoundIcon data-icon="inline-start" />
            {/if}
            Continue with {providerLabel(provider)}
          </Button>
        {/each}
      {/if}
    </div>

    {#snippet leftActions()}
      <p class="text-muted-foreground text-sm">
        <a href="/forgot-password" class="underline underline-offset-4">Forgot your password?</a>
      </p>
      {#if !data.multiUser}
        <!-- Nobody registers on a single-user instance. -->
      {:else if data.needsBootstrap}
        <p class="text-muted-foreground text-sm">
          First run? <a href="/register" class="underline underline-offset-4"
            >Create the admin account</a
          >
        </p>
      {:else if data.openRegistration}
        <p class="text-muted-foreground text-sm">
          No account yet? <a href="/register" class="underline underline-offset-4">Create one</a>
        </p>
      {/if}
    {/snippet}

    {#snippet actions()}
      <Button type="submit" disabled={submitting}>
        {#if submitting}
          <Spinner data-icon="inline-start" />
        {:else}
          <ArrowRightIcon data-icon="inline-start" />
        {/if}
        Log in
      </Button>
    {/snippet}
  </FlowStep>
</form>
