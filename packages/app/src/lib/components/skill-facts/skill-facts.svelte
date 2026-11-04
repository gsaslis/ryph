<script lang="ts" module>
/** A fact a page adds after the version: where the version came from, say. */
export type ExtraFact = { term: string; value: string; href?: string | null; mono?: boolean };
</script>

<script lang="ts">
import type { SkillFrontmatter } from "$lib/api/types";
import CopyButton from "$lib/components/copy-button/copy-button.svelte";
import { Badge } from "$lib/components/ui/badge";
import { formatBytes } from "$lib/utils/environments";
import { shortDigest } from "$lib/utils/skills";
import type { Snippet } from "svelte";

let {
  digest,
  bytes = null,
  frontmatter,
  extra = [],
}: {
  digest: string;
  /** The skill's size; null where the answer does not carry it. */
  bytes?: number | null;
  frontmatter: SkillFrontmatter;
  extra?: ExtraFact[];
} = $props();

const metadata = $derived(
  Object.entries(frontmatter.metadata ?? {}).sort(([a], [b]) => a.localeCompare(b)),
);
</script>

{#snippet row(term: string, body: Snippet)}
  <div class="flex flex-col gap-0.5 py-2 text-sm @lg:flex-row @lg:items-baseline @lg:gap-4">
  <dt class="text-muted-foreground shrink-0 @lg:w-40">{term}</dt>
  <dd class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">{@render body()}</dd>
</div>
{/snippet}

<!-- What a skill says about itself beyond its name and description, and which version this is.
     The optional fields are shown as written; none of them changes what an agent may do. -->
<dl class="@container divide-y">
  {#snippet version()}
    <span class="font-mono text-xs" title={digest}>{shortDigest(digest)}</span>
    <CopyButton value={digest} size="icon-sm" label="Copy the full version" what="Version copied" />
  {/snippet}
  {@render row("Version", version)}
  {#if bytes !== null}
    {#snippet size()}{formatBytes(bytes ?? 0)}{/snippet}
    {@render row("Size", size)}
  {/if}
  {#each extra as fact (fact.term)}
    {#snippet value()}
      {#if fact.href}
        <a
          href={fact.href}
          target="_blank"
          rel="noreferrer noopener"
          class={["underline-offset-4 hover:underline", fact.mono && "font-mono text-xs"]}
        >{fact.value}</a>
      {:else}
        <span class={[fact.mono && "font-mono text-xs"]}>{fact.value}</span>
      {/if}
    {/snippet}
    {@render row(fact.term, value)}
  {/each}
  {#if frontmatter.license}
    {#snippet license()}{frontmatter.license}{/snippet}
    {@render row("License", license)}
  {/if}
  {#if frontmatter.compatibility}
    {#snippet compatibility()}{frontmatter.compatibility}{/snippet}
    {@render row("Compatibility", compatibility)}
  {/if}
  {#if frontmatter.allowedTools}
    {#snippet allowedTools()}
      <span class="font-mono text-xs">{frontmatter.allowedTools}</span>
      <Badge variant="outline">Not enforced</Badge>
      <span class="text-muted-foreground basis-full text-xs">Agents can still use any tool they're given.</span>
    {/snippet}
    {@render row("Allowed tools", allowedTools)}
  {/if}
  {#each metadata as [key, value] (key)}
    {#snippet entry()}{value}{/snippet}
    {@render row(key, entry)}
  {/each}
</dl>
