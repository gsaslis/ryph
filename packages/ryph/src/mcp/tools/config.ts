// The configuration surfaces, each a read tool and a write tool over its routes (resource.ts):
// agents, repos, workspaces, environments, skills, memory, chat, MCP servers, artifacts,
// automations, and what the deployment offers. Bodies are checked against each service's own
// zod schema, and `describe` hands that schema out as JSON Schema.
//
// What is left out on purpose: people, invites, instance settings, tokens, model keys and
// providers, the egress allowlist, reserved capacity, image downloads and memory's embedding
// backfill — governing the instance, not using it — and every runner, service and forge door.

import {
  CreateAutomationSchema,
  RotateSecretSchema,
  UpdateAutomationSchema,
} from "@ryph/automations/api-schema";
import { CreateChatroomSchema, UpdateChatroomSchema } from "@ryph/chat/api-schema";
import {
  CreateCatalogueServerSchema,
  CreateCustomServerSchema,
  CreateMcpServerSchema,
  CreateRemotePresetSchema,
  RestartMcpServerSchema,
  UpdateMcpServerSchema,
} from "@ryph/mcp-gateway/api-schema";
import {
  AcceptProposalSchema,
  BriefPreviewSchema,
  CreateMemorySchema,
  IngestSourceSchema,
  MoveSourceSchema,
  ProposeMemorySchema,
  RejectProposalSchema,
  ResolveProposalsSchema,
  UpdateMemorySchema,
} from "@ryph/memory/api-schema";
import {
  AddWorkspaceRepoSchema,
  CommandRoomSchema,
  ConnectRepoSchema,
  CreateAgentSchema,
  CreateWorkspaceSchema,
  EnvironmentSetupSchema,
  OrgSkillsRepoSchema,
  RegisterInstallationSchema,
  RepoCommandAllowlistSchema,
  SkillSettingsSchema,
  UpdateAgentSchema,
  UpdateConnectedRepoSchema,
  UpdateWorkspaceRepoSchema,
  UpdateWorkspaceSchema,
} from "@ryph/orchestrator/api-schema";
import { z } from "@zod/zod";
import type { Args } from "../args.ts";
import { ago, clip, type CompactOptions, lines, record } from "../format.ts";
import { resourceTool } from "../resource.ts";
import { READ, type Tool, type ToolContext } from "../tool.ts";

const required = (schema?: z.ZodType) => ({ required: true, schema });
const optional = (schema?: z.ZodType) => ({ required: false, schema });

/** A list answer's rows, one line each, or a word saying there are none. */
function rows<T>(items: T[], line: (item: T) => string, none = "None."): string {
  return items.length === 0 ? none : items.map(line).join("\n");
}

// ---- agents -----------------------------------------------------------------------------------

interface Agent {
  id: string;
  name: string;
  handle: string | null;
  harnessKind: string;
  archivedAt: string | null;
  modelPolicy: { provider: string; defaultModel: string | null } | null;
  toolPolicy: { servers: unknown[] } | null;
  browserEnabled?: boolean;
}

const agents = resourceTool({
  name: "agents",
  description: "Read agents: the blueprints a task runs (prompt, harness, model, tool, forge, " +
    "memory, network and limit policies).",
  needs: ["agents:read"],
  actions: {
    list: {
      method: "GET",
      path: "/v1/agents",
      doc: "every agent",
      render: (a) =>
        rows(
          (a as { agents: Agent[] }).agents,
          (g) =>
            `- ${g.id} ${g.name}${g.handle ? ` (@${g.handle})` : ""} · ${g.harnessKind}${
              g.modelPolicy
                ? ` · ${g.modelPolicy.provider}/${g.modelPolicy.defaultModel ?? "any"}`
                : ""
            }${g.toolPolicy ? ` · ${g.toolPolicy.servers.length} tool servers` : ""}${
              g.browserEnabled ? " · browser" : ""
            }${g.archivedAt ? " · archived" : ""}`,
        ),
    },
    get: { method: "GET", path: "/v1/agents/{agentId}", doc: "one agent in full" },
  },
});

const agentsManage = resourceTool({
  name: "agents_manage",
  description: "Create, edit and archive agents. Setting a model, tool, forge, network or " +
    "limit policy, a browser or artifacts takes agents:policy.",
  needs: ["agents:write", "agents:policy"],
  actions: {
    create: {
      method: "POST",
      path: "/v1/agents",
      doc: "a new agent",
      body: required(CreateAgentSchema),
    },
    update: {
      method: "PATCH",
      path: "/v1/agents/{agentId}",
      doc: "change the fields given; null clears a policy",
      body: required(UpdateAgentSchema),
    },
    archive: { method: "POST", path: "/v1/agents/{agentId}/archive", doc: "retire an agent" },
  },
});

// ---- repos ------------------------------------------------------------------------------------

interface Repo {
  id: string;
  provider: string;
  repoRef: string;
  defaultBranch: string;
  submissionPolicy: string;
  sizeClass: string | null;
  archivedAt: string | null;
}

const repos = resourceTool({
  name: "repos",
  description: "Read connected repositories, their command allowlists, environments and " +
    "declared services, and what can be connected.",
  needs: ["repos:read", "repos:connect"],
  actions: {
    list: {
      method: "GET",
      path: "/v1/connected-repos",
      doc: "every connected repo",
      render: (a) =>
        rows(
          (a as { repos: Repo[] }).repos,
          (r) =>
            `- ${r.id} ${r.provider}:${r.repoRef} · default ${r.defaultBranch} · ${r.submissionPolicy}${
              r.sizeClass ? ` · size ${r.sizeClass}` : ""
            }${r.archivedAt ? " · disconnected" : ""}`,
        ),
    },
    allowlist: {
      method: "GET",
      path: "/v1/connected-repos/{repoId}/command-allowlist",
      doc: "who may command ryph on the repo's threads beyond its writers",
    },
    environment: {
      method: "GET",
      path: "/v1/connected-repos/{repoId}/environment",
      doc: "the repo's environment image: current and latest build",
    },
    definition: {
      method: "GET",
      path: "/v1/connected-repos/{repoId}/environment/definition",
      doc: "the .ryph environment definition on the default branch",
    },
    services: {
      method: "GET",
      path: "/v1/connected-repos/{repoId}/services",
      doc: "the service containers .ryph/services.yml declares",
    },
    radicle: {
      method: "GET",
      path: "/v1/connected-repos/{repoId}/radicle",
      doc: "a Radicle repo's node facts",
    },
    providers: {
      method: "GET",
      path: "/v1/forge-providers",
      doc: "the forges this deployment can connect",
    },
    installations: {
      method: "GET",
      path: "/v1/installations",
      doc: "registered GitHub App installations",
    },
    installation_repos: {
      method: "GET",
      path: "/v1/installations/{installationId}/repos",
      doc: "an installation's repos, and which are connected",
    },
    github_repos: {
      method: "GET",
      path: "/v1/github/repos",
      doc: "repos the GitHub login can connect (user mode)",
    },
    radicle_identity: {
      method: "GET",
      path: "/v1/radicle/identity",
      doc: "this deployment's Radicle identity",
    },
  },
});

const reposManage = resourceTool({
  name: "repos_manage",
  description: "Connect and configure repositories: submission policy, size class, fork " +
    "pushes, command allowlist, environment builds. Most changes also need admin on the repo.",
  needs: ["repos:connect", "repos:manage", "resources:manage", "tasks:create"],
  actions: {
    connect: {
      method: "POST",
      path: "/v1/connected-repos",
      doc: "connect a repo (github, radicle or local)",
      body: required(ConnectRepoSchema),
    },
    update: {
      method: "PATCH",
      path: "/v1/connected-repos/{repoId}",
      doc: "submissionPolicy, sizeClass, allowForkPushes",
      body: required(UpdateConnectedRepoSchema),
    },
    archive: { method: "POST", path: "/v1/connected-repos/{repoId}/archive", doc: "disconnect it" },
    allow_command: {
      method: "POST",
      path: "/v1/connected-repos/{repoId}/command-allowlist",
      doc: "let a forge login command ryph on the repo",
      body: required(RepoCommandAllowlistSchema),
    },
    disallow_command: {
      method: "DELETE",
      path: "/v1/connected-repos/{repoId}/command-allowlist/{subject}",
      doc: "take that back",
    },
    register_installation: {
      method: "POST",
      path: "/v1/installations",
      doc: "register a GitHub App installation by id",
      body: required(RegisterInstallationSchema),
    },
    rebuild_environment: {
      method: "POST",
      path: "/v1/connected-repos/{repoId}/environment/rebuild",
      doc: "build the repo's environment image again",
    },
    setup_environment: {
      method: "POST",
      path: "/v1/connected-repos/{repoId}/environment/setup",
      doc: "start a task in which an agent sets up the repo's environment",
      body: required(EnvironmentSetupSchema),
    },
  },
});

// ---- workspaces -------------------------------------------------------------------------------

interface WorkspaceView {
  workspace: { id: string; name: string; description: string | null; archivedAt: string | null };
  repos: Array<{ connectedRepoId: string; path: string; ref: string | null }>;
  canManage: boolean;
}

const workspaces = resourceTool({
  name: "workspaces",
  description: "Read workspaces: saved sets of repos a task checks out together.",
  needs: ["workspaces:read"],
  actions: {
    list: {
      method: "GET",
      path: "/v1/workspaces",
      doc: "every workspace and its repos",
      render: (a) =>
        rows(
          (a as { workspaces: WorkspaceView[] }).workspaces,
          ({ workspace: w, repos }) =>
            `- ${w.id} ${w.name}${w.archivedAt ? " (archived)" : ""} · ${
              repos.map((r) => `${r.path}=${r.connectedRepoId}${r.ref ? `@${r.ref}` : ""}`).join(
                ", ",
              )
            }${w.description ? ` · ${clip(w.description, 100)}` : ""}`,
        ),
    },
    get: { method: "GET", path: "/v1/workspaces/{workspaceId}", doc: "one workspace" },
    environment: {
      method: "GET",
      path: "/v1/workspaces/{workspaceId}/environment",
      doc: "its environment image",
    },
    definition: {
      method: "GET",
      path: "/v1/workspaces/{workspaceId}/environment/definition",
      doc: "its environment definition",
    },
  },
});

const workspacesManage = resourceTool({
  name: "workspaces_manage",
  description: "Create and edit workspaces and their repos, and build their environments.",
  needs: ["workspaces:manage", "resources:manage", "tasks:create"],
  actions: {
    create: {
      method: "POST",
      path: "/v1/workspaces",
      doc: "a new, empty workspace",
      body: required(CreateWorkspaceSchema),
    },
    update: {
      method: "PATCH",
      path: "/v1/workspaces/{workspaceId}",
      doc: "name, description, sizeClass, environmentRepoId",
      body: required(UpdateWorkspaceSchema),
    },
    archive: { method: "POST", path: "/v1/workspaces/{workspaceId}/archive", doc: "retire it" },
    add_repo: {
      method: "POST",
      path: "/v1/workspaces/{workspaceId}/repos",
      doc: "add a connected repo at a path and ref",
      body: required(AddWorkspaceRepoSchema),
    },
    update_repo: {
      method: "PATCH",
      path: "/v1/workspaces/{workspaceId}/repos/{repoId}",
      doc: "change a member's ref, path or description",
      body: required(UpdateWorkspaceRepoSchema),
    },
    remove_repo: {
      method: "DELETE",
      path: "/v1/workspaces/{workspaceId}/repos/{repoId}",
      doc: "take a repo out",
    },
    rebuild_environment: {
      method: "POST",
      path: "/v1/workspaces/{workspaceId}/environment/rebuild",
      doc: "build its environment image again",
    },
    setup_environment: {
      method: "POST",
      path: "/v1/workspaces/{workspaceId}/environment/setup",
      doc: "start a task in which an agent sets up its environment",
      body: required(EnvironmentSetupSchema),
    },
  },
});

// ---- environments -----------------------------------------------------------------------------

interface Build {
  build: {
    id: string;
    status: string;
    subjectKind: string;
    ref: string;
    trigger: string;
    createdAt: string;
  };
  subject: { name: string } | null;
}

const environments = resourceTool({
  name: "environments",
  description: "Read environment builds: the images repos and workspaces start runs on. " +
    "Rebuild one with repos_manage or workspaces_manage.",
  needs: ["repos:read"],
  actions: {
    list: {
      method: "GET",
      path: "/v1/environments",
      doc:
        "builds, newest first (state: any|active|ready|failed; subject: repo:<id> or workspace:<id>)",
      query: ["state", "subject", "limit", "cursor"],
      render: (a) => {
        const page = a as { builds: Build[]; nextCursor: string | null };
        return lines(
          rows(
            page.builds,
            ({ build: b, subject }) =>
              `- ${b.id} ${b.status} · ${
                subject?.name ?? b.subjectKind
              } @${b.ref} · ${b.trigger} · ${ago(b.createdAt)}`,
            "No builds.",
          ),
          page.nextCursor && `More: {action: "list", cursor: "${page.nextCursor}"}`,
        );
      },
    },
    get: { method: "GET", path: "/v1/environments/{environmentId}", doc: "one build" },
    log: {
      method: "GET",
      path: "/v1/environments/{environmentId}/log",
      doc: "its build log",
      text: true,
    },
  },
  params: { limit: { type: "integer", minimum: 1, maximum: 100 } },
});

// ---- skills -----------------------------------------------------------------------------------

const skills = resourceTool({
  name: "skills",
  description: "Read the skills agents get: the shipped catalogue, the org skills repo, and " +
    "its syncs.",
  needs: ["skills:read"],
  actions: {
    overview: { method: "GET", path: "/v1/skills", doc: "every skill and the settings" },
    syncs: {
      method: "GET",
      path: "/v1/skills/syncs",
      doc: "the org repo's syncs",
      query: ["limit", "cursor"],
    },
    catalogue_skill: {
      method: "GET",
      path: "/v1/skills/catalogue/{name}",
      doc: "a shipped skill's files",
    },
    org_skill: {
      method: "GET",
      path: "/v1/skills/org/{name}",
      doc: "an org skill's files and versions",
    },
    bundle: {
      method: "GET",
      path: "/v1/skills/bundles/{digest}",
      doc: "a frozen skill bundle a run got",
    },
  },
  params: { limit: { type: "integer", minimum: 1, maximum: 100 } },
});

const skillsManage = resourceTool({
  name: "skills_manage",
  description: "Configure skills: turn shipped ones off, point at an org skills repo, sync it.",
  needs: ["skills:manage"],
  actions: {
    settings: {
      method: "PUT",
      path: "/v1/skills/settings",
      doc: "disabledCatalogue and workingRepoSkills",
      body: required(SkillSettingsSchema),
    },
    set_org_repo: {
      method: "PUT",
      path: "/v1/skills/org-repo",
      doc: "the org skills repo and branch",
      body: required(OrgSkillsRepoSchema),
    },
    remove_org_repo: { method: "DELETE", path: "/v1/skills/org-repo", doc: "stop reading one" },
    sync: { method: "POST", path: "/v1/skills/org-repo/sync", doc: "read the org repo now" },
  },
});

// ---- memory -----------------------------------------------------------------------------------

interface Memory {
  id: string;
  text: string;
  kind: string;
  status: string;
  trust: string;
  subject: { kind: string; url?: string };
}

const memory = resourceTool({
  name: "memory",
  description: "Read the team's memory: what agents are briefed with, proposals waiting for " +
    "review, and ingested sources. brief_preview shows what a task would be briefed with.",
  needs: ["memory:read"],
  actions: {
    list: {
      method: "GET",
      path: "/v1/memories",
      doc: "memories (subject: org|repo:<url>; audience: all|agent:<id>; kind, status, trust " +
        "comma lists; q searches)",
      query: ["subject", "audience", "kind", "status", "trust", "q", "limit", "offset"],
      render: (a) =>
        rows(
          (a as { memories: Memory[] }).memories,
          (m) =>
            `- ${m.id} [${m.kind}, ${m.status}, ${m.trust}] ${
              m.subject.kind === "repo" ? `(${m.subject.url}) ` : ""
            }${clip(m.text, 300)}`,
          "No memories match.",
        ),
    },
    get: { method: "GET", path: "/v1/memories/{memoryId}", doc: "one memory and its history" },
    subjects: {
      method: "GET",
      path: "/v1/memory/subjects",
      doc: "the subjects memories are about",
    },
    health: { method: "GET", path: "/v1/memory/health", doc: "how the memory service is doing" },
    proposals: {
      method: "GET",
      path: "/v1/memory-proposals",
      doc: "proposals (status: pending|merged|promoted|rejected; source: a source id)",
      query: ["status", "source"],
    },
    sources: { method: "GET", path: "/v1/memory/sources", doc: "ingested sources" },
    source: {
      method: "GET",
      path: "/v1/memory/sources/{sourceId}",
      doc: "one source and its memories",
    },
    // The one POST a read tool sends, and so the one `--read-only` serves: it only renders
    // the brief a task would get, and stores nothing (tests/mcp_review_fixes_test.ts allows
    // exactly this one).
    brief_preview: {
      method: "POST",
      path: "/v1/memory/brief-preview",
      doc: "the brief an agent would get for a task",
      body: required(BriefPreviewSchema),
    },
  },
  params: {
    limit: { type: "integer", minimum: 1, maximum: 200 },
    offset: { type: "integer", minimum: 0 },
  },
  annotations: READ,
});

const memoryManage = resourceTool({
  name: "memory_manage",
  description: "Curate memory: write, edit, pin, retire, review proposals, ingest sources. " +
    "propose needs only memory:read and lands in the inbox, where it waits for a person to " +
    "accept it (a proposal made with a token is never promoted automatically; at most 50 " +
    "of yours wait at once); the rest memory:manage.",
  needs: ["memory:read", "memory:manage"],
  actions: {
    create: {
      method: "POST",
      path: "/v1/memories",
      doc: "a memory, as canon",
      body: required(CreateMemorySchema),
    },
    update: {
      method: "PATCH",
      path: "/v1/memories/{memoryId}",
      doc: "edit one",
      body: required(UpdateMemorySchema),
    },
    pin: { method: "POST", path: "/v1/memories/{memoryId}/pin", doc: "always brief it" },
    unpin: { method: "POST", path: "/v1/memories/{memoryId}/unpin", doc: "stop pinning it" },
    retire: { method: "POST", path: "/v1/memories/{memoryId}/retire", doc: "retire it" },
    propose: {
      method: "POST",
      path: "/v1/memory-proposals",
      doc: "propose one for review",
      body: required(ProposeMemorySchema),
    },
    accept: {
      method: "POST",
      path: "/v1/memory-proposals/{proposalId}/accept",
      doc: "accept a proposal, optionally edited",
      body: optional(AcceptProposalSchema),
    },
    reject: {
      method: "POST",
      path: "/v1/memory-proposals/{proposalId}/reject",
      doc: "reject a proposal with a reason",
      body: required(RejectProposalSchema),
    },
    resolve: {
      method: "POST",
      path: "/v1/memory-proposals/resolve",
      doc: "accept and reject many at once",
      body: required(ResolveProposalsSchema),
    },
    ingest: {
      method: "POST",
      path: "/v1/memory/sources",
      doc: "ingest a document (paste, url, repo-file)",
      body: required(IngestSourceSchema),
    },
    withdraw_source: {
      method: "POST",
      path: "/v1/memory/sources/{sourceId}/withdraw",
      doc: "withdraw a source and what it gave",
    },
    move_source: {
      method: "POST",
      path: "/v1/memory/sources/{sourceId}/move",
      doc: "move a source to another subject",
      body: required(MoveSourceSchema),
    },
    consolidate: { method: "POST", path: "/v1/memory/consolidate", doc: "merge duplicates now" },
  },
});

// ---- chat -------------------------------------------------------------------------------------

interface Chatroom {
  id: string;
  name: string;
  kind: string;
  linked: boolean;
  chatTitle: string | null;
  quiet?: boolean;
  archivedAt: string | null;
}

const chat = resourceTool({
  name: "chat",
  description: "Read chatrooms (Telegram, Zulip, Slack, Discord bots ryph speaks through) and " +
    "their " +
    "command rooms (who may start tasks by mentioning the bot, with which agents).",
  needs: ["chat:read", "chat:write", "chat:manage"],
  actions: {
    list: {
      method: "GET",
      path: "/v1/chatrooms",
      doc: "every chatroom",
      render: (a) =>
        rows(
          (a as { chatrooms: Chatroom[] }).chatrooms,
          (c) =>
            `- ${c.id} ${c.name} · ${c.kind}${c.chatTitle ? ` · ${c.chatTitle}` : ""}${
              c.linked ? "" : " · not linked yet"
            }${c.quiet ? " · quiet" : ""}${c.archivedAt ? " · archived" : ""}`,
        ),
    },
    get: { method: "GET", path: "/v1/chatrooms/{chatroomId}", doc: "one chatroom" },
    channels: {
      method: "GET",
      path: "/v1/chatrooms/{chatroomId}/channels",
      doc: "its platform channels",
    },
    groups: {
      method: "GET",
      path: "/v1/chatrooms/{chatroomId}/groups",
      doc: "its platform user groups",
    },
    command_room: {
      method: "GET",
      path: "/v1/command-rooms/{chatroomId}",
      doc: "the room's command policy",
    },
  },
});

const chatManage = resourceTool({
  name: "chat_manage",
  description: "Add, edit (rename, quiet) and archive chatrooms, and set who may command ryph " +
    "in one. A quiet room skips the bot's own opening line in an existing conversation and " +
    "its closing post for a run that succeeded. A " +
    "command room starts tasks as you, so setting one takes tasks:create beside chat:manage.",
  needs: ["chat:write", "chat:manage"],
  actions: {
    create: {
      method: "POST",
      path: "/v1/chatrooms",
      doc: "a chatroom from a bot's credentials",
      body: required(CreateChatroomSchema),
    },
    update: {
      method: "PATCH",
      path: "/v1/chatrooms/{chatroomId}",
      doc: "rename it, or switch quiet",
      body: required(UpdateChatroomSchema),
    },
    archive: { method: "POST", path: "/v1/chatrooms/{chatroomId}/archive", doc: "retire it" },
    set_command_room: {
      method: "PUT",
      path: "/v1/command-rooms/{chatroomId}",
      doc: "agents, targets and commanders for mentions",
      body: required(CommandRoomSchema),
    },
    delete_command_room: {
      method: "DELETE",
      path: "/v1/command-rooms/{chatroomId}",
      doc: "stop taking commands there",
    },
  },
});

// ---- MCP servers ------------------------------------------------------------------------------

interface McpServer {
  id: string;
  slug: string;
  name: string;
  kind: string;
  url?: string | null;
  archivedAt: string | null;
  host?: { status?: string } | null;
}

const mcpServers = resourceTool({
  name: "mcp_servers",
  description: "Read the MCP servers agents may be given tools from, and the catalogue of " +
    "ones this deployment can host.",
  needs: ["tools:read", "tools:manage"],
  actions: {
    list: {
      method: "GET",
      path: "/v1/mcp-servers",
      doc: "every server",
      render: (a) =>
        rows(
          (a as { mcpServers: McpServer[] }).mcpServers,
          (s) =>
            `- ${s.id} ${s.slug} "${s.name}" · ${s.kind}${s.url ? ` · ${s.url}` : ""}${
              s.host?.status ? ` · ${s.host.status}` : ""
            }${s.archivedAt ? " · archived" : ""}`,
        ),
    },
    get: { method: "GET", path: "/v1/mcp-servers/{serverId}", doc: "one server" },
    catalogue: { method: "GET", path: "/v1/mcp-catalogue", doc: "servers ready to add" },
    logs: {
      method: "GET",
      path: "/v1/mcp-servers/{serverId}/logs",
      doc: "a hosted server's logs (tools:manage)",
      query: [["lines", "tail"]],
    },
  },
  params: { lines: { type: "integer", minimum: 1, maximum: 1000 } },
});

const mcpServersManage = resourceTool({
  name: "mcp_servers_manage",
  description: "Add, edit, probe, restart and archive MCP servers.",
  needs: ["tools:manage"],
  actions: {
    create: {
      method: "POST",
      path: "/v1/mcp-servers",
      doc: "a remote server, a catalogue preset, or a hosted custom container",
      // Four shapes the gateway tells apart itself; the union is here for `describe`.
      body: required(
        z.union([
          CreateMcpServerSchema,
          CreateRemotePresetSchema,
          CreateCatalogueServerSchema,
          CreateCustomServerSchema,
        ]),
      ),
    },
    update: {
      method: "PATCH",
      path: "/v1/mcp-servers/{serverId}",
      doc: "name, description, url, credential, settings",
      body: required(UpdateMcpServerSchema),
    },
    archive: {
      method: "POST",
      path: "/v1/mcp-servers/{serverId}/archive",
      doc: "retire it — refused while an agent's tool policy still names it",
    },
    probe: {
      method: "POST",
      path: "/v1/mcp-servers/{serverId}/probe",
      doc: "connect and list its tools",
    },
    restart: {
      method: "POST",
      path: "/v1/mcp-servers/{serverId}/restart",
      doc: "restart a hosted server",
      body: optional(RestartMcpServerSchema),
    },
  },
});

// ---- artifacts --------------------------------------------------------------------------------

interface Artifact {
  id: string;
  title: string;
  currentVersion: number;
  agent: { name: string | null };
  originTaskId: string | null;
  updatedAt: string;
}

const artifacts = resourceTool({
  name: "artifacts",
  description: "Read artifacts: the pages agents published. Metadata and versions; a " +
    "person opens the page itself in the app.",
  needs: ["artifacts:read"],
  actions: {
    list: {
      method: "GET",
      path: "/v1/artifacts",
      doc: "newest first",
      query: ["limit", "before"],
      render: (a) => {
        const page = a as { artifacts: Artifact[]; next: string | null };
        return lines(
          rows(
            page.artifacts,
            (x) =>
              `- ${x.id} "${clip(x.title, 80)}" v${x.currentVersion} · ${x.agent.name ?? "agent"}${
                x.originTaskId ? ` · task ${x.originTaskId}` : ""
              } · ${ago(x.updatedAt)}`,
            "No artifacts.",
          ),
          page.next && `More: {action: "list", before: "${page.next}"}`,
        );
      },
    },
    get: {
      method: "GET",
      path: "/v1/artifacts/{artifactId}",
      doc: "one artifact and its versions",
    },
  },
  params: { limit: { type: "integer", minimum: 1, maximum: 100 } },
});

const artifactsManage = resourceTool({
  name: "artifacts_manage",
  description: "Delete an artifact (artifacts:manage, or the person it was made for with " +
    "artifacts:read and tasks:create).",
  needs: ["artifacts:read", "artifacts:manage"],
  actions: {
    delete: {
      method: "DELETE",
      path: "/v1/artifacts/{artifactId}",
      doc: "delete it and its versions",
    },
  },
});

// ---- automations ------------------------------------------------------------------------------

interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { kind: string; cron?: string; path?: string; nextDueAt?: string | null };
  agentId: string;
  target: { kind: string; connectedRepoId?: string; workspaceId?: string };
}

/**
 * An automation answer, with its webhook's path spelled out when it has one. The origin senders
 * post to is the deployment's own business and no API reports it: a Helm front door routes
 * `/v1/hooks/` beside the app, the binary and compose take hooks on the control plane's port
 * (7411 in compose, unpublished), and `PUBLIC_AUTOMATIONS_ORIGIN` can name a host of their own.
 * The automation's page shows the exact address.
 */
async function renderAutomation(
  answer: unknown,
  ctx: ToolContext,
  _args: Args,
  opts: CompactOptions,
): Promise<string> {
  const a = answer as { automation?: Automation };
  const path = a.automation?.trigger.kind === "webhook" ? a.automation.trigger.path : undefined;
  return lines(
    record(answer, opts),
    path !== undefined &&
      `Webhook path: ${path}. Where the front door routes /v1/hooks/ beside the app (a Helm ` +
        `ingress), the URL is ${(await ctx.api()).appUrl(path)}; the binary and compose take ` +
        "hooks on the control plane's own port instead. The automation's page shows the exact URL.",
  );
}

const automations = resourceTool({
  name: "automations",
  description: "Read automations: webhooks and schedules that start tasks, and their fires.",
  needs: ["automations:manage"],
  actions: {
    list: {
      method: "GET",
      path: "/v1/automations",
      doc: "your automations (everyone's with automations:manage-all)",
      render: (a) => {
        return rows(
          (a as { automations: Automation[] }).automations,
          (x) =>
            `- ${x.id} "${x.name}" · ${x.enabled ? "on" : "off"} · ${
              x.trigger.kind === "schedule"
                ? `cron ${x.trigger.cron}${
                  x.trigger.nextDueAt ? `, next ${x.trigger.nextDueAt}` : ""
                }`
                : `webhook ${x.trigger.path}`
            } · agent ${x.agentId} · ${x.target.connectedRepoId ?? x.target.workspaceId ?? ""}`,
        );
      },
    },
    get: {
      method: "GET",
      path: "/v1/automations/{automationId}",
      doc: "one automation",
      render: renderAutomation,
    },
    fires: { method: "GET", path: "/v1/automations/{automationId}/fires", doc: "its latest fires" },
  },
});

const automationsManage = resourceTool({
  name: "automations_manage",
  description: "Create, edit, switch on or off, rotate the secret of, and delete automations. " +
    "A webhook's minted secret is shown once, in create's and rotate_secret's answer. An " +
    "automation starts tasks as you, so create, update, enable and rotate_secret also take " +
    "tasks:create.",
  needs: ["automations:manage"],
  actions: {
    create: {
      method: "POST",
      path: "/v1/automations",
      doc: "a webhook or schedule automation",
      body: required(CreateAutomationSchema),
      render: renderAutomation,
    },
    update: {
      method: "PATCH",
      path: "/v1/automations/{automationId}",
      doc: "change the fields given",
      body: required(UpdateAutomationSchema),
      render: renderAutomation,
    },
    enable: { method: "POST", path: "/v1/automations/{automationId}/enable", doc: "switch it on" },
    disable: {
      method: "POST",
      path: "/v1/automations/{automationId}/disable",
      doc: "switch it off",
    },
    rotate_secret: {
      method: "POST",
      path: "/v1/automations/{automationId}/rotate-secret",
      doc: "a new webhook secret (minted, or a pasted {secret})",
      body: optional(RotateSecretSchema),
    },
    delete: { method: "DELETE", path: "/v1/automations/{automationId}", doc: "delete it for good" },
  },
});

// ---- the deployment ---------------------------------------------------------------------------

const deployment = resourceTool({
  name: "deployment",
  description: "What this deployment offers a task: harnesses, images, run sizes, limits, " +
    "and the egress ceiling.",
  needs: ["agents:read", "repos:read"],
  openActions: ["limits"],
  actions: {
    harnesses: { method: "GET", path: "/v1/harnesses", doc: "the harness kinds agents can use" },
    images: {
      method: "GET",
      path: "/v1/images",
      doc: "the run images and whether they are present",
    },
    run_sizes: { method: "GET", path: "/v1/run-sizes", doc: "the size classes a run can get" },
    limits: { method: "GET", path: "/v1/limits", doc: "the run limit ceiling and concurrency" },
    egress: {
      method: "GET",
      path: "/v1/egress",
      doc: "where runs may reach on the internet",
      // `catalogue` is every bundle there is, for the admin's form; `bundles` is what is on offer.
      render: (a, _ctx, _args, opts) =>
        record({ ...(a as Record<string, unknown>), catalogue: undefined }, opts),
    },
  },
});

export const configTools: Tool[] = [
  agents,
  agentsManage,
  repos,
  reposManage,
  workspaces,
  workspacesManage,
  environments,
  skills,
  skillsManage,
  memory,
  memoryManage,
  chat,
  chatManage,
  mcpServers,
  mcpServersManage,
  artifacts,
  artifactsManage,
  automations,
  automationsManage,
  deployment,
];
