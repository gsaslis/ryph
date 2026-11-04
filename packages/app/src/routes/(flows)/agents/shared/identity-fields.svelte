<script lang="ts">
import { page } from "$app/state";
import * as Collapsible from "$lib/components/ui/collapsible";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import { defaultAgentEmail } from "./agent-steps";

let {
  name = $bindable(),
  handle = $bindable(),
  email = $bindable(),
}: {
  name: string;
  /** "" = let the server derive one from the name. */
  handle: string;
  /** "" = the default, the handle at this deployment's host. */
  email: string;
} = $props();

// The host the app is served at is the deployment's address — `ryph.example.com` — and the same
// on the server and in the browser, so the default reads the same in both renders.
const defaultEmail = $derived(defaultAgentEmail(name, handle, page.url.hostname));

// The email has a default almost nobody changes, so it starts folded; an editor whose agent has
// another sees it open, since a hidden non-default would read as "the default".
// svelte-ignore state_referenced_locally
let advancedOpen = $state(email.trim() !== "" && email.trim() !== defaultEmail);
</script>

<Field.FieldGroup>
  <Field.Field>
    <Field.FieldLabel for="name">Name</Field.FieldLabel>
    <Input id="name" required bind:value={name} placeholder="Ada" />
    <Field.FieldDescription>Shown as the author of the agent's commits.</Field.FieldDescription>
  </Field.Field>
  <Field.Field>
    <Field.FieldLabel for="handle">Handle</Field.FieldLabel>
    <Input
      id="handle"
      bind:value={handle}
      placeholder="ada"
      pattern="[a-z0-9][a-z0-9\-]*"
      maxlength={39}
    />
    <Field.FieldDescription>
      The agent's handle for slash commands. <code>/ryph {handle.trim() || "ada"} …</code> in a forge
      issue assigns it work. Lowercase letters, digits and dashes.
    </Field.FieldDescription>
  </Field.Field>
  <Collapsible.Root bind:open={advancedOpen} class="group/advanced flex flex-col gap-4">
    <Collapsible.Trigger
      class="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1 text-sm transition-colors"
    >
      <ChevronRightIcon
        class="size-4 transition-transform group-data-[state=open]/advanced:rotate-90"
      />
      Advanced
    </Collapsible.Trigger>
    <Collapsible.Content>
      <Field.Field>
        <Field.FieldLabel for="email">Email</Field.FieldLabel>
        <Input
          id="email"
          type="email"
          bind:value={email}
          placeholder={defaultEmail ?? `ada@${page.url.hostname}`}
        />
        <Field.FieldDescription>
          Used for the agent's git identity. Leave empty for
          {#if defaultEmail}<code>{defaultEmail}</code>{:else}the handle at {page.url.hostname}{/if}.
        </Field.FieldDescription>
      </Field.Field>
    </Collapsible.Content>
  </Collapsible.Root>
</Field.FieldGroup>
