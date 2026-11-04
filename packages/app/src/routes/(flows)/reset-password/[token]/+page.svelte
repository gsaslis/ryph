<script lang="ts">
import { goto } from "$app/navigation";
import { page } from "$app/state";
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Spinner } from "$lib/components/ui/spinner";
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import { toast } from "svelte-sonner";

let password = $state("");
let submitting = $state(false);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  submitting = true;
  try {
    const token = encodeURIComponent(page.params.token ?? "");
    const res = await fetch(`/api/v1/auth/password/reset/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "Could not set the password");
      return;
    }
    toast.success("Password set — sign in with it");
    await goto("/login");
  } catch {
    toast.error("Failed to reach the server");
  } finally {
    submitting = false;
  }
}
</script>

<svelte:head>
  <title>Set a new password · Ryph</title>
</svelte:head>

<form onsubmit={submit}>
  <FlowStep
    headline="Set a new password"
    description="Every other session on your account is signed out once it is set."
  >
    <Field.FieldGroup>
      <Field.Field>
        <Field.FieldLabel for="password">New password</Field.FieldLabel>
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
        Set password
      </Button>
    {/snippet}
  </FlowStep>
</form>
