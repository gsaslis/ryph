<script lang="ts">
import { goto, invalidate } from "$app/navigation";
import { page } from "$app/state";
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Spinner } from "$lib/components/ui/spinner";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import { toast } from "svelte-sonner";

let name = $state("");
let password = $state("");
let submitting = $state(false);
let dead = $state<string | null>(null);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  submitting = true;
  try {
    const token = encodeURIComponent(page.params.token ?? "");
    const res = await fetch(`/auth/verify/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, password }),
    });
    if (res.status === 410) {
      const body = await res.json().catch(() => null);
      dead = body?.message ?? "this link is no longer valid";
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.message ?? "Could not set the password");
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
  <title>Finish signing up · Ryph</title>
</svelte:head>

{#if dead !== null}
  <FlowStep
  headline="This link did not work"
  description="It may have expired, been used already, or been replaced by a newer one. Registering the same address again sends a fresh one."
>
    <p class="text-destructive text-sm">{dead}</p>

    {#snippet actions()}
      <Button href="/register">
        <ArrowRightIcon data-icon="inline-start" />
        Register again
      </Button>
    {/snippet}
  </FlowStep>
{:else}
  <form onsubmit={submit}>
  <FlowStep
    headline="Finish signing up"
    description="Opening this link proves the address is yours. Say who you are, set a password, and you are signed in."
  >
      <Field.FieldGroup>
        <Field.Field>
          <Field.FieldLabel for="name">Name</Field.FieldLabel>
          <Input id="name" autocomplete="name" required bind:value={name} placeholder="Ada Lovelace" />
        </Field.Field>
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
      </Field.FieldGroup>

      {#snippet actions()}
        <Button type="submit" disabled={submitting}>
          {#if submitting}
            <Spinner data-icon="inline-start" />
          {:else}
            <KeyRoundIcon data-icon="inline-start" />
          {/if}
          Set password and sign in
        </Button>
      {/snippet}
    </FlowStep>
</form>
{/if}
