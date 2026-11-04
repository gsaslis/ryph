<script lang="ts">
import type { SkillPresentation } from "$lib/api/types";
import SkillMark from "$lib/components/skill-mark/skill-mark.svelte";
import * as Card from "$lib/components/ui/card";
import { cn } from "$lib/utils";
import {
  hasBrandColor,
  skillSummary,
  skillTint,
  skillTitle,
  titleIsName,
} from "$lib/utils/skill-presentation";
import type { Snippet } from "svelte";

let {
  id,
  name,
  description,
  presentation,
  href,
  off = false,
  meta,
  control,
}: {
  /** Names the card's summary and facts `{id}-description` and `{id}-meta`, so the control can
   * be described by them as well as named. */
  id?: string;
  name: string;
  description: string;
  presentation: SkillPresentation | null;
  /** The skill's own page. The whole card opens it. */
  href: string;
  /** Turned off where this card is shown: everything but the control dims. */
  off?: boolean;
  /** Small facts before the author: its version digest, a warning count. */
  meta?: Snippet;
  /** The switch, or whatever acts on the skill, in the card's corner. */
  control?: Snippet;
} = $props();

const skill = $derived({ name, description, presentation });
const title = $derived(skillTitle(skill));
const summary = $derived(skillSummary(skill));
const branded = $derived(hasBrandColor(presentation));
</script>

<!-- One skill as a card, as the agents and tool servers are: its mark, the name a person reads,
     the real name agents and the agent editor use, a line about it and a few facts. The title is
     the link and its ::after covers the card (`relative` anchors it); it comes before the control
     in reading order, and the control sits above that layer, as does a fact that explains itself
     on hover. A brand colour tints the card as a catalogue server's does; without one it stays
     grey. -->
<Card.Root
  size="sm"
  class={cn(
    "to-card relative min-w-0 flex-1 hover:ring-foreground/25 has-[a:focus-visible]:ring-ring/50 bg-linear-to-t transition-[box-shadow] has-[a:focus-visible]:ring-[3px]",
    branded ? "from-(--tint)/15" : "from-foreground/5",
  )}
  style={branded ? `--tint: ${skillTint(name, presentation?.brandColor)}` : undefined}
>
  <Card.Header>
    <!-- Dimmed by colour, not opacity, from the link on: anything after the link with opacity under
         1 paints over its full-card overlay, and clicks there stop opening the skill. The mark comes
         before the link, so it can fade. -->
    <div class="flex min-w-0 flex-col gap-4">
      <SkillMark
        {name}
        {title}
        {presentation}
        class={cn("size-12 rounded-lg transition-opacity", off && "opacity-60")}
      />
      <div class="flex min-w-0 flex-col gap-1">
        <Card.Title
          class={cn("wrap-anywhere", titleIsName(skill) && "font-mono", off && "text-foreground/60")}
        >
          <a
            {href}
            class="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          >
            {title}
          </a>
        </Card.Title>
        {#if !titleIsName(skill)}
          <span
            class={cn(
              "text-muted-foreground font-mono text-xs wrap-anywhere",
              off && "text-muted-foreground/60",
            )}
          >{name}</span>
        {/if}
      </div>
    </div>
    {#if control}
      <Card.Action class="relative z-10 flex items-center gap-2">
        {@render control()}
      </Card.Action>
    {/if}
  </Card.Header>
  <Card.Content class="flex flex-1 flex-col gap-3">
    <Card.Description
      id={id ? `${id}-description` : undefined}
      class={cn("line-clamp-2 text-pretty", off && "text-muted-foreground/60")}
    >
      {summary}
    </Card.Description>
    {#if meta || presentation?.author}
      <div
        id={id ? `${id}-meta` : undefined}
        class={cn(
          "text-muted-foreground mt-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs",
          // An outline badge sets its own colour, so the meta's colour misses it; a badge that sits
          // above the link to keep its hover title (the warnings) stays at full strength.
          off && "text-muted-foreground/60 [&_[data-slot=badge]:not(.relative)]:text-muted-foreground/60",
        )}
      >
        {@render meta?.()}
        {#if presentation?.author}
          <span class="wrap-anywhere">By {presentation.author}</span>
        {/if}
      </div>
    {/if}
  </Card.Content>
</Card.Root>
