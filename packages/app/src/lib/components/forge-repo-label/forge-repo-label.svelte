<script lang="ts">
import type { ForgeProvider } from "$lib/api/types";
import CopyButton from "$lib/components/copy-button/copy-button.svelte";
import { forgeRepoLabel, providerOfRepoRef } from "$lib/utils/forge";

let {
  repoRef,
  provider,
  name = null,
  copy = false,
  fallback = null,
  class: className = "",
}: {
  /** The repo's address on its forge; null where the row only knows an id. */
  repoRef: string | null;
  /** Read from the connected repo where there is one; otherwise inferred from the address, which
   * never answers GitLab: a GitLab row must pass its provider. */
  provider?: ForgeProvider;
  /** Radicle names its repos in the identity document; GitHub's and GitLab's name is the
   * address. */
  name?: string | null;
  /** Offer the full address to the clipboard — worth it wherever a person may have to paste it. */
  copy?: boolean;
  /** What to show when the address is unknown: an id, usually. */
  fallback?: string | null;
  class?: string;
} = $props();

const resolved = $derived(provider ?? (repoRef ? providerOfRepoRef(repoRef) : "github"));
const label = $derived(
  repoRef === null
    ? (fallback ?? "unknown repository")
    : forgeRepoLabel({ provider: resolved, repoRef, name }),
);
// A shortened RID is not the address — the whole thing is a hover away, and a copy away when a
// screen expects it to be pasted back into a terminal. A local path is shown whole but may be
// truncated by the line, so it gets the same treatment.
const full = $derived(
  (resolved === "radicle" || resolved === "local") && repoRef !== null ? repoRef : null,
);
const copyLabel = $derived(resolved === "local" ? "Copy the path" : "Copy the repository id");
const copied = $derived(resolved === "local" ? "Path copied" : "Repository id copied");
</script>

<span class="inline-flex min-w-0 items-center gap-1 {className}">
  <!-- A nested GitLab path can outgrow the line, so it is a hover away too. -->
  <span class="truncate" title={full ?? (resolved === "gitlab" ? label : undefined)}>{label}</span>
  {#if copy && full}
    <CopyButton value={full} label={copyLabel} what={copied} />
  {/if}
</span>
