<script lang="ts">
import SkillFacts from "$lib/components/skill-facts/skill-facts.svelte";
import SkillFiles from "$lib/components/skill-files/skill-files.svelte";
import SkillExamplePrompt from "$lib/components/skill-header/skill-example-prompt.svelte";
import SkillHeader from "$lib/components/skill-header/skill-header.svelte";
import { Badge } from "$lib/components/ui/badge";
import { presentationFacts, skillTitle } from "$lib/utils/skill-presentation";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const skill = $derived(data.skill);
</script>

<svelte:head>
  <title>{skillTitle(skill)} · Skills · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-8">
  <SkillHeader name={skill.name} description={skill.description} presentation={skill.presentation}>
    {#snippet tags()}
      <Badge variant="secondary">Ryph</Badge>
      {#if !skill.enabled}
        <Badge variant="outline">Off for every agent</Badge>
      {/if}
    {/snippet}
  </SkillHeader>

  {#if skill.presentation?.defaultPrompt}
    <SkillExamplePrompt prompt={skill.presentation.defaultPrompt} />
  {/if}

  <SkillFacts
    digest={skill.digest}
    bytes={skill.bytes}
    frontmatter={skill.frontmatter}
    extra={presentationFacts(skill)}
  />

  <section class="flex flex-col gap-3" aria-labelledby="files-title">
    <h2 id="files-title" class="text-sm font-semibold">Files</h2>
    <SkillFiles files={data.files} />
  </section>
</div>
