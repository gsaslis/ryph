<script lang="ts">
import type { SkillPresentation } from "$lib/api/types";
import { cn } from "$lib/utils";
import {
  hasBrandColor,
  iconIsMask,
  skillIconSrc,
  skillMonogram,
  skillTint,
} from "$lib/utils/skill-presentation";

let {
  name,
  title,
  presentation,
  large = false,
  class: className,
}: {
  /** The skill's name: what the fallback tint is picked by. */
  name: string;
  /** What the monogram is taken from: the display name, or the name. */
  title: string;
  presentation: SkillPresentation | null;
  /** The large icon, for the skill's own page; the small one when only that came. */
  large?: boolean;
  /** The tile's size and corners. Everything inside scales with it. */
  class?: string;
} = $props();

const icon = $derived(
  (large ? presentation?.iconLarge ?? presentation?.iconSmall : presentation?.iconSmall) ?? null,
);
const tint = $derived(skillTint(name, presentation?.brandColor));
const monogram = $derived(skillMonogram(title));
</script>

<!-- A skill's mark in a tile. An icon is only ever an image: a raster one as itself, an SVG as a
     mask filled with a theme colour, or its brand colour shifted toward the text colour, so it
     reads in light and dark alike. Without an icon, a monogram on a tint of the same colour. -->
<span
  aria-hidden="true"
  class={cn(
    "@container ring-border flex shrink-0 items-center justify-center overflow-hidden ring-1 select-none",
    icon ? "bg-background" : "monogram",
    className,
  )}
  style:--tint={tint}
  style:--ink={icon && !hasBrandColor(presentation)
  ? "var(--foreground)"
  : "color-mix(in oklab, var(--tint) 55%, var(--foreground))"}
>
  {#if icon && iconIsMask(icon)}
    <span class="mask size-[56%]" style:--icon={`url("${skillIconSrc(icon)}")`}></span>
  {:else if icon}
    <img src={skillIconSrc(icon)} alt="" class="size-[64%] object-contain" />
  {:else}
    <span
      class={[
        "font-heading leading-none font-bold tracking-tight",
        monogram.length > 1 ? "text-[34cqw]" : "text-[42cqw]",
      ]}
    >
      {monogram}
    </span>
  {/if}
</span>

<style>
.monogram {
  background-color: color-mix(in oklab, var(--tint) 30%, var(--background));
  color: var(--ink);
}

.mask {
  background-color: var(--ink);
  -webkit-mask: var(--icon) center / contain no-repeat;
  mask: var(--icon) center / contain no-repeat;
}
</style>
