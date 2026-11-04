<script lang="ts">
import FlowStep from "$lib/components/flow-step/flow-step.svelte";
import { Button } from "$lib/components/ui/button";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Spinner } from "$lib/components/ui/spinner";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
import MailIcon from "@lucide/svelte/icons/mail";
import { toast } from "svelte-sonner";

let email = $state("");
let submitting = $state(false);
let sent = $state(false);

async function submit(event: SubmitEvent) {
  event.preventDefault();
  submitting = true;
  try {
    const res = await fetch("/api/v1/auth/password/forgot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "Could not send the link");
      return;
    }
    sent = true;
  } catch {
    toast.error("Failed to reach the server");
  } finally {
    submitting = false;
  }
}
</script>

<svelte:head>
  <title>Forgot password · Ryph</title>
</svelte:head>

{#if sent}
  <FlowStep
  headline="Check your inbox"
  description="If {email} has an account here, a reset link is on its way. On an instance that cannot send mail, an admin will hand it to you instead. An owner's password can't be reset this way."
>
    {#snippet actions()}
      <Button href="/login">
        <ArrowRightIcon data-icon="inline-start" />
        Back to sign-in
      </Button>
    {/snippet}
  </FlowStep>
{:else}
  <form onsubmit={submit}>
  <FlowStep
    headline="Forgot your password?"
    description="Enter your address and we send a link to set a new one."
  >
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
      </Field.FieldGroup>

      {#snippet leftActions()}
        <p class="text-muted-foreground text-sm">
          <a href="/login" class="underline underline-offset-4">Back to sign-in</a>
        </p>
      {/snippet}

      {#snippet actions()}
        <Button type="submit" disabled={submitting}>
          {#if submitting}
            <Spinner data-icon="inline-start" />
          {:else}
            <MailIcon data-icon="inline-start" />
          {/if}
          Send reset link
        </Button>
      {/snippet}
    </FlowStep>
</form>
{/if}
