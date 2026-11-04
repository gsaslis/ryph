<script lang="ts">
import type { SkillPresentation } from "$lib/api/types";
import ObjectHeader from "$lib/components/object-header/object-header.svelte";
import SkillMark from "$lib/components/skill-mark/skill-mark.svelte";
import { skillSummary, skillTitle, titleIsName } from "$lib/utils/skill-presentation";
import type { Snippet } from "svelte";

let {
  name,
  description,
  presentation,
  summary: summaryOverride,
  tags,
  actions,
}: {
  name: string;
  description: string;
  presentation: SkillPresentation | null;
  /** The line under the title in place of the skill's own: an older version's description. */
  summary?: string;
  /** Beside the title: where the skill comes from, whether it is on. */
  tags?: Snippet;
  actions?: Snippet;
} = $props();

const skill = $derived({ name, description, presentation });
const title = $derived(skillTitle(skill));
</script>

<!-- The head of a skill's page: its large mark, the name a person reads and the name agents use
     when the two differ, its line, and who wrote it. The author's own version string is a fact
     below, never a version badge: the skills pages name versions by digest. -->
<ObjectHeader {title} {actions} badge={tags}>
  {#snippet mark()}
    <SkillMark
      large
      {name}
      {title}
      {presentation}
      class="size-11 rounded-lg @2xl:size-14 @2xl:rounded-xl"
    />
  {/snippet}
  {#if !titleIsName(skill)}
    <p class="text-muted-foreground font-mono text-sm wrap-anywhere">{name}</p>
  {/if}
  <p class="text-muted-foreground max-w-3xl text-sm text-pretty">
    {summaryOverride ?? skillSummary(skill)}
  </p>
  {#if presentation?.author}
    <p class="text-muted-foreground text-xs wrap-anywhere">By {presentation.author}</p>
  {/if}
</ObjectHeader>
