<script lang="ts">
import type { EgressState } from "$lib/api/egress";
import type { EgressBundle, EgressCeiling } from "$lib/api/types";
import * as Alert from "$lib/components/ui/alert";
import { Badge } from "$lib/components/ui/badge";
import { Checkbox } from "$lib/components/ui/checkbox";
import * as Collapsible from "$lib/components/ui/collapsible";
import * as Field from "$lib/components/ui/field";
import { Label } from "$lib/components/ui/label";
import { Switch } from "$lib/components/ui/switch";
import { parseHosts } from "$lib/utils/egress-hosts";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import InfoIcon from "@lucide/svelte/icons/info";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import { grantedHosts, type NetworkFields, networkPolicyToFields } from "./network-policy";
import ToggleRow from "$lib/components/toggle-row/toggle-row.svelte";

let {
  fields = $bindable(),
  ceiling,
  egressState,
  canGrant,
}: {
  /** The two modes and their lists; "deployment" saves as no policy at all. */
  fields: NetworkFields;
  /** What this deployment allows, or null when it could not be read. */
  ceiling: EgressCeiling | null;
  egressState: EgressState;
  /** Whether this user may change it — an admin's call in BOTH directions here, because
   * clearing the policy widens the agent's reach rather than narrowing it. */
  canGrant: boolean;
} = $props();

const editable = $derived(egressState === "on" && canGrant);
const narrowed = $derived(fields.mode === "narrowed");
const hosts = $derived(grantedHosts(fields, ceiling));

// The hosts the fields name one by one, as a list; the field itself stays the comma-separated
// string the policy bridge reads. A named host is always one the deployment already allows —
// picked out of a bundle that is switched off, or one an administrator listed — so this can
// only ever narrow: an agent gets a subset of the allowlist, never more.
const namedHosts = $derived(parseHosts(fields.hosts));
// Named hosts that no row here accounts for — set through the API, say, as a name under one of
// the deployment's wildcards. Shown so they can be taken back; nothing here adds one.
const strayHosts = $derived.by(() => {
  const known = new Set([
    ...(ceiling?.hosts ?? []),
    ...(ceiling?.bundles ?? []).flatMap((b) => b.hosts),
  ]);
  return namedHosts.filter((h) => !known.has(h));
});

function setNarrowed(on: boolean) {
  if (!on) {
    fields = networkPolicyToFields(null);
    return;
  }
  // Narrowing starts from everything the deployment allows, so the first switch off is the
  // first real narrowing rather than a list that begins at nothing.
  fields = {
    mode: "narrowed",
    bundles: (ceiling?.bundles ?? []).map((b) => b.id),
    hosts: (ceiling?.hosts ?? []).join(", "),
  };
}

function setBundle(bundle: EgressBundle, on: boolean) {
  const rest = fields.bundles.filter((b) => b !== bundle.id);
  fields.bundles = on ? [...rest, bundle.id] : rest;
  // The whole bundle covers its hosts, so names picked out of it while it was off are folded
  // back in; switching it off again starts from none of them.
  if (on) {
    fields.hosts = namedHosts
      .filter((h) => !bundle.hosts.includes(h))
      .join(", ");
  }
}

function setHost(host: string, on: boolean) {
  const rest = namedHosts.filter((h) => h !== host);
  fields.hosts = (on ? [...rest, host] : rest).join(", ");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
</script>

<!-- A bundle's hosts, folded under its row: the count is what most people need, the names are
     there for the one checking a specific registry. With the bundle switched off, each host can
     be picked on its own — a finer narrowing than the whole bundle. -->
{#snippet hostList(id: string, list: string[], pickable: boolean)}
  {@const picked = pickable
    ? list.filter((h) => namedHosts.includes(h)).length
    : 0}
  <Collapsible.Root class="group/hosts flex flex-col gap-2">
  <Collapsible.Trigger
    class="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1 text-xs transition-colors"
  >
      <ChevronRightIcon
        class="size-3.5 transition-transform group-data-[state=open]/hosts:rotate-90"
      />
      {#if pickable && picked > 0}
        {picked} of {plural(list.length, "host")} allowed
      {:else}
        {plural(list.length, "host")}
      {/if}
    </Collapsible.Trigger>
  <Collapsible.Content>
      {#if pickable}
        <div class="flex flex-col gap-2">
          <p class="text-muted-foreground text-xs">
            The bundle is off; allow any of its hosts on their own.
          </p>
          <ul class="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {#each list as host (host)}
              <li class="flex items-center gap-2">
                <Checkbox
                  id="host-{id}-{host}"
                  disabled={!editable}
                  checked={namedHosts.includes(host)}
                  onCheckedChange={(checked) => setHost(host, checked === true)}
                />
                <Label
                  for="host-{id}-{host}"
                  class="truncate font-mono text-xs font-normal"
                >
                  {host}
                </Label>
              </li>
            {/each}
          </ul>
        </div>
      {:else}
        <ul
          class="text-muted-foreground grid gap-x-6 gap-y-1 font-mono text-xs sm:grid-cols-2 lg:grid-cols-3"
        >
          {#each list as host (host)}
            <li class="truncate" title={host}>{host}</li>
          {/each}
        </ul>
      {/if}
    </Collapsible.Content>
</Collapsible.Root>
{/snippet}

<!-- What the deployment allows, bundle by bundle. Narrowed, each has a switch and the list is
     the form; otherwise it is a report, folded behind its totals. -->
{#snippet allowedList(ceiling: EgressCeiling)}
  <div class="divide-y rounded-lg border">
    {#each ceiling.bundles as bundle (bundle.id)}
      {#if narrowed}
        {@const on = fields.bundles.includes(bundle.id)}
        <div class="flex flex-col gap-4 px-4 py-3">
          <div class="flex items-center justify-between gap-6">
            <div class="flex min-w-0 flex-col gap-0.5">
              <Label
                for="network-bundle-{bundle.id}"
                class={editable ? undefined : "opacity-60"}
              >
                {bundle.name}
              </Label>
              <span
                class="text-muted-foreground line-clamp-2 text-xs"
                title={bundle.description}
              >
                {bundle.description}
              </span>
            </div>
            <Switch
              id="network-bundle-{bundle.id}"
              disabled={!editable}
              checked={on}
              onCheckedChange={(next) => setBundle(bundle, next)}
            />
          </div>
          {@render hostList(bundle.id, bundle.hosts, !on)}
        </div>
      {:else}
        <div class="flex flex-col gap-2 px-4 py-3">
          <div class="flex flex-col gap-0.5">
            <span class="text-sm font-medium">{bundle.name}</span>
            <span
              class="text-muted-foreground line-clamp-2 text-xs"
              title={bundle.description}
            >
              {bundle.description}
            </span>
          </div>
          {@render hostList(bundle.id, bundle.hosts, false)}
        </div>
      {/if}
    {:else}
      <p class="text-muted-foreground px-4 py-3 text-sm">
        This deployment vouches for no bundles: its runs reach only the hosts an
        administrator listed, if any.
      </p>
    {/each}
    {#each ceiling.hosts as host (host)}
      {#if narrowed}
        <ToggleRow
          id="network-host-{host}"
          label={host}
          description="Listed by an administrator."
          disabled={!editable}
          checked={namedHosts.includes(host)}
          onCheckedChange={(on) => setHost(host, on)}
        />
      {:else}
        <div class="flex items-center justify-between gap-4 px-4 py-3">
          <span class="truncate font-mono text-sm" title={host}>{host}</span>
          <Badge variant="outline">Listed by an administrator</Badge>
        </div>
      {/if}
    {/each}
    {#each strayHosts as host (host)}
      <ToggleRow
        id="network-host-{host}"
        label={host}
        description="Named for this agent under one of the deployment's wildcards."
        disabled={!editable}
        checked={true}
        onCheckedChange={(on) => setHost(host, on)}
      />
    {/each}
  </div>
{/snippet}

<Field.FieldSet>
  <Field.FieldLegend>Internet access</Field.FieldLegend>
  <Field.FieldDescription>
    Optionally, narrow which globally allow-listed hosts the agent may reach.
    These restrictions apply to the entire run, including pre-run steps in a
    `setup.yml`, and the agent itself.
  </Field.FieldDescription>

  {#if egressState === "unknown"}
    <Alert.Root>
      <InfoIcon />
      <Alert.Title>Cannot be shown right now</Alert.Title>
      <Alert.Description>
        This deployment's allowlist could not be read, so this access cannot be
        shown or changed. Everything else saves as usual, and it is left as it
        stands.
      </Alert.Description>
    </Alert.Root>
  {:else if ceiling === null || ceiling.mode === "open"}
    <Alert.Root>
      <InfoIcon />
      <Alert.Title>Runs have the open internet</Alert.Title>
      <Alert.Description>
        This deployment claims no boundary, so there is nothing to narrow per
        agent. Set
        <code>RYPH_EGRESS=proxy</code> with an egress proxy to enforce an allowlist.
      </Alert.Description>
    </Alert.Root>
  {:else}
    {#if !ceiling.wired}
      <Alert.Root variant="destructive">
        <TriangleAlertIcon />
        <Alert.Title>Runs currently reach nothing</Alert.Title>
        <Alert.Description>
          This deployment claims an allowlist but has no egress key or no proxy
          address, so installs fail. Set <code>RYPH_EGRESS_KEY</code> and
          <code>RYPH_EGRESS_PROXY_URL</code>, or <code>RYPH_EGRESS=open</code> to
          claim no boundary.
        </Alert.Description>
      </Alert.Root>
    {/if}
    {#if !canGrant}
      <Alert.Root>
        <InfoIcon />
        <Alert.Title>An administrator's call</Alert.Title>
        <Alert.Description>
          Changing this needs an administrator, in both directions: handing the
          agent the whole allowlist back widens its reach as much as adding to
          it.
        </Alert.Description>
      </Alert.Root>
    {/if}

    <Field.FieldGroup>
      <div class="divide-y rounded-lg border">
        <ToggleRow
          id="network-narrowed"
          label="Narrow this agent's reach"
          description={narrowed
            ? "Only what is switched on below — a subset of what the deployment allows, never more."
            : "Off: the agent reaches everything the deployment allows, and tightens with it."}
          disabled={!editable}
          checked={narrowed}
          onCheckedChange={setNarrowed}
        />
      </div>

      {#if narrowed}
        <div class="flex flex-col gap-2">
          <span class="text-sm font-medium">Allowed for this agent</span>
          {@render allowedList(ceiling)}
        </div>
        {#if hosts.length === 0}
          <Alert.Root variant="destructive">
            <TriangleAlertIcon />
            <Alert.Title>No internet host at all</Alert.Title>
            <Alert.Description>
              Nothing is switched on, so this agent's runs reach nothing. That
              is a real setting, but a repository that installs dependencies
              will fail.
            </Alert.Description>
          </Alert.Root>
        {/if}
      {:else}
        <Collapsible.Root class="group/allowed flex flex-col gap-3">
          <Collapsible.Trigger
            class="hover:text-foreground flex w-fit cursor-pointer items-center gap-1 text-sm font-medium transition-colors"
          >
            <ChevronRightIcon
              class="text-muted-foreground size-4 transition-transform group-data-[state=open]/allowed:rotate-90"
            />
            What the deployment allows
            <span class="text-muted-foreground font-normal">
              · {plural(ceiling.bundles.length, "bundle")}{ceiling.hosts
                .length > 0
                ? `, ${plural(ceiling.hosts.length, "listed host")}`
                : ""}, {plural(hosts.length, "host")} in all
            </span>
          </Collapsible.Trigger>
          <Collapsible.Content>
            {@render allowedList(ceiling)}
          </Collapsible.Content>
        </Collapsible.Root>
      {/if}
    </Field.FieldGroup>
  {/if}
</Field.FieldSet>
