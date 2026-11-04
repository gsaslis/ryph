<script lang="ts">
import {
  CHATGPT_MANAGE_USAGE_URL,
  getSignInStatus,
  type SignIn,
  startSignIn,
} from "$lib/api/chatgpt-plan";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Spinner } from "$lib/components/ui/spinner";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import { SIGN_IN_POLL_MS } from "./plan-key";

// Signing in with ChatGPT: start a sign-in, open OpenAI's page in a new tab, then wait. The
// browser's return lands on the proxy's listener on this machine, which finishes it, and this
// polls until it has. The page mounts a fresh one for every opening, so a sign-in left half-done
// never comes back.
let {
  open = $bindable(),
  keyId,
  keyLabel,
  onDone,
}: {
  open: boolean;
  /** Signs this plan key in again; unset adds a new one. */
  keyId?: string;
  /** The key's name, for the title of a sign-in again. */
  keyLabel?: string;
  /** Called once a sign-in has finished, with the key it made or renewed. */
  onDone: (keyId: string) => void | Promise<void>;
} = $props();

type Phase = "start" | "waiting" | "failed" | "done";

let phase = $state<Phase>("start");
let label = $state("");
let signIn = $state<SignIn | null>(null);
let starting = $state(false);
let failure = $state<string | null>(null);
/** False when the browser blocked the new tab, so the link is the way to open it. */
let tabOpened = $state(true);

const renewing = $derived(keyId !== undefined);

async function finish(done: string) {
  await onDone(done);
  // A new sign-in says once what using the plan means; signing in again does not need to.
  if (renewing) open = false;
  else phase = "done";
}

async function begin() {
  // The tab is opened inside the click, before the request, or a popup blocker would stop it.
  const tab = window.open("", "_blank");
  starting = true;
  failure = null;
  try {
    const started = await startSignIn(
      fetch,
      renewing ? { keyId } : { label: label.trim() || undefined },
    );
    signIn = started;
    phase = "waiting";
    if (tab) {
      tab.opener = null;
      tab.location.href = started.authorizeUrl;
    } else {
      tabOpened = false;
    }
  } catch (e) {
    tab?.close();
    failure = e instanceof Error ? e.message : "Could not start the sign-in";
    phase = "failed";
  } finally {
    starting = false;
  }
}

// While the proxy listens for the browser's return, ask every few seconds whether it came.
$effect(() => {
  const current = signIn;
  if (!open || phase !== "waiting" || current === null) return;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    try {
      const status = await getSignInStatus(fetch, current.id);
      if (stopped) return;
      if (status.status === "done" && status.keyId) {
        stopped = true;
        await finish(status.keyId);
        return;
      }
      if (status.status === "failed" || status.status === "expired") {
        failure = status.status === "expired"
          ? "The sign-in timed out. Try again."
          : status.error ?? "The sign-in did not finish.";
        phase = "failed";
        return;
      }
    } catch {
      // A missed poll is not a failed sign-in; the next one asks again.
    }
    if (!stopped) timer = setTimeout(poll, SIGN_IN_POLL_MS);
  };
  timer = setTimeout(poll, SIGN_IN_POLL_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
});
</script>

<Dialog.Root bind:open>
  <Dialog.Content>
    {#if phase === "done"}
      <Dialog.Header>
        <Dialog.Title>You're using your ChatGPT plan</Dialog.Title>
        <Dialog.Description>
          Eligible usage in this app uses your ChatGPT plan. Manage usage in your
          <a
            href={CHATGPT_MANAGE_USAGE_URL}
            target="_blank"
            rel="noreferrer"
            class="text-foreground underline underline-offset-4"
          >
            ChatGPT settings</a
          >.
        </Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer>
        <Button onclick={() => (open = false)}>Got it</Button>
      </Dialog.Footer>
    {:else}
      <Dialog.Header>
        <Dialog.Title>
          {renewing ? `Sign in again to "${keyLabel ?? "ChatGPT plan"}"` : "Use your ChatGPT plan"}
        </Dialog.Title>
        <Dialog.Description>
          Agents use the usage included in your ChatGPT plan instead of paying API prices. Ryph
          can use your plan for model calls only. It can't see your chats.
        </Dialog.Description>
      </Dialog.Header>

      {#if phase === "start" || phase === "failed"}
        <Field.FieldGroup class="py-4">
          {#if !renewing}
            <Field.Field>
              <Field.FieldLabel for="plan-label">Label</Field.FieldLabel>
              <Input id="plan-label" bind:value={label} placeholder="My ChatGPT plan" />
              <Field.FieldDescription>Optional. Your name for it.</Field.FieldDescription>
            </Field.Field>
          {/if}
          {#if failure}
            <Field.FieldError>{failure}</Field.FieldError>
          {/if}
        </Field.FieldGroup>
        <Dialog.Footer>
          <Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
          <Button type="button" disabled={starting} onclick={begin}>
            {#if starting}
              <Spinner data-icon="inline-start" />
            {/if}
            Continue with ChatGPT
          </Button>
        </Dialog.Footer>
      {:else if signIn}
        <div class="text-muted-foreground flex flex-col gap-2 py-4 text-sm">
          <p class="text-foreground flex items-center gap-2">
            <Spinner />
            Waiting for you to finish signing in…
          </p>
          <p>
            {tabOpened ? "The sign-in page opened in a new tab." : "Your browser blocked the new tab."}
            <a
              href={signIn.authorizeUrl}
              target="_blank"
              rel="noreferrer"
              class="text-foreground inline-flex items-center gap-1 underline underline-offset-4"
            >
              Open the sign-in page
              <ExternalLinkIcon class="size-3" />
            </a>
          </p>
        </div>
        <Dialog.Footer>
          <Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
        </Dialog.Footer>
      {/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>
