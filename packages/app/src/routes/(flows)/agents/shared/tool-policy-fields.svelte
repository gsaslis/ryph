<script lang="ts">
import {
  presetLine,
  PROBE_FAILURE_LABEL,
  probeMcpServer,
  type ToolAccessState,
} from "$lib/api/mcp-servers";
import {
  type CatalogueEntry,
  type Harness,
  type McpServer,
  PLATFORM_FORGE_SERVER_ID,
  type ProbeResult,
} from "$lib/api/types";
import * as Alert from "$lib/components/ui/alert";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Card from "$lib/components/ui/card";
import { Checkbox } from "$lib/components/ui/checkbox";
import * as Collapsible from "$lib/components/ui/collapsible";
import * as Empty from "$lib/components/ui/empty";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import * as Sheet from "$lib/components/ui/sheet";
import { Spinner } from "$lib/components/ui/spinner";
import { Switch } from "$lib/components/ui/switch";
import BoxIcon from "@lucide/svelte/icons/box";
import BrainIcon from "@lucide/svelte/icons/brain";
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import GlobeIcon from "@lucide/svelte/icons/globe";
import MessageSquareIcon from "@lucide/svelte/icons/message-square";
import PlugIcon from "@lucide/svelte/icons/plug";
import RadarIcon from "@lucide/svelte/icons/radar";
import ServerIcon from "@lucide/svelte/icons/server";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import {
  annotationHints,
  isAllowlistable,
  noToolsLabel,
  type ToolGrant,
  withDefaultOff,
  withEveryTool,
  withTool,
} from "./tool-policy";

let {
  grants = $bindable(),
  mcpServers,
  toolAccessState,
  harness,
  catalogue = [],
}: {
  /** One entry per server the agent may reach; empty means no tool access. */
  grants: ToolGrant[];
  mcpServers: McpServer[];
  /** Whether the tool surface answered, and what it said if it did not. */
  toolAccessState: ToolAccessState;
  /** The chosen harness, when the deployment's image map knows it; undefined in manual dev. */
  harness: Harness | undefined;
  /** The catalogue's entries, for brand marks and the tools an entry leaves off by default. */
  catalogue?: CatalogueEntry[];
} = $props();

const entryById = $derived(new Map(catalogue.map((e) => [e.id, e])));
const entryOf = (server: McpServer) =>
  server.catalogueId === null ? undefined : entryById.get(server.catalogueId);

// Servers can be picked only when the surface actually answered. Every other state leaves the
// section unshowable — and leaves a standing policy ALONE, which is the whole reason a gateway
// that is down, absent or not this user's to read may reach this form as a state and not a throw.
const toolAccessEnabled = $derived(toolAccessState === "on");

// Whether the chosen harness can drive tools. With no image map (manual dev) the harness is
// unknown, so the servers stay offered and the orchestrator validates.
const harnessCanUseTools = $derived(harness === undefined || harness.tools);

// The platform forge server is granted under "Issues & change requests", with caps this picker has
// no fields for — the orchestrator refuses a tool policy naming it, so it is not a card here.
const pickable = $derived(
  mcpServers.filter((s) => s.id !== PLATFORM_FORGE_SERVER_ID),
);

const liveServers = $derived(pickable.filter((s) => s.archivedAt === null));

// The cards: every live server, plus any granted server that has since been archived — flagged,
// so the grant can be removed knowingly rather than vanishing from the form and the save.
const rows = $derived.by(() => {
  const granted = new Set(grants.map((g) => g.serverId));
  const archivedGranted = pickable.filter(
    (s) => s.archivedAt !== null && granted.has(s.id),
  );
  return [...liveServers, ...archivedGranted];
});
const customRows = $derived(rows.filter((s) => s.kind !== "platform"));
const platformRows = $derived(rows.filter((s) => s.kind === "platform"));

// Grants naming a server the list has no row for at all. With tool access off there are no rows,
// so a standing policy would otherwise read as no policy; the stored grant names it instead.
const unresolved = $derived(
  grants.filter((g) => !mcpServers.some((s) => s.id === g.serverId)),
);

// A harness that cannot use tools must not keep grants: the orchestrator would refuse the save.
// With tool access off the grants cannot be shown, so nothing is cleared — "cannot be shown" must
// not be misread as "deselected".
$effect(() => {
  if (toolAccessEnabled && !harnessCanUseTools && grants.length > 0) {
    grants = [];
  }
});

const grantOf = (serverId: string) => grants.find((g) => g.serverId === serverId);

/**
 * Whether the agent reaches this server as things stand. An operator's server is reached only
 * when granted. The platform's are granted by default — memory to a remembering agent, the web
 * tools to every tool-capable one — so "no entry" means "whatever the deployment gives everyone",
 * and an entry with an EMPTY list is the only way to write down "this agent gets none of it".
 */
function isOn(server: McpServer, grant: ToolGrant | undefined): boolean {
  if (server.kind === "platform") {
    return (
      grant === undefined ||
      grant.allowedTools === "*" ||
      grant.allowedTools.length > 0
    );
  }
  return grant !== undefined;
}

// Switching a server on grants every tool it offers — the probe below reports how many that is —
// and the sheet narrows it from there. Off is no grant for an operator's server, and for the
// platform's the empty entry that denies its default.
function setOn(server: McpServer, on: boolean) {
  if (server.kind === "platform") {
    grants = grants.filter((g) => g.serverId !== server.id);
    if (!on) grants = [...grants, { serverId: server.id, allowedTools: [] }];
    return;
  }
  if (!on) {
    grants = grants.filter((g) => g.serverId !== server.id);
    return;
  }
  if (grantOf(server.id)) return;
  // An entry that leaves tools off starts pending: every tool until the probe narrows it, and
  // refused at save until then, so a probe that fails cannot let the writes through.
  const pending = (entryOf(server)?.defaultOff.length ?? 0) > 0;
  grants = [
    ...grants,
    { serverId: server.id, allowedTools: "*", ...(pending && { pendingDefaultOff: true }) },
  ];
  void probe(server.id);
}

// An archived row is never dialed: the gateway refuses, and the card says archived instead.
const probeable = (server: McpServer) => server.archivedAt === null;

function replaceGrant(next: ToolGrant) {
  grants = grants.some((g) => g.serverId === next.serverId)
    ? grants.map((g) => (g.serverId === next.serverId ? next : g))
    : [...grants, next];
}

function removeGrant(serverId: string) {
  grants = grants.filter((g) => g.serverId !== serverId);
}

// Probe results, per server, for this form's lifetime. A probe is a live look at the server —
// the gateway connects with the real credential and reports back — so it is never stored.
type Probe =
  | { state: "loading" }
  | { state: "done"; result: ProbeResult }
  | { state: "failed"; error: string };
let probes = $state<Record<string, Probe>>({});

// One counter per server, bumped by every probe started for it. Two probes of the same server can
// be in flight — switching off and on again starts another — and the network decides which lands
// first. Only the latest one's answer may be shown: a slow first probe resolving after a fast
// second would otherwise replace a fresh tool list with a stale verdict. Not reactive state:
// nothing renders it.
const probeToken: Record<string, number> = {};

async function probe(serverId: string) {
  const token = (probeToken[serverId] ?? 0) + 1;
  probeToken[serverId] = token;
  probes[serverId] = { state: "loading" };
  try {
    const result = await probeMcpServer(fetch, serverId);
    if (probeToken[serverId] !== token) return;
    probes[serverId] = { state: "done", result };
    if (result.ok) applyDefaultOff(serverId, result.tools.map((t) => t.name));
  } catch (e) {
    if (probeToken[serverId] !== token) return;
    probes[serverId] = {
      state: "failed",
      error: e instanceof Error ? e.message : "Probe failed",
    };
  }
}

// Every server the agent reaches as the form opens is probed once, so its card can say how many
// tools that comes to rather than "all of them" — an editor's seeded grants and the platform's
// defaults alike. Once per server: a card is not re-probed because a step was re-entered.
$effect(() => {
  if (!toolAccessEnabled || !harnessCanUseTools) return;
  for (const server of rows) {
    if (
      probeable(server) &&
      isOn(server, grantOf(server.id)) &&
      !probes[server.id]
    ) {
      void probe(server.id);
    }
  }
});

/** Narrows a server just switched on to its entry's default, once its tools are known. */
function applyDefaultOff(serverId: string, reported: string[]) {
  const grant = grantOf(serverId);
  if (!grant?.pendingDefaultOff) return;
  const server = mcpServers.find((s) => s.id === serverId);
  const entry = server === undefined ? undefined : entryOf(server);
  if (entry === undefined) return;
  replaceGrant(withDefaultOff(grant, reported, entry.defaultOff));
}

/** Whether the server's catalogue entry marks this tool as one that writes or changes things. */
function writes(server: McpServer, tool: string): boolean {
  return entryOf(server)?.defaultOff.includes(tool) ?? false;
}

/** The names a successful probe reported; empty before one. */
function reportedTools(serverId: string) {
  const p = probes[serverId];
  return p?.state === "done" && p.result.ok ? p.result.tools : [];
}

interface ToolRow {
  name: string;
  description: string | null;
  annotations: Record<string, unknown> | null;
  /** false for a ticked name the probe did not report — a tool the server no longer offers. */
  reported: boolean;
}

/**
 * What the sheet lists for a server: the probe's tools, plus any ticked name the probe did not
 * report (flagged, so it can be unticked knowingly). Before a probe, the ticked names alone — an
 * editor can still remove tools without dialing the server.
 */
function toolRows(serverId: string, grant: ToolGrant | undefined): ToolRow[] {
  const reported = reportedTools(serverId);
  const ticked = grant === undefined || grant.allowedTools === "*" ? [] : grant.allowedTools;
  // Deduped by name, first occurrence kept: the list below is keyed on the name, and a remote
  // server is free to report `search` twice — third-party code, possibly compromised, and Svelte
  // throws on a duplicate key in production too. A name is a name to the allowlist either way.
  const list: ToolRow[] = [];
  const seen = new Set<string>();
  for (const tool of reported) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    list.push({ ...tool, reported: true });
  }
  for (const name of ticked) {
    if (seen.has(name)) continue;
    seen.add(name);
    list.push({
      name,
      description: null,
      annotations: null,
      reported: false,
    });
  }
  return list;
}

/** What the card's badge says about the grant, once the switch is on. */
function toolsLabel(server: McpServer, grant: ToolGrant | undefined): string {
  const reported = reportedTools(server.id).length;
  const p = probes[server.id];
  const counted = p?.state === "done" && p.result.ok;
  if (grant === undefined || grant.allowedTools === "*") {
    return counted ? `${reported} tool${reported === 1 ? "" : "s"}` : "All tools";
  }
  const n = grant.allowedTools.length;
  if (n === 0) return noToolsLabel(server) ?? "No tools";
  return counted ? `${n} of ${reported} tools` : `${n} tool${n === 1 ? "" : "s"}`;
}

const PLATFORM_ICON: Record<string, typeof ServerIcon> = {
  memory: BrainIcon,
  chat: MessageSquareIcon,
  web: GlobeIcon,
};

function iconOf(server: McpServer): typeof ServerIcon {
  if (server.kind === "platform") {
    return PLATFORM_ICON[server.slug] ?? ServerIcon;
  }
  return server.kind === "hosted" ? BoxIcon : PlugIcon;
}

// A hosted server's URL is the gateway's own guard address — an internal, not something the
// person picking tools should ever read.
function descriptionOf(server: McpServer): string {
  if (server.description) return server.description;
  if (server.kind === "platform") return "Provided by the platform";
  const entryName = entryOf(server)?.name ?? server.catalogueId;
  if (server.kind === "hosted") return `Hosted · ${entryName ?? "custom container"}`;
  return entryName === null ? server.url : presetLine(server.name, entryName, server.url);
}

// The built-in servers are on for every agent, and narrowing them is how platform features get
// broken by accident — so their cards start folded, unless this agent already narrows one, which
// must not hide.
// svelte-ignore state_referenced_locally
let builtInOpen = $state(
  grants.some(
    (g) => mcpServers.find((s) => s.id === g.serverId)?.kind === "platform",
  ),
);

// The server whose tools are being picked in the sheet, if any.
let sheetId = $state<string | null>(null);
const sheetServer = $derived(
  sheetId === null ? undefined : rows.find((s) => s.id === sheetId),
);
const sheetGrant = $derived(
  sheetServer === undefined ? undefined : grantOf(sheetServer.id),
);
const sheetProbe = $derived(
  sheetServer === undefined ? undefined : probes[sheetServer.id],
);
const sheetProbed = $derived(
  sheetProbe?.state === "done" && sheetProbe.result.ok,
);
// Picking tools on a platform server that has no entry yet writes one down, so the pick has
// somewhere to live; "every tool" is what no entry meant anyway.
const sheetEvery = $derived(
  sheetGrant === undefined || sheetGrant.allowedTools === "*",
);

function setEvery(server: McpServer, every: boolean) {
  const grant = sheetGrant ?? {
    serverId: server.id,
    allowedTools: "*" as const,
  };
  replaceGrant(
    withEveryTool(
      grant,
      every,
      reportedTools(server.id).map((t) => t.name),
    ),
  );
}

function setTool(server: McpServer, tool: string, allowed: boolean) {
  const grant = sheetGrant ?? {
    serverId: server.id,
    allowedTools: "*" as const,
  };
  replaceGrant(withTool(grant, tool, allowed));
}

// A tool named by hand, for a server the probe could not list just now. Held to the allowlist
// grammar, as a probed name is.
let typedTool = $state("");
const typedProblem = $derived(
  typedTool.trim() === "" || isAllowlistable(typedTool.trim())
    ? null
    : "A tool name is letters, digits, dots, dashes and underscores.",
);

function addTyped(server: McpServer) {
  const name = typedTool.trim();
  if (name === "" || typedProblem !== null) return;
  if (sheetEvery) setEvery(server, false);
  setTool(server, name, true);
  typedTool = "";
}
</script>

<!-- One card per server, as the tool servers page shows them: a face, a name, a line on what it
     does, and in the corner the switch that lets this agent reach it. On, the card says how many
     tools that comes to, and opens a sheet to pick among them. -->
{#snippet serverCard(server: McpServer)}
  {@const grant = grantOf(server.id)}
  {@const on = isOn(server, grant)}
  {@const p = probes[server.id]}
  {@const Icon = iconOf(server)}
  {@const brand = entryOf(server)?.brand ?? null}
  <Card.Root
  size="sm"
  class={[
      "@container/card from-foreground/5 to-card relative bg-linear-to-t transition-[box-shadow,opacity]",
      on
        ? "hover:ring-foreground/25 has-[button[data-open]:focus-visible]:ring-ring/50 has-[button[data-open]:focus-visible]:ring-[3px]"
        : "opacity-60",
    ]}
>
    <Card.Header>
      <div class="flex min-w-0 flex-col gap-3">
        <!-- The vendor's mark where the catalogue carries one, as an image so nothing in it runs. -->
        <div
          class="bg-background ring-border flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg p-2 ring-1"
        >
          {#if brand}
            <img
              src="data:image/svg+xml;charset=utf-8,{encodeURIComponent(brand.logo)}"
              alt=""
              class="size-full object-contain"
            />
          {:else}
            <Icon class="text-muted-foreground size-5" />
          {/if}
        </div>
        <Card.Title class="truncate" title={server.name}>
          {#if on}
            <button
              type="button"
              data-open
              class="cursor-pointer after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
              onclick={() => {
                sheetId = server.id;
              }}
            >
              {server.name}
            </button>
          {:else}
            {server.name}
          {/if}
        </Card.Title>
      </div>
      <Card.Action class="relative z-10">
        <Switch
          checked={on}
          aria-label="Let this agent reach {server.name}"
          onCheckedChange={(checked) => setOn(server, checked)}
        />
      </Card.Action>
    </Card.Header>
    <Card.Content>
      <Card.Description class="line-clamp-2" title={descriptionOf(server)}>
        {descriptionOf(server)}
      </Card.Description>
    </Card.Content>
    {#if on}
      <Card.Footer class="mt-auto gap-2">
        {#if server.archivedAt}
          <Badge variant="destructive">Archived</Badge>
        {:else if p?.state === "loading"}
          <Badge variant="secondary">
            <Spinner data-icon="inline-start" />
            Probing
          </Badge>
        {:else if p?.state === "done" && !p.result.ok}
          <Badge variant="destructive" title={p.result.detail}>
            {PROBE_FAILURE_LABEL[p.result.reason]}
          </Badge>
        {:else if p?.state === "failed"}
          <Badge variant="destructive" title={p.error}>Probe failed</Badge>
        {:else}
          <Badge
            variant={grant !== undefined &&
            grant.allowedTools !== "*" &&
            grant.allowedTools.length === 0
              ? "outline"
              : "secondary"}
          >
            {toolsLabel(server, grant)}
          </Badge>
        {/if}
      </Card.Footer>
    {/if}
  </Card.Root>
{/snippet}

<Field.FieldSet class="min-w-0">
  <Field.FieldLegend>Tools</Field.FieldLegend>
  <Field.FieldDescription class="max-w-2xl">
    Allow the agent to access specific tool servers and their tools. Each run
    receives a short-lived credential for the tool gateway scoped to the tools
    enabled below. Click a tool server to narrow which tools are available.
  </Field.FieldDescription>
  {#if toolAccessEnabled && !harnessCanUseTools}
    <Field.FieldDescription>
      The "{harness?.kind}" harness cannot use tools, so none are offered.
    </Field.FieldDescription>
  {:else if toolAccessState === "off"}
    {#if grants.length > 0}
      <Field.FieldDescription>
        This deployment runs without tool access, so this agent's tool servers ({grants.length})
        cannot be shown or changed. Runs still carry the policy and fail at
        boot, with no token to mint. Set <code>RYPH_MCP_KEY</code> on the gateway
        to restore it, or remove tool access from this agent to let its runs proceed
        without tools.
      </Field.FieldDescription>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onclick={() => {
            grants = [];
          }}
        >
          Remove tool access
        </Button>
      </div>
    {:else}
      <Field.FieldDescription>
        This deployment runs without tool access — no MCP servers can be
        registered, and agents run without tools. Set <code>RYPH_MCP_KEY</code> on
        the gateway to enable it.
      </Field.FieldDescription>
    {/if}
    <!--
      The two states below are not configuration choices, so neither offers to clear the policy:
      nothing here knows what the agent's tools are, and "I could not read it" must never become
      "I removed it". Saving from this form leaves a standing policy exactly as it was.
    -->
  {:else if toolAccessState === "forbidden"}
    <Field.FieldDescription>
      Tool servers are managed by an administrator, and this account cannot read
      them — so this agent's tools{grants.length > 0
        ? ` (${grants.length} server${grants.length === 1 ? "" : "s"})`
        : ""}
      cannot be shown or changed here. Everything else on this form saves as usual,
      and the agent's tool policy is left as it stands.
    </Field.FieldDescription>
  {:else if toolAccessState === "unavailable"}
    <Field.FieldDescription>
      The tool gateway did not answer, so tool servers cannot be shown right
      now. Everything else on this form saves as usual, and the agent's tool
      policy is left as it stands — reload once the gateway is back to change
      it.
    </Field.FieldDescription>
  {:else}
    <div class="flex flex-col gap-8">
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <h3 class="text-sm font-medium">Custom servers</h3>
        </div>
        {#if customRows.length > 0}
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {#each customRows as server (server.id)}
              {@render serverCard(server)}
            {/each}
          </div>
        {:else}
          <Empty.Root class="border border-dashed py-8">
            <Empty.Header>
              <Empty.Media variant="icon">
                <PlugIcon />
              </Empty.Media>
              <Empty.Title>No custom servers yet</Empty.Title>
              <Empty.Description>
                Register an MCP server under Tool servers and it can be switched
                on here.
              </Empty.Description>
            </Empty.Header>
            <Empty.Content>
              <Button variant="outline" size="sm" href="/tool-servers"
                >Tool servers</Button
              >
            </Empty.Content>
          </Empty.Root>
        {/if}
      </div>
      {#if platformRows.length > 0}
        <Collapsible.Root
          bind:open={builtInOpen}
          class="group/builtin flex flex-col gap-4"
        >
          <Collapsible.Trigger
            class="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1 text-sm transition-colors"
          >
            <ChevronRightIcon
              class="size-4 transition-transform group-data-[state=open]/builtin:rotate-90"
            />
            Advanced: built-in servers
          </Collapsible.Trigger>
          <Collapsible.Content class="flex flex-col gap-4">
            <Alert.Root>
              <TriangleAlertIcon />
              <Alert.Title
                >Narrowing these can break platform features</Alert.Title
              >
              <Alert.Description>
                Disabling platform-supplied servers may break incident response,
                memory, and other platform-level functionality. Disable these
                tools with care.
              </Alert.Description>
            </Alert.Root>
            <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {#each platformRows as server (server.id)}
                {@render serverCard(server)}
              {/each}
            </div>
          </Collapsible.Content>
        </Collapsible.Root>
      {/if}
      {#each unresolved as grant (grant.serverId)}
        <div
          class="flex items-center gap-3 rounded-lg border border-dashed p-3"
        >
          <p class="flex-1 text-sm">
            <span class="font-mono">{grant.serverId}</span>
            <span class="text-muted-foreground">
              — cannot be shown: no tool server with this id is registered.
            </span>
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onclick={() => removeGrant(grant.serverId)}
          >
            Remove
          </Button>
        </div>
      {/each}
    </div>
  {/if}
</Field.FieldSet>

<!-- The picker for one server, off the right edge: what the probe found, and which of it this
     agent may call. Picking is the exception; the card's switch, allowing everything, is the
     rule, and this is where the exception is written down. -->
<Sheet.Root
  open={sheetServer !== undefined}
  onOpenChange={(open) => {
    if (!open) sheetId = null;
  }}
>
  <Sheet.Content
    side="right"
    class="data-[side=right]:w-[90vw] data-[side=right]:sm:max-w-xl"
  >
    {#if sheetServer}
      {@const server = sheetServer}
      {@const list = toolRows(server.id, sheetGrant)}
      <Sheet.Header>
        <Sheet.Title>{server.name}</Sheet.Title>
        <Sheet.Description>{descriptionOf(server)}</Sheet.Description>
      </Sheet.Header>
      <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4">
        {#if server.archivedAt}
          <p class="text-destructive text-sm">
            This server is archived: runs cannot reach it, and the agent cannot
            be saved while it is listed here.
          </p>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onclick={() => {
                removeGrant(server.id);
                sheetId = null;
              }}
            >
              Remove from this agent
            </Button>
          </div>
        {:else}
          <div class="flex items-start gap-3">
            <Switch id="every-{server.id}" checked={sheetEvery} onCheckedChange={(checked) => setEvery(server, checked === true)} />
            <div class="flex flex-col gap-0.5">
              <Label for="every-{server.id}">Allow every tool the server offers</Label
              >
              <span class="text-muted-foreground text-xs">
                Including tools the server adds later.
              </span>
            </div>
          </div>

          {#if sheetGrant?.pendingDefaultOff && sheetProbe?.state !== "loading"}
            <p class="text-muted-foreground text-sm">
              Probe again, or choose the tools yourself.
            </p>
          {/if}
          {#if sheetProbe?.state === "loading"}
            <p class="text-muted-foreground flex items-center gap-2 text-sm">
              <Spinner />
              Asking the server what it offers…
            </p>
          {:else if sheetProbe?.state === "done" && !sheetProbe.result.ok}
            <p class="text-destructive text-sm">
              {PROBE_FAILURE_LABEL[sheetProbe.result.reason]} — {sheetProbe
                .result.detail}
            </p>
          {:else if sheetProbe?.state === "failed"}
            <p class="text-destructive text-sm">{sheetProbe.error}</p>
          {:else if sheetProbed && list.length === 0}
            <p class="text-muted-foreground text-sm">
              The server reports no tools.
            </p>
          {/if}

          {#if !sheetEvery && !sheetProbed}
            <!-- Only while the probe has not answered: then the list above is the server's own
                 word, and a name typed beside it would be a guess. Not a form: the sheet renders
                 inside the page's, and Enter here must add a name rather than move the flow. -->
            <div class="flex items-end gap-2">
              <Field.Field class="flex-1">
                <Field.FieldLabel for="typed-tool-{server.id}"
                  >Allow a tool by name</Field.FieldLabel
                >
                <Input
                  id="typed-tool-{server.id}"
                  bind:value={typedTool}
                  placeholder="search"
                  class="font-mono"
                  aria-invalid={typedProblem !== null}
                  onkeydown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addTyped(server);
                  }}
                />
                {#if typedProblem}
                  <Field.FieldDescription class="text-destructive">
                    {typedProblem}
                  </Field.FieldDescription>
                {/if}
              </Field.Field>
              <Button
                type="button"
                variant="outline"
                disabled={typedTool.trim() === "" || typedProblem !== null}
                onclick={() => addTyped(server)}
              >
                Allow
              </Button>
            </div>
          {/if}

          {#if list.length > 0}
            <div class="flex flex-col gap-3">
              <!-- The platform's rows are granted by default, so an EMPTY list is a state worth
                   naming: it is the only way to say "this agent gets none of them". -->
              {#if sheetGrant && !sheetEvery && sheetGrant.allowedTools.length === 0}
                <p class="text-muted-foreground text-sm">
                  {noToolsLabel(server) ??
                    "Tick at least one tool, or switch the server off."}
                </p>
              {/if}
              {#each list as tool, i (tool.name)}
                {@const allowlistable = isAllowlistable(tool.name)}
                {@const ticked =
                  sheetEvery ||
                  (sheetGrant !== undefined &&
                    sheetGrant.allowedTools !== "*" &&
                    sheetGrant.allowedTools.includes(tool.name))}
                <div class="flex items-start gap-3">
                  <Checkbox
                    id="tool-{server.id}-{i}"
                    class="mt-0.5"
                    checked={ticked}
                    disabled={sheetEvery || !allowlistable}
                    onCheckedChange={(checked) =>
                      setTool(server, tool.name, checked === true)}
                  />
                  <div class="flex min-w-0 flex-col gap-0.5">
                    <Label
                      for="tool-{server.id}-{i}"
                      class="flex flex-wrap items-center gap-1.5 font-mono text-xs"
                    >
                      {tool.name}
                      {#if writes(server, tool.name)}
                        <Badge variant="outline" title="Changes things in {server.name}">
                          writes
                        </Badge>
                      {/if}
                      {#each annotationHints(tool.annotations) as hint (hint.label)}
                        <Badge
                          variant={hint.tone === "warn"
                            ? "destructive"
                            : "outline"}
                        >
                          {hint.label}
                        </Badge>
                      {/each}
                      {#if sheetProbed && !tool.reported}
                        <Badge variant="outline"
                          >not reported by the server</Badge
                        >
                      {/if}
                      {#if !allowlistable}
                        <Badge variant="outline"
                          >name cannot be allowlisted</Badge
                        >
                      {/if}
                    </Label>
                    {#if tool.description}
                      <span class="text-muted-foreground line-clamp-2 text-xs">
                        {tool.description}
                      </span>
                    {/if}
                  </div>
                </div>
              {/each}
              {#if list.some((t) => t.annotations !== null)}
                <p class="text-muted-foreground text-xs">
                  Badges are the server's own claims about its tools — hints,
                  not something Ryph verified.
                </p>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
      <Sheet.Footer class="flex-row items-center justify-between">
        <div>
          {#if probeable(server)}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={sheetProbe?.state === "loading"}
              onclick={() => probe(server.id)}
            >
              <RadarIcon data-icon="inline-start" />
              Probe again
            </Button>
          {/if}
        </div>
        <Button
          type="button"
          onclick={() => {
            sheetId = null;
          }}
        >
          Done
        </Button>
      </Sheet.Footer>
    {/if}
  </Sheet.Content>
</Sheet.Root>
