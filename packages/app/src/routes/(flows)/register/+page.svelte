<script lang="ts">
import { goto, invalidate } from "$app/navigation";
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Spinner } from "$lib/components/ui/spinner";
import UserPlusIcon from "@lucide/svelte/icons/user-plus";
import { toast } from "svelte-sonner";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

let name = $state("");
let email = $state("");
let password = $state("");
// Seeded once from the link the server log prints; editable after.
// svelte-ignore state_referenced_locally
let setupToken = $state(data.setupToken);
let submitting = $state(false);
let registered = $state(false);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  submitting = true;

  try {
    const res = await fetch("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        data.bootstrap ? { name, email, password, setupToken: setupToken.trim() } : { email },
      ),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.message ?? "Failed to create user");
      return;
    }

    if (res.status === 202) {
      registered = true;
      return;
    }
    await invalidate("app:user");
    // The instance's first account is its owner, and a fresh instance starts in the welcome flow.
    await goto(data.bootstrap ? "/welcome" : "/agents");
  } catch {
    toast.error("Failed to reach the server");
  } finally {
    submitting = false;
  }
}
</script>

<svelte:head>
  <title>Create account · Ryph</title>
</svelte:head>

{#if registered}
  <FlowStep
  headline="Check your inbox"
  description={data.mailerConfigured
      ? `A link is on its way to ${email}. Open it to choose your name and password. Already registered with this address? Sign in instead.`
      : `This instance cannot send mail, so an admin has to hand you your sign-up link; they find it on their Users page. Open it to choose your name and password. Already registered with this address? Sign in instead.`}
>
    {#snippet actions()}
      <Button href="/login">
        <UserPlusIcon data-icon="inline-start" />
        Go to sign-in
      </Button>
    {/snippet}
  </FlowStep>
{:else}
<form onsubmit={submit}>
  <FlowStep
    headline={data.bootstrap ? "Create the admin account" : "Create an account"}
    description={data.bootstrap
      ? "Set up the first account for this Ryph instance. It becomes the admin."
      : "Registration is open on this instance. Your name and password come next, from the link we send you."}
  >
    <Field.FieldGroup>
      {#if data.bootstrap}
        <Field.Field>
          <Field.FieldLabel for="setup-token">Setup token</Field.FieldLabel>
          <Input
            id="setup-token"
            autocomplete="off"
            spellcheck={false}
            required
            bind:value={setupToken}
            class="font-mono"
          />
          <Field.FieldDescription>Printed in the server log when Ryph starts.</Field.FieldDescription>
        </Field.Field>
      {/if}
      {#if data.bootstrap}
        <Field.Field>
          <Field.FieldLabel for="name">Name</Field.FieldLabel>
          <Input id="name" autocomplete="name" required bind:value={name} placeholder="Ada Lovelace" />
        </Field.Field>
      {/if}
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
      {#if data.bootstrap}
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

    {#snippet leftActions()}
      <p class="text-muted-foreground text-sm">
        Already have an account? <a href="/login" class="underline underline-offset-4">Log in</a>
      </p>
    {/snippet}

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
