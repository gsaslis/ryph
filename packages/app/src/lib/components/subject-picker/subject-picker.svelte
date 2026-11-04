<!--
  What a memory is about: the org, or one repository by URL. The same two fields wherever a
  subject is chosen — writing a memory, ingesting a document, correcting either — so a wrong
  guess is fixed the way it was made. Any spelling of the URL; the service stores it canonical.
-->
<script lang="ts">
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import * as Select from "$lib/components/ui/select";

let {
  id,
  subject = $bindable("org"),
  repoUrl = $bindable(""),
  suggestions = [],
}: {
  /** Prefix for the fields' ids, unique on the page. */
  id: string;
  /** "org" or "repo". */
  subject?: string;
  repoUrl?: string;
  /** Repositories the canon already knows, offered as completions. */
  suggestions?: string[];
} = $props();
</script>

<Field.Field>
  <Field.FieldLabel for="{id}-subject">About</Field.FieldLabel>
  <Select.Root type="single" bind:value={subject}>
    <Select.Trigger id="{id}-subject" class="w-full">
      {subject === "org" ? "The org" : "One repository"}
    </Select.Trigger>
    <Select.Content>
      <Select.Group>
        <Select.Item value="org" label="The org" />
        <Select.Item value="repo" label="One repository" />
      </Select.Group>
    </Select.Content>
  </Select.Root>
</Field.Field>
{#if subject === "repo"}
  <Field.Field>
    <Field.FieldLabel for="{id}-repo">Repository</Field.FieldLabel>
    <Input
      id="{id}-repo"
      required
      bind:value={repoUrl}
      list={suggestions.length > 0 ? `${id}-repos` : undefined}
      placeholder="https://github.com/acme/app"
    />
    {#if suggestions.length > 0}
      <datalist id="{id}-repos">
        {#each suggestions as url (url)}
          <option value={url}></option>
        {/each}
      </datalist>
    {/if}
    <Field.FieldDescription>Any spelling of the URL; it is stored in its canonical form.</Field.FieldDescription>
  </Field.Field>
{/if}
