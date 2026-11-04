<script lang="ts">
import { can } from "$lib/utils/auth/capabilities";
import PageTitle from "$lib/components/page-title/page-title.svelte";
import { invalidate } from "$app/navigation";
import { ApiError } from "$lib/api/call";
import {
  archiveMcpServer,
  createMcpServer,
  getMcpServerLogs,
  type McpCredentialInput,
  presetLine,
  PROBE_FAILURE_LABEL,
  probeMcpServer,
  restartMcpServer,
  updateMcpServer,
} from "$lib/api/mcp-servers";
import type { CatalogueEntry, McpAuthKind, McpServer, ProbeResult } from "$lib/api/types";
import * as Alert from "$lib/components/ui/alert";
import * as AlertDialog from "$lib/components/ui/alert-dialog";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import * as Card from "$lib/components/ui/card";
import { Checkbox } from "$lib/components/ui/checkbox";
import * as Dialog from "$lib/components/ui/dialog";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
import * as Empty from "$lib/components/ui/empty";
import * as Field from "$lib/components/ui/field";
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import * as Select from "$lib/components/ui/select";
import * as Sheet from "$lib/components/ui/sheet";
import { Spinner } from "$lib/components/ui/spinner";
import { Switch } from "$lib/components/ui/switch";
import * as Tabs from "$lib/components/ui/tabs";
import { Textarea } from "$lib/components/ui/textarea";
import { pageHeader } from "$lib/components/page-header/page-header.svelte";
import { cn } from "$lib/utils";
import ArchiveIcon from "@lucide/svelte/icons/archive";
import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
import BoxIcon from "@lucide/svelte/icons/box";
import BrainIcon from "@lucide/svelte/icons/brain";
import DownloadIcon from "@lucide/svelte/icons/download";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import GitPullRequestIcon from "@lucide/svelte/icons/git-pull-request";
import GlobeIcon from "@lucide/svelte/icons/globe";
import LockIcon from "@lucide/svelte/icons/lock";
import MessageSquareIcon from "@lucide/svelte/icons/message-square";
import MoreHorizontalIcon from "@lucide/svelte/icons/more-horizontal";
import PencilIcon from "@lucide/svelte/icons/pencil";
import PlugIcon from "@lucide/svelte/icons/plug";
import PlusIcon from "@lucide/svelte/icons/plus";
import RadarIcon from "@lucide/svelte/icons/radar";
import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
import ServerIcon from "@lucide/svelte/icons/server";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import { toast } from "svelte-sonner";
import { annotationHints } from "../../(flows)/agents/shared/tool-policy";
import { AUTH_KIND_LABEL, composeCredential } from "./credential-form";
import {
  type CatalogueFormState,
  changedSettings,
  composeCatalogueBody,
  composeCustomBody,
  composeSecrets,
  type CustomFormState,
  editNeedsKey,
  entryUnavailable,
  entryWhere,
  HOST_STATUS_CHIP,
  initialCatalogueForm,
  isRemotePreset,
  settingProblem,
  urlChanged,
  urlNeedsCredential,
} from "./hosted-form";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();

const AUTH_KINDS: McpAuthKind[] = ["bearer", "headers", "none"];

const canManage = $derived(can(data.user, "tools:manage"));
const entryById = $derived(new Map(data.catalogue.entries.map((e) => [e.id, e])));
// What the catalogue tab lists: the entries that can be added here first, in the gateway's order.
const catalogueEntries = $derived([
  ...data.catalogue.entries.filter((e) => entryUnavailable(e, data.catalogue) === null),
  ...data.catalogue.entries.filter((e) => entryUnavailable(e, data.catalogue) !== null),
]);
// The built-in servers' marks: what the transcript shows for their tools, so a server here looks
// like its calls do there. By slug, which is what the gateway fixes for each of them.
const PLATFORM_ICON: Record<string, typeof ServerIcon> = {
  memory: BrainIcon,
  chat: MessageSquareIcon,
  forge: GitPullRequestIcon,
  web: GlobeIcon,
};

// Two grids: what someone here registered, and what the deployment provides. Archived servers
// are out of the first unless asked for — they are kept for the record, not for the eye — and the
// switch that asks lives in the sticky bar above the page, where it stays in reach.
let showArchived = $state(false);
const archivedCount = $derived(data.mcpServers.filter((s) => s.archivedAt !== null).length);
const customServers = $derived(
  data.mcpServers.filter((s) => s.kind !== "platform" && (showArchived || s.archivedAt === null)),
);
$effect(() => {
  pageHeader.controls = archivedCount > 0 ? archivedSwitch : null;
  return () => {
    pageHeader.controls = null;
  };
});
const platformServers = $derived(data.mcpServers.filter((s) => s.kind === "platform"));

/** The host of a server's URL — what the card shows; the full URL is a hover away. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---- Add: three tabs, one dialog ----
let addOpen = $state(false);
let addTab = $state<"catalogue" | "remote" | "custom">("catalogue");

function openAdd() {
  // The catalogue is where most servers should come from. Its remote presets work on any
  // deployment, so it is the tab to land on even where nothing can be hosted.
  addTab = "catalogue";
  addOpen = true;
}

function resetAdd() {
  resetRemote();
  resetCatalogue();
  resetCustom();
}

// ---- Add · Remote URL (the dialog as it always was) ----
let addSlug = $state("");
let addName = $state("");
let addDescription = $state("");
let addUrl = $state("");
let addAuth = $state<McpAuthKind>("bearer");
let addSecret = $state("");
let addHeaders = $state("");
let adding = $state(false);

// Whether the header map is revealed. Shared by the register, edit and rotate dialogs — only one is
// open at a time — and back to hidden whenever one opens.
let headersShown = $state(false);

function resetRemote() {
  addSlug = "";
  addName = "";
  addDescription = "";
  addUrl = "";
  addAuth = "bearer";
  addSecret = "";
  addHeaders = "";
  headersShown = false;
}

async function submitAdd(event: SubmitEvent) {
  event.preventDefault();
  const credential = composeCredential(addAuth, addSecret, addHeaders);
  if (!credential.ok) {
    toast.error(credential.error);
    return;
  }
  adding = true;
  try {
    const server = await createMcpServer(fetch, {
      slug: addSlug.trim(),
      name: addName.trim(),
      ...(addDescription.trim() ? { description: addDescription.trim() } : {}),
      url: addUrl.trim(),
      ...credential.credential,
    });
    toast.success(`Registered "${server.name}"`);
    addOpen = false;
    resetAdd();
    await invalidate("app:tool-servers");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to register server");
  } finally {
    adding = false;
  }
}

const ADD_TABS = [
  { value: "catalogue", label: "From catalogue" },
  { value: "remote", label: "Remote URL" },
  { value: "custom", label: "Custom container" },
] as const;

/**
 * Keeps a form from submitting while a setting is wrong, and takes the person to it. Runs on the
 * submit button's click, which comes before the browser's own required checks, so a bad pattern
 * is named before an empty key further down is.
 */
function stopAtProblem(
  event: MouseEvent,
  idPrefix: string,
  problems: Record<string, string | null>,
) {
  const key = Object.keys(problems).find((k) => problems[k] !== null);
  if (key === undefined) return;
  event.preventDefault();
  const field = document.getElementById(`${idPrefix}-${key}`);
  field?.scrollIntoView({ block: "center", behavior: "smooth" });
  field?.focus({ preventScroll: true });
}

// ---- Add · From catalogue ----
let pickedEntry = $state<CatalogueEntry | null>(null);
let catalogueForm = $state<CatalogueFormState | null>(null);
let advancedOpen = $state(false);

function resetCatalogue() {
  pickedEntry = null;
  catalogueForm = null;
  advancedOpen = false;
}

function pickEntry(entry: CatalogueEntry) {
  pickedEntry = entry;
  catalogueForm = initialCatalogueForm(entry, data.mcpServers);
  advancedOpen = false;
}

async function submitCatalogue(event: SubmitEvent) {
  event.preventDefault();
  if (!pickedEntry || !catalogueForm) return;
  const composed = composeCatalogueBody(pickedEntry, catalogueForm);
  if (!composed.ok) {
    toast.error(composed.error);
    return;
  }
  adding = true;
  try {
    const server = await createMcpServer(fetch, composed.body);
    if (server.kind === "hosted") await afterHostedAdd(server);
    else await afterPresetAdd(server);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to add server");
  } finally {
    adding = false;
  }
}

// A remote preset has nothing to start: it is reachable the moment it exists, so the probe opens
// straight away and shows whether the key works and what it unlocks.
async function afterPresetAdd(server: McpServer) {
  toast.success(`Added "${server.name}"`);
  addOpen = false;
  resetAdd();
  await invalidate("app:tool-servers");
  void runProbe(server);
}

/** The catalogue form's first setting problem, for the inline message under each field. */
const catalogueProblems = $derived.by(() => {
  if (!pickedEntry || !catalogueForm) return {};
  const form = catalogueForm;
  return Object.fromEntries(
    pickedEntry.settings.map((s) => [s.key, settingProblem(s, form.settings[s.key])]),
  ) as Record<string, string | null>;
});

// ---- Add · Custom container (admins) ----
const EMPTY_CUSTOM: CustomFormState = {
  name: "",
  slug: "",
  description: "",
  image: "",
  command: "",
  port: "8000",
  path: "/mcp",
  callerAuthEnv: "",
};
let customForm = $state<CustomFormState>({ ...EMPTY_CUSTOM });
let customAuth = $state<McpAuthKind>("headers");
let customSecret = $state("");
let customHeaders = $state("");

function resetCustom() {
  customForm = { ...EMPTY_CUSTOM };
  customAuth = "headers";
  customSecret = "";
  customHeaders = "";
}

async function submitCustom(event: SubmitEvent) {
  event.preventDefault();
  const credential = composeCredential(customAuth, customSecret, customHeaders);
  if (!credential.ok) {
    toast.error(credential.error);
    return;
  }
  const composed = composeCustomBody(customForm, credential.credential);
  if (!composed.ok) {
    toast.error(composed.error);
    return;
  }
  adding = true;
  try {
    await afterHostedAdd(await createMcpServer(fetch, composed.body));
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to add server");
  } finally {
    adding = false;
  }
}

// ---- A hosted server coming up ----
// The row appears `starting` straight away; the page re-reads while anything is starting, and the
// probe dialog opens by itself when the server just added turns healthy — the moment it works.
let awaitingProbe: string | null = $state(null);

async function afterHostedAdd(server: McpServer) {
  toast.success(`Starting "${server.name}" — this can take a minute on first launch`);
  addOpen = false;
  resetAdd();
  awaitingProbe = server.id;
  await invalidate("app:tool-servers");
}

$effect(() => {
  const starting = data.mcpServers.some((s) =>
    s.archivedAt === null && s.host?.status === "starting"
  );
  if (!starting) return;
  const timer = setInterval(() => invalidate("app:tool-servers"), 2000);
  return () => clearInterval(timer);
});

$effect(() => {
  if (awaitingProbe === null) return;
  const server = data.mcpServers.find((s) => s.id === awaitingProbe);
  const status = server?.host?.status;
  if (!server || status === "starting") return;
  awaitingProbe = null;
  if (status === "healthy" || status === "update-available") runProbe(server);
  else toast.error(`"${server.name}" did not come up — see its row`);
});

// ---- Edit (name, description, and a remote URL or a catalogue server's settings) ----
// A remote preset edits like a hosted catalogue row: its settings, never its URL, which the
// gateway derives from them.
let editTarget = $state<McpServer | null>(null);
let editName = $state("");
let editDescription = $state("");
let editUrl = $state("");
let editSettings = $state<Record<string, string | boolean>>({});
let editSecrets = $state<Record<string, string>>({});
// A plain remote row's credential, typed again when its URL changes.
let editAuth = $state<McpAuthKind>("bearer");
let editSecret = $state("");
let editHeaders = $state("");
// Set when the gateway asked for the key on a change the dialog did not expect to need it.
let editKeyAsked = $state(false);
let editing = $state(false);
const editEntry = $derived(
  editTarget?.catalogueId ? entryById.get(editTarget.catalogueId) : undefined,
);
// A key is bound to where it is sent: a catalogue row whose settings send it somewhere new must
// carry it again.
const editNeedsKeyNow = $derived(
  editTarget !== null && editEntry !== undefined &&
    (editKeyAsked || editNeedsKey(editTarget, editEntry, editSettings)),
);
// The same for a plain remote row with a credential, moved to a new URL.
const editNeedsCredentialNow = $derived(
  editTarget !== null && editTarget.kind === "remote" && !isRemotePreset(editTarget) &&
    (editKeyAsked || urlNeedsCredential(editTarget, editUrl)),
);
const editProblems = $derived(
  Object.fromEntries(
    (editEntry?.settings ?? []).map((s) => [s.key, settingProblem(s, editSettings[s.key])]),
  ) as Record<string, string | null>,
);

function openEdit(server: McpServer) {
  editTarget = server;
  editName = server.name;
  editDescription = server.description ?? "";
  editUrl = server.url;
  editSettings = { ...(server.settings ?? {}) };
  editSecrets = {};
  editAuth = server.auth === "none" ? "bearer" : server.auth;
  editSecret = "";
  editHeaders = "";
  headersShown = false;
  editKeyAsked = false;
}

async function submitEdit(event: SubmitEvent) {
  event.preventDefault();
  if (!editTarget) return;
  const problem = Object.values(editProblems).find((p) => p !== null);
  if (problem) {
    toast.error(problem);
    return;
  }
  let secrets: Record<string, string> | undefined;
  if (editNeedsKeyNow && editEntry) {
    const composed = composeSecrets(editEntry, editSecrets);
    if (!composed.ok) {
      toast.error(composed.error);
      return;
    }
    secrets = composed.credential;
  }
  let credential: McpCredentialInput | undefined;
  if (editNeedsCredentialNow) {
    const composed = composeCredential(editAuth, editSecret, editHeaders);
    if (!composed.ok) {
      toast.error(composed.error);
      return;
    }
    credential = composed.credential;
  }
  editing = true;
  try {
    const settings = editTarget.catalogueId
      ? changedSettings(editTarget.settings, editSettings)
      : undefined;
    // Only a URL that changed rides: the gateway refuses any `url` on a row with a credential
    // unless the credential comes with it.
    const url = urlChanged(editTarget, editUrl) ? editUrl.trim() : undefined;
    const server = await updateMcpServer(fetch, editTarget.id, {
      name: editName.trim(),
      description: editDescription.trim() || null,
      ...(url === undefined ? {} : { url }),
      ...(credential === undefined ? {} : { credential }),
      ...(settings === undefined ? {} : { settings }),
      ...(secrets === undefined ? {} : { secrets }),
    });
    toast.success(
      settings !== undefined && server.kind === "hosted"
        ? `Saved "${server.name}". Restarting`
        : `Saved "${server.name}"`,
    );
    editTarget = null;
    await invalidate("app:tool-servers");
  } catch (e) {
    // Asked for the key anyway: show the gateway's words and the key fields to answer it.
    if (isCredentialRequired(e) || isSecretRequired(e)) editKeyAsked = true;
    toast.error(e instanceof Error ? e.message : "Failed to save server");
  } finally {
    editing = false;
  }
}

/** The gateway's answer to a settings change that moves the server without its key. */
function isCredentialRequired(e: unknown): boolean {
  return e instanceof ApiError && e.status === 400 &&
    (e.body as { code?: unknown } | null)?.code === "credential_required";
}

/** The gateway's answer when the stored key cannot be used and has to be entered again. */
function isSecretRequired(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 &&
    (e.body as { code?: unknown } | null)?.code === "secret_required";
}

// ---- Rotate ----
let rotateTarget = $state<McpServer | null>(null);
let rotateAuth = $state<McpAuthKind>("bearer");
let rotateSecret = $state("");
let rotateHeaders = $state("");
let rotateSecrets = $state<Record<string, string>>({});
let rotating = $state(false);
const rotateEntry = $derived(
  rotateTarget?.catalogueId ? entryById.get(rotateTarget.catalogueId) : undefined,
);

function openRotate(server: McpServer) {
  rotateTarget = server;
  rotateAuth = server.auth === "none" ? "bearer" : server.auth;
  rotateSecret = "";
  rotateHeaders = "";
  headersShown = false;
  const entry = server.catalogueId ? entryById.get(server.catalogueId) : undefined;
  rotateSecrets = Object.fromEntries((entry?.secrets ?? []).map((s) => [s.header, ""]));
}

async function submitRotate(event: SubmitEvent) {
  event.preventDefault();
  if (!rotateTarget) return;
  let input: Parameters<typeof updateMcpServer>[2];
  if (rotateEntry) {
    // A catalogue server, hosted or a remote preset: its own secrets, by header. A container,
    // where there is one, is not involved.
    const secrets = composeSecrets(rotateEntry, rotateSecrets);
    if (!secrets.ok) {
      toast.error(secrets.error);
      return;
    }
    input = { secrets: secrets.credential };
  } else {
    const credential = composeCredential(rotateAuth, rotateSecret, rotateHeaders);
    if (!credential.ok) {
      toast.error(credential.error);
      return;
    }
    input = { credential: credential.credential };
  }
  rotating = true;
  try {
    const server = await updateMcpServer(fetch, rotateTarget.id, input);
    toast.success(`Rotated "${server.name}" — same server id, new credential`);
    rotateTarget = null;
    await invalidate("app:tool-servers");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to rotate credential");
  } finally {
    rotating = false;
  }
}

// ---- Restart and Update image ----
async function restart(server: McpServer, updateImage = false) {
  try {
    await restartMcpServer(fetch, server.id, { updateImage });
    toast.success(
      updateImage ? `Updating "${server.name}" to the new image` : `Restarting "${server.name}"`,
    );
    await invalidate("app:tool-servers");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to restart server");
  }
}

// ---- Logs (admins) ----
// The container's own output, last 200 lines, re-read on open and on Refresh. Never its env —
// and the credential was never in the container to begin with.
let logsTarget: McpServer | null = $state(null);
let logsText = $state("");
let logsError: string | null = $state(null);
let logsLoading = $state(false);

async function loadLogs(server: McpServer) {
  logsTarget = server;
  logsLoading = true;
  logsError = null;
  try {
    logsText = await getMcpServerLogs(fetch, server.id, 200);
  } catch (e) {
    logsError = e instanceof Error ? e.message : "Failed to read logs";
  } finally {
    logsLoading = false;
  }
}

// ---- Probe ----
// A live look at the server from the gateway, with the real credential: does it accept us, and
// which tools does it offer. Never stored — which is why it opens in a dialog and not a column.
let probeTarget: McpServer | null = $state(null);
let probeResult: ProbeResult | null = $state(null);
let probeError: string | null = $state(null);
let probing = $state(false);

async function runProbe(server: McpServer) {
  probeTarget = server;
  probeResult = null;
  probeError = null;
  probing = true;
  try {
    probeResult = await probeMcpServer(fetch, server.id);
  } catch (e) {
    probeError = e instanceof Error ? e.message : "Probe failed";
  } finally {
    probing = false;
  }
}

// What the probe dialog lists: the reported tools, deduped by name, first occurrence kept. The
// list is keyed on the name, and the names come from a remote server — third-party code, free to
// report `search` twice — which throws inside a keyed each, in production as well as in dev.
const probedTools = $derived.by(() => {
  if (!probeResult?.ok) return [];
  const seen = new Set<string>();
  return probeResult.tools.filter((tool) => {
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
});

// ---- Archive ----
let archiveTarget: McpServer | null = $state(null);
let archiving = $state(false);
/** Why the archive was refused, shown in the dialog: the agents still using it, when that is why. */
let archiveRefusal: { message: string; agents: Array<{ id: string; name: string }> } | null =
  $state(null);

async function submitArchive() {
  if (!archiveTarget) return;
  archiving = true;
  archiveRefusal = null;
  try {
    await archiveMcpServer(fetch, archiveTarget.id);
    toast.success(`Archived "${archiveTarget.name}"`);
    archiveTarget = null;
    await invalidate("app:tool-servers");
  } catch (e) {
    const body = e instanceof ApiError ? (e.body as { code?: unknown; agents?: unknown }) : null;
    if (body?.code === "server_in_use" && Array.isArray(body.agents)) {
      archiveRefusal = {
        message: e instanceof Error ? e.message : "Agents still use this server",
        agents: body.agents as Array<{ id: string; name: string }>,
      };
    } else {
      toast.error(e instanceof Error ? e.message : "Failed to archive server");
    }
  } finally {
    archiving = false;
  }
}

/** What a hosted row shows where a remote one shows its upstream host. */
function hostedLabel(server: McpServer): string {
  if (server.custom) return "Hosted · custom";
  return `Hosted · ${
    (server.catalogueId && entryById.get(server.catalogueId)?.name) ?? server.catalogueId
  }`;
}

/** What a remote preset row shows: the entry it came from, and the vendor host it reaches. */
function presetLabel(server: McpServer): string {
  const name = (server.catalogueId && entryById.get(server.catalogueId)?.name) ??
    server.catalogueId;
  return presetLine(server.name, name || null, server.url);
}
</script>

<svelte:head>
  <title>Tool servers · Ryph</title>
</svelte:head>

{#snippet archivedSwitch()}
  <Label for="show-archived" class="text-muted-foreground font-normal">Show archived</Label>
  <Switch id="show-archived" bind:checked={showArchived} />
{/snippet}

<div class="flex flex-col gap-10">
  <PageTitle title="Tool servers">
    {#snippet description()}
      Register MCP servers that your agents may call. Access is managed per-agent.
    {/snippet}
  </PageTitle>

  {#if data.toolAccessState === "off"}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <PlugIcon />
        </Empty.Media>
        <Empty.Title>Tool access is off</Empty.Title>
        <Empty.Description>
          This deployment runs without an MCP master key, so there is nothing to seal credentials
          with and no server can be registered. Set <code>RYPH_MCP_KEY</code> on the gateway to
          turn tool access on.
        </Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else if data.toolAccessState === "forbidden"}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <LockIcon />
        </Empty.Media>
        <Empty.Title>Administrators only</Empty.Title>
        <Empty.Description>
          Registering a tool server hands the gateway a credential it will use on agents' behalf,
          and archiving one cuts every run scoped to it — so this page belongs to an administrator
          of this deployment. Agents you can edit still use the servers already registered here.
        </Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else if data.toolAccessState === "unavailable"}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <PlugIcon />
        </Empty.Media>
        <Empty.Title>The tool gateway did not answer</Empty.Title>
        <Empty.Description>
          It is unreachable, restarting, or this deployment does not run one — so the registered
          servers cannot be listed. Nothing has changed; reload once it is back.
        </Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else if data.mcpServers.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon">
          <PlugIcon />
        </Empty.Media>
        <Empty.Title>No tool servers yet</Empty.Title>
        <Empty.Description>
          Add one from the catalogue, or register a remote MCP server by URL. The credential is
          sealed on arrival and never shown again; which tools an agent may call is decided on the
          agent.
        </Empty.Description>
      </Empty.Header>
      <Empty.Content>
        <Button onclick={openAdd}>
          <PlusIcon data-icon="inline-start" />
          Add server
        </Button>
      </Empty.Content>
    </Empty.Root>
  {:else}
    <!-- Cards, in two grids: the servers someone here registered, then the ones the deployment
         provides. A deployment has a handful of these, not a list to scan, and each is one thing
         with a face — the vendor's mark where the catalogue carries one — a name, a line on what
         it does and how it is doing. Everything a table row squeezed in beside those (slug, host,
         credential, date) is in Edit, where it is acted on. The card for adding one sits in the
         grid it adds to. -->
    <section class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <h2 class="text-base font-medium">Custom</h2>
        <p class="text-muted-foreground text-sm">
          Servers added here, from the catalogue or by URL.
        </p>
      </div>
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {#each customServers as server (server.id)}
          {@render serverCard(server)}
        {/each}
        {#if data.toolAccessEnabled}
          <button
            type="button"
            onclick={openAdd}
            class="text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:ring-ring/50 flex min-h-40 items-center justify-center gap-2 rounded-xl border border-dashed text-sm transition-colors outline-none focus-visible:ring-[3px]"
          >
            <PlusIcon class="size-4" />
            Add server
          </button>
        {/if}
      </div>
    </section>

    {#if platformServers.length > 0}
      <section class="flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <h2 class="text-base font-medium">Built-in</h2>
          <p class="text-muted-foreground text-sm">
            These servers are always available and managed by Ryph.
          </p>
        </div>
        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {#each platformServers as server (server.id)}
            {@render serverCard(server)}
          {/each}
        </div>
      </section>
    {/if}
  {/if}
</div>

<!-- The vendor's mark in a tile, or an icon for what has none. An image, not inline markup: the
     SVG comes from the catalogue, and an <img> runs nothing whatever it contains. -->
{#snippet mark(brand: CatalogueEntry["brand"], Fallback: typeof PlugIcon)}
  <div
  class="bg-background ring-border flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg p-2.5 ring-1"
>
    {#if brand}
      <img
        src="data:image/svg+xml;charset=utf-8,{encodeURIComponent(brand.logo)}"
        alt=""
        class="size-full object-contain"
      />
    {:else}
      <Fallback class="text-muted-foreground size-6" />
    {/if}
  </div>
{/snippet}

{#snippet serverCard(server: McpServer)}
  {@const hosted = server.kind === "hosted"}
  {@const platform = server.kind === "platform"}
  {@const status = server.host?.status}
  {@const entry = server.catalogueId ? entryById.get(server.catalogueId) : undefined}
  {@const brand = entry?.brand ?? null}
  <!-- The same gradient as the usage page's cards, grey by default; a catalogue server's is its
       brand colour, the mark's own, at a strength the mark still reads over. -->
  <Card.Root
  size="sm"
  class={cn(
      "@container/card to-card bg-linear-to-t",
      brand ? "from-(--brand)/15" : "from-foreground/5",
      server.archivedAt && "opacity-60",
    )}
  style={brand ? `--brand: ${brand.color}` : undefined}
>
  <Card.Header>
      <div class="flex min-w-0 flex-col gap-4">
        {@render mark(brand, platform ? PLATFORM_ICON[server.slug] ?? ServerIcon : hosted ? BoxIcon : PlugIcon)}
        <Card.Title class="truncate" title={server.name}>{server.name}</Card.Title>
      </div>
      <!-- State in the corner, where the eye goes first, with the menu beside it for the servers
           that have one. -->
      <Card.Action class="flex items-center gap-1">
        {#if server.archivedAt}
          <Badge variant="outline">Archived</Badge>
        {:else if platform}
          <Badge variant="secondary">Platform</Badge>
        {:else if hosted && status}
          <Badge
            variant={HOST_STATUS_CHIP[status].variant}
            title={server.host?.lastError ?? undefined}
          >
            {#if status === "starting"}
              <Spinner data-icon="inline-start" />
            {/if}
            {HOST_STATUS_CHIP[status].label}
          </Badge>
        {:else}
          <Badge variant="secondary">Active</Badge>
        {/if}
        {#if !server.archivedAt && !platform}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button {...props} variant="ghost" size="icon-sm" aria-label="Server actions">
                  <MoreHorizontalIcon />
                </Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              <DropdownMenu.Group>
                <DropdownMenu.Item onclick={() => runProbe(server)}>
                  <RadarIcon />
                  Probe
                </DropdownMenu.Item>
                <DropdownMenu.Item onclick={() => openEdit(server)}>
                  <PencilIcon />
                  Edit
                </DropdownMenu.Item>
                <DropdownMenu.Item onclick={() => openRotate(server)}>
                  <RefreshCwIcon />
                  Rotate credential
                </DropdownMenu.Item>
                {#if hosted}
                  <DropdownMenu.Item onclick={() => restart(server)}>
                    <RotateCwIcon />
                    Restart
                  </DropdownMenu.Item>
                  {#if canManage}
                    <DropdownMenu.Item onclick={() => loadLogs(server)}>
                      <ScrollTextIcon />
                      Logs
                    </DropdownMenu.Item>
                  {/if}
                  {#if status === "update-available"}
                    <DropdownMenu.Item onclick={() => restart(server, true)}>
                      <DownloadIcon />
                      Update image
                    </DropdownMenu.Item>
                  {/if}
                {/if}
                <DropdownMenu.Item
                  variant="destructive"
                  onclick={() => {
                    archiveTarget = server;
                  }}
                >
                  <ArchiveIcon />
                  Archive
                </DropdownMenu.Item>
              </DropdownMenu.Group>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        {/if}
      </Card.Action>
    </Card.Header>
  <!-- Below the header rather than in it, so it runs the card's full width instead of the column
       beside the badge; this is the one place the description is read, so it gets four lines. -->
  <Card.Content>
    <Card.Description class="line-clamp-4" title={server.description ?? undefined}>
      {#if server.description}
        {server.description}
      {:else if platform}
        Provided by the platform
      {:else if hosted}
        {hostedLabel(server)}
      {:else if isRemotePreset(server)}
        {presetLabel(server)}
      {:else}
        {hostOf(server.url)}
      {/if}
    </Card.Description>
  </Card.Content>
  {#if hosted && (status === "unreachable" || status === "healthy") && server.host?.lastError}
    <!-- The one fact worth a footer: why the badge above says what it says, or — on a healthy
         container — that its credential will not open or was refused, which only re-entering
         it fixes. -->
    <Card.Footer class="mt-auto">
      <span class="text-muted-foreground text-xs">{server.host.lastError}</span>
    </Card.Footer>
  {/if}
</Card.Root>
{/snippet}

{#snippet credentialFields(
  idPrefix: string,
  auth: McpAuthKind,
  setAuth: (kind: McpAuthKind) => void,
  secret: string,
  setSecret: (value: string) => void,
  headers: string,
  setHeaders: (value: string) => void,
)}
  <Field.Field>
  <Field.FieldLabel for="{idPrefix}-auth">Authentication</Field.FieldLabel>
  <Select.Root
    type="single"
    value={auth}
    onValueChange={(value) => setAuth(value as McpAuthKind)}
  >
    <Select.Trigger id="{idPrefix}-auth" class="w-full">{AUTH_KIND_LABEL[auth]}</Select.Trigger>
    <Select.Content>
      <Select.Group>
          {#each AUTH_KINDS as kind (kind)}
            <Select.Item value={kind} label={AUTH_KIND_LABEL[kind]} />
          {/each}
        </Select.Group>
    </Select.Content>
  </Select.Root>
</Field.Field>
  {#if auth === "bearer"}
    <Field.Field>
  <Field.FieldLabel for="{idPrefix}-secret">Bearer token</Field.FieldLabel>
  <Input
    id="{idPrefix}-secret"
    type="password"
    required
    value={secret}
    oninput={(e) => setSecret(e.currentTarget.value)}
    placeholder="lin_api_…"
    autocomplete="off"
  />
  <Field.FieldDescription>
        Sent as <code>Authorization: Bearer …</code>. Prefer a token scoped to what agents should
        be able to do.
      </Field.FieldDescription>
</Field.Field>
  {:else if auth === "headers"}
    <Field.Field>
  <div class="flex items-center justify-between gap-2">
    <Field.FieldLabel for="{idPrefix}-headers">Headers</Field.FieldLabel>
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onclick={() => (headersShown = !headersShown)}
    >
          {headersShown ? "Hide" : "Show"}
        </Button>
  </div>
  <!--
    Masked by default, exactly like the bearer field below it: `X-Api-Key: …` is the same
    class of secret, and it was the only one typed and rotated in the clear.
  -->
  <Textarea
    id="{idPrefix}-headers"
    required
    rows={3}
    value={headers}
    oninput={(e) => setHeaders(e.currentTarget.value)}
    placeholder="X-Api-Key: …"
    class="font-mono text-xs {headersShown ? '' : '[-webkit-text-security:disc]'}"
    autocomplete="off"
    spellcheck="false"
  />
  <Field.FieldDescription>
        One header per line, <code>Name: value</code>. For servers that authenticate with an API
        key header or a pair of headers. Hidden as you type; "Show" reveals it.
      </Field.FieldDescription>
</Field.Field>
  {:else}
    <Field.FieldDescription>
      The gateway forwards to this server with no credential at all — for servers that are
      public, or gated on the network alone.
    </Field.FieldDescription>
  {/if}
{/snippet}

{#snippet settingField(
  idPrefix: string,
  setting: CatalogueEntry["settings"][number],
  values: Record<string, string | boolean>,
  problem: string | null,
)}
  {#if setting.kind === "toggle"}
    <div class="flex items-start gap-3">
  <Checkbox
    id="{idPrefix}-{setting.key}"
    class="mt-0.5"
    checked={values[setting.key] === true}
    onCheckedChange={(checked) => (values[setting.key] = checked === true)}
  />
  <div class="flex flex-col gap-0.5">
        <Label for="{idPrefix}-{setting.key}">{setting.label}</Label>
        {#if setting.description}
          <span class="text-muted-foreground text-xs">{setting.description}</span>
        {/if}
      </div>
</div>
  {:else if setting.kind === "choice"}
    {@const current = typeof values[setting.key] === "string" ? values[setting.key] as string : ""}
    <Field.Field data-invalid={problem !== null || undefined}>
      <Field.FieldLabel for="{idPrefix}-{setting.key}">
        {setting.label}{setting.optional ? " (optional)" : ""}
      </Field.FieldLabel>
      <Select.Root
        type="single"
        value={current}
        onValueChange={(value) => (values[setting.key] = value)}
      >
        <Select.Trigger
          id="{idPrefix}-{setting.key}"
          class="w-full"
          aria-invalid={problem !== null || undefined}
        >
          {setting.options?.find((o) => o.value === current)?.label ??
            setting.placeholder ??
            "Choose one"}
        </Select.Trigger>
        <Select.Content>
          <Select.Group>
            {#each setting.options ?? [] as option (option.value)}
              <Select.Item value={option.value} label={option.label} />
            {/each}
          </Select.Group>
        </Select.Content>
      </Select.Root>
      {#if setting.description}
        <Field.FieldDescription>{setting.description}</Field.FieldDescription>
      {/if}
      {#if problem}
        <Field.FieldError>{problem}</Field.FieldError>
      {/if}
    </Field.Field>
  {:else}
    <Field.Field data-invalid={problem !== null || undefined}>
      <Field.FieldLabel for="{idPrefix}-{setting.key}">
        {setting.label}{setting.optional ? " (optional)" : ""}
      </Field.FieldLabel>
      <Input
        id="{idPrefix}-{setting.key}"
        type={setting.kind === "url" ? "url" : "text"}
        required={!setting.optional}
        aria-invalid={problem !== null || undefined}
        value={typeof values[setting.key] === "string" ? values[setting.key] as string : ""}
        oninput={(e) => (values[setting.key] = e.currentTarget.value)}
        placeholder={setting.placeholder ?? undefined}
      />
      {#if setting.description}
        <Field.FieldDescription>{setting.description}</Field.FieldDescription>
      {/if}
      {#if problem}
        <Field.FieldError>{problem}</Field.FieldError>
      {/if}
    </Field.Field>
  {/if}
{/snippet}

{#snippet secretFields(
  idPrefix: string,
  entry: CatalogueEntry,
  values: Record<string, string>,
)}
  {#each entry.secrets as secret (secret.header)}
    <Field.Field>
      <Field.FieldLabel for="{idPrefix}-{secret.header}">{secret.label}</Field.FieldLabel>
      <Input
        id="{idPrefix}-{secret.header}"
        type="password"
        required
        value={values[secret.header] ?? ""}
        oninput={(e) => (values[secret.header] = e.currentTarget.value)}
        placeholder={secret.placeholder ?? undefined}
        autocomplete="off"
      />
      {#if secret.description}
        <Field.FieldDescription>{secret.description}</Field.FieldDescription>
      {/if}
    </Field.Field>
  {/each}
{/snippet}

<Dialog.Root
  bind:open={addOpen}
  onOpenChange={(open) => {
    if (!open) resetAdd();
  }}
>
  <Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Add a tool server</Dialog.Title>
      <Dialog.Description>
        Pick one from the catalogue, or connect any MCP server by URL.
      </Dialog.Description>
    </Dialog.Header>
    <Tabs.Root bind:value={addTab} class="w-full min-w-0 pt-2">
      <!-- Full width so the three tabs share the dialog evenly; on a phone they drop to small
           type and may wrap rather than push the dialog wider than the screen. -->
      <Tabs.List class="w-full group-data-horizontal/tabs:h-auto">
        {#each ADD_TABS as tab (tab.value)}
          <Tabs.Trigger
            value={tab.value}
            class="min-w-0 py-1.5 text-xs leading-tight whitespace-normal sm:text-sm"
          >
            {tab.label}
          </Tabs.Trigger>
        {/each}
      </Tabs.List>

      <Tabs.Content value="catalogue">
        {#if pickedEntry && catalogueForm}
          <form onsubmit={submitCatalogue}>
            <div class="flex items-center gap-2 pt-2">
              <Button type="button" variant="ghost" size="sm" onclick={resetCatalogue}>
                <ArrowLeftIcon data-icon="inline-start" />
                All servers
              </Button>
              <span class="font-medium">Add {pickedEntry.name}</span>
            </div>
            <p class="text-muted-foreground pt-2 text-sm">
              {#if pickedEntry.kind === "remote"}
                Connects to {pickedEntry.name}'s own server.
              {:else}
                Runs on this deployment with the key you give it.
              {/if}
            </p>
            <Field.FieldGroup class="py-4">
              <Field.Field>
                <Field.FieldLabel for="cat-name">Name</Field.FieldLabel>
                <Input id="cat-name" required bind:value={catalogueForm.name} />
              </Field.Field>
              {#each pickedEntry.settings as setting (setting.key)}
                {@render settingField(
                  "cat",
                  setting,
                  catalogueForm.settings,
                  catalogueProblems[setting.key] ?? null,
                )}
              {/each}
              {@render secretFields("cat", pickedEntry, catalogueForm.secrets)}
              <div class="flex flex-col gap-3">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  class="text-muted-foreground hover:text-foreground h-auto self-start px-0"
                  onclick={() => (advancedOpen = !advancedOpen)}
                >
                  {advancedOpen ? "Hide advanced" : "Advanced"}
                </Button>
                {#if advancedOpen}
                  <Field.Field>
                    <Field.FieldLabel for="cat-slug">Slug</Field.FieldLabel>
                    <Input
                      id="cat-slug"
                      value={catalogueForm.slug}
                      oninput={(e) => {
                        if (!catalogueForm) return;
                        catalogueForm.slug = e.currentTarget.value;
                        catalogueForm.slugEdited = true;
                      }}
                      pattern="[a-z0-9][a-z0-9\-]*"
                      maxlength={39}
                    />
                    <Field.FieldDescription>
                      How the run sees it — tools register as
                      <code>{catalogueForm.slug.trim() || pickedEntry.id}__…</code>. Derived from
                      the server; change it only if you need a particular name.
                    </Field.FieldDescription>
                  </Field.Field>
                  <Field.Field>
                    <Field.FieldLabel for="cat-description">Description</Field.FieldLabel>
                    <Input
                      id="cat-description"
                      bind:value={catalogueForm.description}
                      placeholder="Optional — what this server is for"
                    />
                  </Field.Field>
                {/if}
              </div>
            </Field.FieldGroup>
            <Dialog.Footer>
              <Button type="button" variant="ghost" onclick={() => (addOpen = false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={adding}
                onclick={(e) => stopAtProblem(e, "cat", catalogueProblems)}
              >
                {#if adding}
                  <Spinner data-icon="inline-start" />
                {:else}
                  <PlusIcon data-icon="inline-start" />
                {/if}
                Add
              </Button>
            </Dialog.Footer>
          </form>
        {:else}
          <div class="flex flex-col gap-3 pt-2">
            {#if data.catalogue.entries.length === 0}
              <p class="text-muted-foreground text-sm">The catalogue is empty.</p>
            {/if}
            <!-- The same card the server grid shows, so what is picked here looks like what
                 lands there: mark, name, what it does, the brand's gradient; the docs link where
                 the grid's menu sits, and Add along the foot where the grid shows state. -->
            <div class="grid gap-3 sm:grid-cols-2">
              {#each catalogueEntries as entry (entry.id)}
                {@const unavailable = entryUnavailable(entry, data.catalogue)}
                <Card.Root
                  size="sm"
                  class={cn(
                    "@container/card to-card min-w-0 bg-linear-to-t",
                    entry.brand ? "from-(--brand)/15" : "from-foreground/5",
                  )}
                  style={entry.brand ? `--brand: ${entry.brand.color}` : undefined}
                >
                  <Card.Header class={cn(unavailable !== null && "opacity-60")}>
                    <div class="flex min-w-0 flex-col gap-4">
                      {@render mark(entry.brand, entry.kind === "remote" ? PlugIcon : BoxIcon)}
                      <Card.Title class="truncate" title={entry.name}>{entry.name}</Card.Title>
                    </div>
                    <Card.Action>
                      <Button
                        href={entry.docs}
                        target="_blank"
                        rel="noreferrer"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="{entry.name} documentation"
                      >
                        <ExternalLinkIcon />
                      </Button>
                    </Card.Action>
                  </Card.Header>
                  <Card.Content class={cn(unavailable !== null && "opacity-60")}>
                    <Card.Description class="line-clamp-4" title={entry.description}>
                      {entry.description}
                    </Card.Description>
                  </Card.Content>
                  <!-- Where it runs, quietly, beside Add: "Runs here" for a hosted entry, the
                       vendor's host for a remote one. A hosted entry this deployment cannot run
                       says why instead. -->
                  <Card.Footer class="mt-auto flex flex-wrap items-center justify-between gap-3">
                    <Button
                      size="sm"
                      variant="outline"
                      class="shrink-0"
                      disabled={unavailable !== null}
                      onclick={() => pickEntry(entry)}
                    >
                      <PlusIcon data-icon="inline-start" />
                      Add
                    </Button>
                    <!-- Why it cannot be added gets its own row under the button, at full strength,
                         since it is the one thing on a faded card worth reading. -->
                    <span
                      class={cn(
                        "text-muted-foreground min-w-0 text-xs",
                        unavailable === null ? "truncate" : "line-clamp-3 basis-full",
                      )}
                      title={unavailable ?? entryWhere(entry)}
                    >
                      {unavailable ?? entryWhere(entry)}
                    </span>
                  </Card.Footer>
                </Card.Root>
              {/each}
            </div>
          </div>
        {/if}
      </Tabs.Content>

      <Tabs.Content value="remote">
        <form onsubmit={submitAdd}>
          <p class="text-muted-foreground pt-2 text-sm">
            A remote MCP server (streamable HTTP). The credential is sealed on arrival and never
            shown again — only its last four characters remain visible.
          </p>
          <Field.FieldGroup class="py-4">
            <Field.Field>
              <Field.FieldLabel for="add-name">Name</Field.FieldLabel>
              <Input id="add-name" required bind:value={addName} placeholder="Linear" />
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel for="add-slug">Slug</Field.FieldLabel>
              <Input
                id="add-slug"
                required
                bind:value={addSlug}
                placeholder="linear"
                pattern="[a-z0-9][a-z0-9\-]*"
                maxlength={39}
              />
              <Field.FieldDescription>
                How the run sees it — tools register as <code>{addSlug.trim() || "linear"}__…</code>.
                Lowercase letters, digits and dashes; unique among live servers.
              </Field.FieldDescription>
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel for="add-url">URL</Field.FieldLabel>
              <Input
                id="add-url"
                type="url"
                required
                bind:value={addUrl}
                placeholder="https://mcp.linear.app/mcp"
              />
              <Field.FieldDescription>
                The server's MCP endpoint. Public https hosts only, unless the gateway is configured
                otherwise.
              </Field.FieldDescription>
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel for="add-description">Description</Field.FieldLabel>
              <Input
                id="add-description"
                bind:value={addDescription}
                placeholder="Optional — what this server is for"
              />
            </Field.Field>
            {@render credentialFields(
              "add",
              addAuth,
              (kind) => (addAuth = kind),
              addSecret,
              (value) => (addSecret = value),
              addHeaders,
              (value) => (addHeaders = value),
            )}
          </Field.FieldGroup>
          <Dialog.Footer>
            <Button type="button" variant="ghost" onclick={() => (addOpen = false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={adding}>
              {#if adding}
                <Spinner data-icon="inline-start" />
              {:else}
                <PlusIcon data-icon="inline-start" />
              {/if}
              Register server
            </Button>
          </Dialog.Footer>
        </form>
      </Tabs.Content>

      <Tabs.Content value="custom">
        {#if !canManage}
          <p class="text-muted-foreground pt-2 text-sm">
            Running a custom container takes tools:manage.
          </p>
        {:else if !data.catalogue.hostingAvailable}
          <p class="text-muted-foreground rounded-lg border border-dashed p-3 text-sm">
            This deployment cannot run servers itself: {data.catalogue.reason ??
              "no container backend is configured."}
          </p>
        {:else}
          <form onsubmit={submitCustom}>
            <div class="flex flex-col gap-1 pt-2 text-sm">
              <p class="font-medium">You are trusting this image with the credential you give it.</p>
              <p class="text-muted-foreground">
                An image that speaks MCP over streamable HTTP, pinned by digest. It runs on the tools
                network like a catalogue server — non-root, read-only, no mounts — and receives the
                credential on every request. stdio servers are not supported yet.
              </p>
            </div>
            <Field.FieldGroup class="py-4">
              <Field.Field>
                <Field.FieldLabel for="custom-name">Name</Field.FieldLabel>
                <Input id="custom-name" required bind:value={customForm.name} />
              </Field.Field>
              <Field.Field>
                <Field.FieldLabel for="custom-slug">Slug</Field.FieldLabel>
                <Input
                  id="custom-slug"
                  required
                  bind:value={customForm.slug}
                  pattern="[a-z0-9][a-z0-9\-]*"
                  maxlength={39}
                />
              </Field.Field>
              <Field.Field>
                <Field.FieldLabel for="custom-image">Image</Field.FieldLabel>
                <Input
                  id="custom-image"
                  required
                  bind:value={customForm.image}
                  placeholder="ghcr.io/acme/mcp-server@sha256:…"
                  class="font-mono text-xs"
                />
                <Field.FieldDescription>
                  Pinned by digest (<code>@sha256:…</code>) — a tag can be moved under you.
                </Field.FieldDescription>
              </Field.Field>
              <Field.Field>
                <Field.FieldLabel for="custom-command">Command</Field.FieldLabel>
                <Input
                  id="custom-command"
                  bind:value={customForm.command}
                  placeholder="--transport streamable-http --port 8000"
                  class="font-mono text-xs"
                />
                <Field.FieldDescription>
                  Arguments after the image's entrypoint, separated by spaces. No shell.
                </Field.FieldDescription>
              </Field.Field>
              <div class="grid grid-cols-2 gap-3">
                <Field.Field>
                  <Field.FieldLabel for="custom-port">Port</Field.FieldLabel>
                  <Input id="custom-port" required inputmode="numeric" bind:value={customForm.port} />
                </Field.Field>
                <Field.Field>
                  <Field.FieldLabel for="custom-path">Path</Field.FieldLabel>
                  <Input id="custom-path" bind:value={customForm.path} placeholder="/mcp" />
                </Field.Field>
              </div>
              <Field.Field>
                <Field.FieldLabel for="custom-caller-auth">Caller token env var</Field.FieldLabel>
                <Input
                  id="custom-caller-auth"
                  required
                  bind:value={customForm.callerAuthEnv}
                  placeholder="MCP_SERVER_TOKEN"
                  class="font-mono text-xs"
                />
                <Field.FieldDescription>
                  The variable your image reads a bearer token from. A fresh one is minted each
                  launch and only the gateway presents it, so a run that finds the container's
                  address is refused by the server itself.
                </Field.FieldDescription>
              </Field.Field>
              {@render credentialFields(
                "custom",
                customAuth,
                (kind) => (customAuth = kind),
                customSecret,
                (value) => (customSecret = value),
                customHeaders,
                (value) => (customHeaders = value),
              )}
            </Field.FieldGroup>
            <Dialog.Footer>
              <Button type="button" variant="ghost" onclick={() => (addOpen = false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={adding}>
                {#if adding}
                  <Spinner data-icon="inline-start" />
                {:else}
                  <PlusIcon data-icon="inline-start" />
                {/if}
                Add container
              </Button>
            </Dialog.Footer>
          </form>
        {/if}
      </Tabs.Content>
    </Tabs.Root>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root
  open={editTarget !== null}
  onOpenChange={(open) => {
    if (!open) editTarget = null;
  }}
>
  <Dialog.Content>
    <form onsubmit={submitEdit}>
      <Dialog.Header>
        <Dialog.Title>Edit "{editTarget?.name}"</Dialog.Title>
        <Dialog.Description>
          {#if editTarget?.kind === "hosted"}
            The slug and the credential stay as they are — rotate the credential from the row's
            menu. Changing a setting restarts the server's container; its tools are unavailable for
            the few seconds that takes.
          {:else if editTarget && isRemotePreset(editTarget)}
            To change the key, use Rotate credential. Changes apply on the next call.
          {:else}
            The slug stays as it is. A new URL takes effect on the next call, in-flight runs
            included.
          {/if}
        </Dialog.Description>
      </Dialog.Header>
      <Field.FieldGroup class="py-4">
        <Field.Field>
          <Field.FieldLabel for="edit-name">Name</Field.FieldLabel>
          <Input id="edit-name" required bind:value={editName} />
        </Field.Field>
        {#if editTarget?.kind === "remote" && !isRemotePreset(editTarget)}
          <Field.Field>
            <Field.FieldLabel for="edit-url">URL</Field.FieldLabel>
            <Input id="edit-url" type="url" required bind:value={editUrl} />
          </Field.Field>
        {/if}
        <Field.Field>
          <Field.FieldLabel for="edit-description">Description</Field.FieldLabel>
          <Input id="edit-description" bind:value={editDescription} placeholder="Optional" />
        </Field.Field>
        {#if editEntry}
          {#each editEntry.settings as setting (setting.key)}
            {@render settingField("edit", setting, editSettings, editProblems[setting.key] ?? null)}
          {/each}
          {#if editNeedsKeyNow}
            <Field.FieldDescription>
              This change sends the key somewhere new, so enter it again.
            </Field.FieldDescription>
            {@render secretFields("edit", editEntry, editSecrets)}
          {/if}
        {/if}
        {#if editNeedsCredentialNow}
          <Field.FieldDescription>
            A new URL sends the credential somewhere new, so enter it again.
          </Field.FieldDescription>
          {@render credentialFields(
            "edit",
            editAuth,
            (kind) => (editAuth = kind),
            editSecret,
            (value) => (editSecret = value),
            editHeaders,
            (value) => (editHeaders = value),
          )}
        {/if}
      </Field.FieldGroup>
      <Dialog.Footer>
        <Button
          type="button"
          variant="ghost"
          onclick={() => {
            editTarget = null;
          }}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={editing}
          onclick={(e) => stopAtProblem(e, "edit", editProblems)}
        >
          {#if editing}
            <Spinner data-icon="inline-start" />
          {:else}
            <PencilIcon data-icon="inline-start" />
          {/if}
          Save changes
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root
  open={rotateTarget !== null}
  onOpenChange={(open) => {
    if (!open) rotateTarget = null;
  }}
>
  <Dialog.Content>
    <form onsubmit={submitRotate}>
      <Dialog.Header>
        <Dialog.Title>Rotate "{rotateTarget?.name}"</Dialog.Title>
        <Dialog.Description>
          Replaces the credential under the same server id — no agent needs re-assigning. Runs in
          flight pick the new credential up on their next call.
          {#if rotateTarget?.kind === "hosted"}
            The server's container never held the old one, so nothing restarts.
          {/if}
        </Dialog.Description>
      </Dialog.Header>
      <Field.FieldGroup class="py-4">
        {#if rotateEntry}
          {@render secretFields("rotate", rotateEntry, rotateSecrets)}
        {:else}
          {@render credentialFields(
            "rotate",
            rotateAuth,
            (kind) => (rotateAuth = kind),
            rotateSecret,
            (value) => (rotateSecret = value),
            rotateHeaders,
            (value) => (rotateHeaders = value),
          )}
        {/if}
      </Field.FieldGroup>
      <Dialog.Footer>
        <Button
          type="button"
          variant="ghost"
          onclick={() => {
            rotateTarget = null;
          }}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={rotating}>
          {#if rotating}
            <Spinner data-icon="inline-start" />
          {:else}
            <RefreshCwIcon data-icon="inline-start" />
          {/if}
          Rotate credential
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root
  open={probeTarget !== null}
  onOpenChange={(open) => {
    if (!open) probeTarget = null;
  }}
>
  <Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Probe "{probeTarget?.name}"</Dialog.Title>
      <Dialog.Description>
        The gateway connects with the real credential and lists what the server offers. Nothing is
        stored — which tools an agent may call is ticked on the agent.
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-3 py-2 text-sm">
      {#if probing}
        <div class="text-muted-foreground flex items-center gap-2">
          <Spinner class="size-4" />
          Connecting…
        </div>
      {:else if probeError}
        <p class="text-destructive">{probeError}</p>
      {:else if probeResult && !probeResult.ok}
        <div class="flex flex-col gap-1">
          <p class="text-destructive font-medium">{PROBE_FAILURE_LABEL[probeResult.reason]}</p>
          <p class="text-muted-foreground">{probeResult.detail}</p>
          {#if probeResult.reason === "credential_rejected"}
            <p class="text-muted-foreground">
              The server refused the credential the gateway holds for it. Rotate it from the row's
              menu; runs scoped to this server are failing their tool calls until then.
            </p>
          {:else if probeResult.reason === "secret_required"}
            <p class="text-muted-foreground">
              The gateway can't use the credential it holds for this server. Enter it again with
              Rotate credential; runs scoped to this server are refused until then.
            </p>
          {/if}
        </div>
      {:else if probeResult?.ok}
        <p class="text-muted-foreground">
          Credential accepted.
          {#if probeResult.serverInfo.name}
            Server reports as <span class="font-mono">{probeResult.serverInfo.name}</span>
            {#if probeResult.serverInfo.version}
              <span class="font-mono">{probeResult.serverInfo.version}</span>
            {/if}
            {#if probeResult.protocolVersion}
              (protocol {probeResult.protocolVersion}).
            {:else}
              .
            {/if}
          {/if}
        </p>
        {#if probedTools.length === 0}
          <p class="text-muted-foreground">The server reports no tools.</p>
        {:else}
          <p class="font-medium">
            {probedTools.length} {probedTools.length === 1 ? "tool" : "tools"}
          </p>
          <ul class="flex flex-col gap-2">
            {#each probedTools as tool (tool.name)}
              <li class="flex flex-col gap-0.5">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="font-mono text-xs">{tool.name}</span>
                  {#each annotationHints(tool.annotations) as hint (hint.label)}
                    <Badge variant={hint.tone === "warn" ? "destructive" : "outline"}>
                      {hint.label}
                    </Badge>
                  {/each}
                </div>
                {#if tool.description}
                  <span class="text-muted-foreground text-xs">{tool.description}</span>
                {/if}
              </li>
            {/each}
          </ul>
          {#if probedTools.some((t) => t.annotations !== null)}
            <p class="text-muted-foreground text-xs">
              Badges are the server's own claims about its tools — hints, not something Ryph
              verified.
            </p>
          {/if}
        {/if}
      {/if}
    </div>
    <Dialog.Footer>
      {#if probeTarget && !probing}
        <Button type="button" variant="outline" onclick={() => probeTarget && runProbe(probeTarget)}>
          <RadarIcon data-icon="inline-start" />
          Probe again
        </Button>
      {/if}
      <Button
        type="button"
        onclick={() => {
          probeTarget = null;
        }}
      >
        Close
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Sheet.Root
  open={logsTarget !== null}
  onOpenChange={(open) => {
    if (!open) logsTarget = null;
  }}
>
  <Sheet.Content side="right" class="w-full sm:max-w-2xl">
    <Sheet.Header>
      <Sheet.Title>Logs · {logsTarget?.name}</Sheet.Title>
      <Sheet.Description>
        The last 200 lines the server's container wrote. Its environment is never shown, and the
        credential is not in it.
      </Sheet.Description>
    </Sheet.Header>
    <div class="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4">
      <Button
        type="button"
        variant="outline"
        size="sm"
        class="self-start"
        disabled={logsLoading}
        onclick={() => logsTarget && loadLogs(logsTarget)}
      >
        {#if logsLoading}
          <Spinner data-icon="inline-start" />
        {:else}
          <RefreshCwIcon data-icon="inline-start" />
        {/if}
        Refresh
      </Button>
      {#if logsError}
        <p class="text-destructive text-sm">{logsError}</p>
      {:else}
        <pre
          class="bg-muted min-h-0 flex-1 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap"
        >{logsText || (logsLoading ? "" : "No output yet.")}</pre>
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>

<AlertDialog.Root
  open={archiveTarget !== null}
  onOpenChange={(open) => {
    if (!open) {
      archiveTarget = null;
      archiveRefusal = null;
    }
  }}
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Archive "{archiveTarget?.name}"?</AlertDialog.Title>
      <AlertDialog.Description>
        This is the kill switch: every run scoped to this server — including ones in flight — loses
        access on its next call. An agent that still uses it has to drop it from its tool policy
        first. The slug is freed for reuse; the row is kept for history, never deleted.
        {#if archiveTarget?.kind === "hosted"}
          The server's container is stopped and removed.
        {/if}
      </AlertDialog.Description>
    </AlertDialog.Header>
    {#if archiveRefusal}
      <Alert.Root variant="destructive">
        <TriangleAlertIcon />
        <Alert.Title>Still in use</Alert.Title>
        <Alert.Description class="flex flex-col gap-2">
          <span>{archiveRefusal.message}</span>
          <ul class="flex flex-col gap-1">
            {#each archiveRefusal.agents as agent (agent.id)}
              <li>
                <a class="underline underline-offset-4" href="/agents/{agent.id}/edit">
                  Edit {agent.name}
                </a>
              </li>
            {/each}
          </ul>
        </Alert.Description>
      </Alert.Root>
    {/if}
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action disabled={archiving || archiveRefusal !== null} onclick={submitArchive}>
        {#if archiving}
          <Spinner data-icon="inline-start" />
        {/if}
        Archive server
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
