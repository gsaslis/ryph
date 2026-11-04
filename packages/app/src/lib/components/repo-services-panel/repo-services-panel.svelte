<script lang="ts">
import { getRepoServices, type RepoServices } from "$lib/api/services";
import * as Alert from "$lib/components/ui/alert";
import { Button } from "$lib/components/ui/button";
import { Skeleton } from "$lib/components/ui/skeleton";
import * as Table from "$lib/components/ui/table";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

let { services, connectedRepoId, defaultBranch }: {
  services: Promise<RepoServices | null>;
  connectedRepoId: string;
  defaultBranch: string;
} = $props();

type Shown = { repoId: string; result: RepoServices | { state: "unread"; error: string } };
let shown = $state<Shown | null>(null);
let retrying = $state(false);
let request = 0;
$effect(() => {
  const answer = services;
  const id = connectedRepoId;
  const generation = ++request;
  void read(answer, id, generation);
  return () => {
    request++;
  };
});
async function read(answer: Promise<RepoServices | null>, id: string, generation: number) {
  try {
    const result = await answer;
    if (generation === request && result !== null) shown = { repoId: id, result };
  } catch (e) {
    if (generation === request) {
      shown = {
        repoId: id,
        result: { state: "unread", error: e instanceof Error ? e.message : "Please try again." },
      };
    }
  } finally {
    if (generation === request) retrying = false;
  }
}
function retry() {
  retrying = true;
  void read(getRepoServices(fetch, connectedRepoId), connectedRepoId, ++request);
}
const view = $derived(shown?.repoId === connectedRepoId ? shown.result : null);
</script>

{#if view === null}
  <div role="status" aria-label="Reading services" class="flex flex-col gap-2">
  <Skeleton class="h-4 w-56 max-w-full" />
  <Skeleton class="h-24 w-full" />
</div>
{:else if view.state === "unread"}
  <Alert.Root>
  <TriangleAlertIcon />
  <Alert.Title>Services couldn’t be read</Alert.Title>
  <Alert.Description class="flex flex-col items-start gap-3">
    <p class="break-words">{view.error}</p>
    <Button variant="outline" size="sm" disabled={retrying} onclick={retry}>
        {retrying ? "Reading…" : "Try again"}
      </Button>
  </Alert.Description>
</Alert.Root>
{:else if view.state === "none"}
  <p class="text-muted-foreground text-sm">No services declared on {defaultBranch}.</p>
{:else}
  <p class="text-muted-foreground text-sm">
    <code>.ryph/services.yml</code> on {defaultBranch}
  </p>
  {#if view.state === "invalid"}
    <Alert.Root variant="destructive">
  <TriangleAlertIcon />
  <Alert.Title>The services file has an error</Alert.Title>
  <Alert.Description>
    <p class="break-words font-mono text-xs">{view.error}</p>
  </Alert.Description>
</Alert.Root>
  {:else}
    {#if view.stale}
      <Alert.Root>
  <TriangleAlertIcon />
  <Alert.Title>Showing a cached declaration</Alert.Title>
  <Alert.Description>The upstream refresh failed. These services may have changed.</Alert.Description>
</Alert.Root>
    {/if}
    {#if view.services.length === 0}
      <p class="text-muted-foreground text-sm">No services declared on {defaultBranch}.</p>
    {:else}
      <Table.Root>
  <Table.Header>
    <Table.Row>
      <Table.Head>Name</Table.Head>
      <Table.Head>Service</Table.Head>
      <Table.Head>Address</Table.Head>
    </Table.Row>
  </Table.Header>
  <Table.Body>
          {#each view.services as service (service.name)}
            <Table.Row>
              <Table.Cell>
                <code class="text-xs font-medium">{service.name}</code>
                {#if service.checksOnly}
                  <span class="text-muted-foreground ml-1 text-xs">checks only</span>
                {/if}
              </Table.Cell>
              <Table.Cell><code class="text-muted-foreground text-xs">{service.source}</code></Table.Cell>
              <Table.Cell><code class="text-muted-foreground text-xs">{service.name}:{service.port}</code></Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
</Table.Root>
    {/if}
    {#if view.problem}
      <Alert.Root variant="destructive">
  <TriangleAlertIcon />
  <Alert.Title>These services can’t start</Alert.Title>
  <Alert.Description>
    <p class="break-words">{view.problem}</p>
  </Alert.Description>
</Alert.Root>
    {/if}
  {/if}
{/if}
