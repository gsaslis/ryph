<script lang="ts">
/**
 * The deployment's own allowlist — what every run may reach before any agent narrows it.
 *
 * WHY ONLY TWO LISTS ARE HERE. Whether the boundary is enforced (`RYPH_EGRESS`), where the
 * proxy answers and the key it verifies with stay in the deployment's environment: an admin
 * turning the control off from inside the product it controls is a bypass wearing a form. What
 * an admin owns is the list, because that is the part which changes when a repository picks up
 * a new package manager — and while it took a redeploy, the first person to learn it was short
 * a bundle was a run dying in the middle of a setup step.
 */
import { invalidate } from "$app/navigation";
import { putEgressAllowlist } from "$lib/api/egress";
import type { EgressCeiling } from "$lib/api/types";
import TagInput from "$lib/components/tag-input/tag-input.svelte";
import * as Alert from "$lib/components/ui/alert";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Collapsible from "$lib/components/ui/collapsible";
import * as Field from "$lib/components/ui/field";
import { Label } from "$lib/components/ui/label";
import { Spinner } from "$lib/components/ui/spinner";
import { Switch } from "$lib/components/ui/switch";
import { formatDateTime } from "$lib/utils/format";
import { hostGrammarProblem, parseHosts } from "$lib/utils/egress-hosts";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import InfoIcon from "@lucide/svelte/icons/info";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import { toast } from "svelte-sonner";
import { untrack } from "svelte";

let { ceiling }: { ceiling: EgressCeiling } = $props();

// Seeded once, then the admin's to edit. `untrack` because a reload after a save must not
// reach in and rewrite a list somebody is part-way through typing — the load is invalidated
// only when the two already agree.
let bundles = $state(untrack(() => ceiling.bundles.map((b) => b.id)));
let hosts = $state<string[]>(untrack(() => [...ceiling.hosts]));
let saving = $state(false);

const problem = $derived(hosts.map(hostGrammarProblem).find((p) => p !== null) ?? null);
// What the switched-on bundles come to, so the number a run actually gets is on screen before
// it is saved rather than discovered from a failing install.
const reach = $derived([
  ...new Set([
    ...ceiling.catalogue.filter((b) => bundles.includes(b.id)).flatMap((b) => b.hosts),
    ...hosts,
  ]),
].sort());
const changed = $derived(
  ceiling.bundles.map((b) => b.id).sort().join() !== [...bundles].sort().join() ||
    ceiling.hosts.join() !== hosts.join(),
);

function setBundle(id: string, on: boolean) {
  const rest = bundles.filter((b) => b !== id);
  bundles = on ? [...rest, id] : rest;
}

// Chips go through the same normalisation the API applies — lower-cased, trailing dot dropped,
// each once — so what is shown is what is saved.
function setHosts(next: string[]) {
  hosts = parseHosts(next.join(","));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function save() {
  if (problem !== null) {
    toast.error(problem);
    return;
  }
  saving = true;
  try {
    await putEgressAllowlist({ bundles: [...bundles].sort(), hosts });
    toast.success("Allowlist saved — it binds the next run to start");
    await invalidate("app:platform");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to save the allowlist");
  } finally {
    saving = false;
  }
}
</script>

<!-- A bundle's hosts, folded under its row: the count is what most people need, the names are
     there for the one checking a specific registry. -->
{#snippet hostList(list: string[])}
  <Collapsible.Root class="group/hosts flex flex-col gap-2">
  <Collapsible.Trigger
    class="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1 text-xs transition-colors"
  >
      <ChevronRightIcon
        class="size-3.5 transition-transform group-data-[state=open]/hosts:rotate-90"
      />
      {plural(list.length, "host")}
    </Collapsible.Trigger>
  <Collapsible.Content>
    <ul
      class="text-muted-foreground grid gap-x-6 gap-y-1 font-mono text-xs sm:grid-cols-2 lg:grid-cols-3"
    >
        {#each list as host (host)}
          <li class="truncate" title={host}>{host}</li>
        {/each}
      </ul>
  </Collapsible.Content>
</Collapsible.Root>
{/snippet}

{#if ceiling.mode === "open"}
  <Alert.Root>
  <InfoIcon />
  <Alert.Title>Runs have the open internet</Alert.Title>
  <Alert.Description>
      This deployment claims no boundary, so an allowlist here would not be enforced. Set
      <code>RYPH_EGRESS=proxy</code> with an egress proxy first.
    </Alert.Description>
</Alert.Root>
{:else}
  <Field.FieldGroup>
    {#if !ceiling.wired}
      <Alert.Root variant="destructive">
        <TriangleAlertIcon />
        <Alert.Title>Runs currently reach nothing</Alert.Title>
        <Alert.Description>
          The allowlist is claimed but not wired — no egress key or no proxy address — so runs
          reach nothing, whatever is switched on below. Set <code>RYPH_EGRESS_KEY</code> and
          <code>RYPH_EGRESS_PROXY_URL</code>.
        </Alert.Description>
      </Alert.Root>
    {/if}

    <Field.FieldSet>
      <Field.FieldLegend variant="label">Bundles</Field.FieldLegend>
      <Field.FieldDescription>
        Curated sets of hosts a toolchain needs to install and build.
      </Field.FieldDescription>
      <div class="divide-y rounded-lg border">
        {#each ceiling.catalogue as bundle (bundle.id)}
          <div class="flex flex-col gap-3 px-4 py-3">
            <div class="flex items-center justify-between gap-6">
              <div class="flex min-w-0 flex-col gap-0.5">
                <Label for="ceiling-bundle-{bundle.id}">{bundle.name}</Label>
                <span
                  id="ceiling-bundle-{bundle.id}-description"
                  class="text-muted-foreground line-clamp-2 text-xs"
                  title={bundle.description}
                >
                  {bundle.description}
                </span>
              </div>
              <Switch
                id="ceiling-bundle-{bundle.id}"
                aria-describedby="ceiling-bundle-{bundle.id}-description"
                checked={bundles.includes(bundle.id)}
                onCheckedChange={(on) => setBundle(bundle.id, on)}
              />
            </div>
            {@render hostList(bundle.hosts)}
          </div>
        {:else}
          <p class="text-muted-foreground px-4 py-3 text-sm">
            This deployment's catalogue has no bundles.
          </p>
        {/each}
      </div>
    </Field.FieldSet>

    <Field.Field data-invalid={problem !== null || undefined}>
      <Field.FieldLabel for="ceiling-hosts">Additional hosts</Field.FieldLabel>
      <TagInput
        id="ceiling-hosts"
        placeholder="Type a hostname and press Enter"
        aria-invalid={problem !== null || undefined}
        bind:tags={() => hosts, setHosts}
      />
      {#if problem !== null}
        <Field.FieldError>{problem}</Field.FieldError>
      {/if}
      <Field.FieldDescription>
        Hostnames on top of the bundles, <code>*.example.com</code> included. Whoever adds one
        owns what it lets through.
      </Field.FieldDescription>
    </Field.Field>

    {#if reach.length > 0}
      <Collapsible.Root class="group/reach flex flex-col gap-3">
        <Collapsible.Trigger
          class="hover:text-foreground flex w-fit cursor-pointer items-center gap-1 text-sm font-medium transition-colors"
        >
          <ChevronRightIcon
            class="text-muted-foreground size-4 transition-transform group-data-[state=open]/reach:rotate-90"
          />
          What that comes to
          <span class="text-muted-foreground font-normal">
            · {plural(reach.length, "host")} in all
          </span>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div class="flex flex-wrap gap-1">
            {#each reach as host (host)}
              <Badge variant="outline" class="font-mono">{host}</Badge>
            {/each}
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    {:else}
      <Alert.Root variant="destructive">
        <TriangleAlertIcon />
        <Alert.Title>No internet host at all</Alert.Title>
        <Alert.Description>
          Nothing is switched on, so every run reaches nothing. That is a real setting, but a
          repository that installs dependencies will fail.
        </Alert.Description>
      </Alert.Root>
    {/if}

    <div class="flex items-center justify-between gap-4">
      <span class="text-muted-foreground text-xs">
        {#if ceiling.source === "admin" && ceiling.updatedAt}
          Last changed here {formatDateTime(ceiling.updatedAt)}.
        {:else}
          Seeded from this deployment's environment. Saving here takes ownership of it, and a
          later redeploy no longer moves it.
        {/if}
      </span>
      <Button onclick={save} disabled={saving || !changed || problem !== null}>
        {#if saving}<Spinner data-icon="inline-start" />{/if}
        Save allowlist
      </Button>
    </div>
  </Field.FieldGroup>
{/if}
