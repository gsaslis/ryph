<script lang="ts">
import { goto, invalidate } from "$app/navigation";
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Spinner } from "$lib/components/ui/spinner";
import ForgeIcon from "$lib/components/forge-icon/forge-icon.svelte";
import { providerLabel } from "$lib/utils/providers";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import UserPlusIcon from "@lucide/svelte/icons/user-plus";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

let name = $state("");
let email = $state("");
let password = $state("");
let submitting = $state(false);
let registered = $state(false);

const bound = $derived(data.preview?.email ?? null);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  submitting = true;
  try {
    const res = await fetch(`/auth/invite/${encodeURIComponent(data.token)}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bound ? { name, email: null, password } : { email }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.message ?? "Failed to create the account");
      return;
    }
    if (res.status === 202) {
      registered = true;
      return;
    }
    await invalidate("app:user");
    await goto("/agents");
  } catch {
    toast.error("Failed to reach the server");
  } finally {
    submitting = false;
  }
}
</script>

<svelte:head>
  <title>Invitation · Ryph</title>
</svelte:head>

{#if data.user}
  <FlowStep
  headline="You are already signed in"
  description="This invitation is for someone without an account. You are signed in as {data.user.email}; nothing here was used."
>
    {#snippet actions()}
      <Button href="/agents">
        <ArrowRightIcon data-icon="inline-start" />
        Continue to Ryph
      </Button>
    {/snippet}
  </FlowStep>
{:else if registered}
  <FlowStep
  headline="Check your inbox"
  description={data.mailerConfigured
      ? `A link is on its way to ${email}. Open it to choose your name and password.`
      : `This instance cannot send mail, so an admin has to hand you your sign-up link; they find it on their Users page. Open it to choose your name and password.`}
>
    {#snippet actions()}
      <Button href="/login">
        <ArrowRightIcon data-icon="inline-start" />
        Go to sign-in
      </Button>
    {/snippet}
  </FlowStep>
{:else if !data.preview || !data.preview.valid}
  <FlowStep
  headline="This invitation is no longer valid"
  description="It may have expired, been used, or been revoked. Ask whoever sent it for a new one."
>
    {#snippet actions()}
      <Button href="/login" variant="outline">
        <ArrowRightIcon data-icon="inline-start" />
        Go to sign-in
      </Button>
    {/snippet}
  </FlowStep>
{:else}
  <form onsubmit={submit}>
  <FlowStep
    headline="You're invited"
    description={bound
        ? `Create the account for ${bound} on this Ryph instance.`
        : "Create your account on this Ryph instance. Your name and password come next, from the link we send you."}
  >
      <Field.FieldGroup>
        {#if bound}
          <Field.Field>
            <Field.FieldLabel for="name">Name</Field.FieldLabel>
            <Input id="name" autocomplete="name" required bind:value={name} placeholder="Ada Lovelace" />
          </Field.Field>
        {:else}
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
        {/if}
        {#if bound}
          <Field.Field>
            <Field.FieldLabel for="password">Password</Field.FieldLabel>
            <Input
              id="password"
              type="password"
              autocomplete="new-password"
              required
              minlength={8}
              bind:value={password}
            />
            <Field.FieldDescription>At least 8 characters.</Field.FieldDescription>
          </Field.Field>
        {/if}
      </Field.FieldGroup>

      {#if data.providers.length > 0}
        <div class="flex flex-col gap-2 pt-4">
          {#each data.providers as provider (provider)}
            <Button
              variant="outline"
              href="/auth/oauth/{provider}/start?intent=login&invite={encodeURIComponent(data.token)}"
              data-sveltekit-reload
            >
              {#if provider === "github" || provider === "gitlab"}
              <ForgeIcon {provider} />
            {:else}
              <KeyRoundIcon data-icon="inline-start" />
            {/if}
              Continue with {providerLabel(provider)} instead
            </Button>
          {/each}
        </div>
      {/if}

      {#snippet actions()}
        <Button type="submit" disabled={submitting}>
          {#if submitting}
            <Spinner data-icon="inline-start" />
          {:else}
            <UserPlusIcon data-icon="inline-start" />
          {/if}
          Create account
        </Button>
      {/snippet}
    </FlowStep>
</form>
{/if}
