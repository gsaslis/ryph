// `startFakeGitlab()`: the whole fake on a port — REST API v4 under `/api/v4`, OAuth under
// `/oauth`, git smart HTTP at `/<path>.git`, all under an optional path prefix, as a
// self-managed instance at `https://git.example.com/gitlab` serves them — plus the control API
// tests and playground stories script it with (seeding, merging, approving, scripted failures).

import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@ryph/service";
import { ApiError } from "./errors.ts";
import { type MergeMethod, writeHooks } from "./git/repo.ts";
import { gitHttp } from "./git/smart_http.ts";
import type { Delivery } from "./hooks.ts";
import { BadRequest, json, readInput, Router, scopesCover, tokenOf } from "./http.ts";
import { Instance } from "./instance.ts";
import {
  ACCESS,
  type Feature,
  type FeatureAccess,
  type Group,
  type Issue,
  type MergeRequest,
  type Noteable,
  type OAuthApp,
  type Project,
  type ProjectHook,
  type User,
  type Visibility,
  type World,
} from "./model.ts";
import { accountRoutes, oauth } from "./routes/accounts.ts";
import { issueRoutes } from "./routes/issues.ts";
import { mergeRequestRoutes } from "./routes/merge_requests.ts";
import { noteRoutes } from "./routes/notes.ts";
import { projectRoutes, serveUpload } from "./routes/projects.ts";
import { suggestionRoutes } from "./suggestions.ts";

export interface FakeGitlabOptions {
  /** Default 0: a free port. */
  port?: number;
  /** Default 127.0.0.1. */
  hostname?: string;
  /** A path prefix the whole instance lives under, e.g. `/gitlab`. */
  basePath?: string;
  /** What `/version` answers; 17.4 and later also serve upload reads and send
   * `Idempotency-Key`. Default 17.5.0. */
  version?: string;
  /** Where the bare repositories go; a fresh temporary directory (removed on shutdown) when
   * absent. */
  dir?: string;
  now?: () => Date;
  /** What webhook deliveries are sent with. */
  fetch?: typeof fetch;
  /** Lists longer than this leave out `X-Total`, as GitLab does above 10 000. */
  countCap?: number;
}

export interface RequestRecord {
  method: string;
  /** Relative to the instance (prefix removed), query string included. */
  path: string;
  /** The token presented, by header or Basic password; null when none. */
  token: string | null;
}

/** A hook on every scripted call that reaches the fake; answering a Response short-circuits it
 * (a 429 with `Retry-After`, a 502), null lets it through. */
export type Interceptor = (
  req: Request,
  path: string,
) => Response | null | undefined | Promise<Response | null | undefined>;

type Level = number | keyof typeof ACCESS;
const levelOf = (l: Level) => typeof l === "number" ? l : ACCESS[l];

/** `hex(HMAC-SHA256(master, "gitlab-hook:" + projectId + ":" + generation))`: the per-project
 * webhook token ryph's mailroom derives and checks, at one of the project's token generations. */
export function deriveHookToken(
  master: string,
  projectId: number | string,
  generation: number = 1,
): string {
  return createHmac("sha256", master).update(`gitlab-hook:${projectId}:${generation}`).digest(
    "hex",
  );
}

export interface FakeGitlab {
  /** The instance's base URL, path prefix included: what `RYPH_GITLAB_URL` names. */
  readonly url: string;
  /** `${url}/api/v4`. */
  readonly apiUrl: string;
  readonly instance: Instance;
  readonly world: World;
  /** Every webhook delivery so far, with the receiver's answer. */
  readonly deliveries: Delivery[];
  /** Every request so far. */
  readonly requests: RequestRecord[];

  addUser(
    p: { username: string; name?: string; email?: string; bot?: boolean; admin?: boolean },
  ): User;
  /** A new personal access token for the user; scopes default to `api`, `read_repository`,
   * `write_repository`. */
  token(
    username: string,
    p?: { scopes?: string[]; expiresAt?: string | null; name?: string; token?: string },
  ): string;
  revokeToken(token: string): void;
  addGroup(path: string, p?: { visibility?: Visibility }): Group;
  addProject(path: string, p?: {
    visibility?: Visibility;
    defaultBranch?: string;
    files?: Record<string, string>;
    protectDefaultBranch?: boolean;
  }): Promise<Project>;
  /** Adds (or changes) a member of a group or project path; `awaiting` holds the membership
   * for approval (a seat or user cap), listed with its level and granting none of it. */
  addMember(path: string, username: string, level: Level, p?: { awaiting?: boolean }): void;
  /** Blocks a user, as an administrator does: its memberships stay, its tokens stop working. */
  blockUser(username: string): void;
  /** Renames a user, as they may themselves: id, memberships and tokens stay; the old username is
   * free for anybody to register at once (GitLab keeps no redirect for a username). */
  renameUser(from: string, to: string): User;
  /** Sets one feature's access level on a project (`repository_access_level`, …). */
  setFeatureAccess(project: string, feature: Feature, access: FeatureAccess): void;
  /** Renames or moves a project to `to` (its namespace must exist), keeping its id; the old path
   * redirects to it until a project is created there. */
  renameProject(from: string, to: string): Project;
  protectBranch(project: string, branch: string, on?: boolean): void;
  fork(project: string, namespace: string, name?: string): Promise<Project>;
  deleteProject(project: string): void;
  addHook(project: string, p: Parameters<Instance["addHook"]>[1]): ProjectHook;
  /** The hook ryph's connect page asks a Maintainer to paste:
   * `${url}?project=<id>&generation=<n>` (1 unless said) with the token derived for both, Push
   * (default branch), Comments and Merge request events on. */
  addRyphHook(
    project: string,
    p: { url: string; master: string; generation?: number },
  ): ProjectHook;
  /** Commits files onto a branch as `as`, with everything a push sets off. */
  commit(project: string, p: {
    as: string;
    branch: string;
    files: Record<string, string | null>;
    message?: string;
    from?: string;
  }): Promise<string>;
  openIssue(
    project: string,
    p: {
      as: string;
      title: string;
      description?: string;
      labels?: string[];
      confidential?: boolean;
    },
  ): Issue;
  openMergeRequest(project: string, p: {
    as: string;
    sourceBranch: string;
    targetBranch?: string;
    title: string;
    description?: string;
    /** For a fork merge request: the fork the branch is on. */
    sourceProject?: string;
    allowCollaboration?: boolean;
    removeSourceBranch?: boolean;
  }): Promise<MergeRequest>;
  /** A note on `issue-<iid>` or `mr-<iid>`, as `as`; `/ryph` lines are kept as written.
   * `internal`: an internal note, for Reporters and up. */
  comment(
    project: string,
    thread: string,
    p: { as: string; body: string; internal?: boolean },
  ): Promise<{ noteId: number; discussionId: string }>;
  /** Merges `mr-<iid>` (or the bare iid) by `method` as `as`. */
  merge(
    project: string,
    iid: number,
    p: { as: string; method?: MergeMethod; removeSourceBranch?: boolean },
  ): Promise<MergeRequest>;
  approve(project: string, iid: number, p: { as: string }): Promise<void>;
  requestChanges(project: string, iid: number, p: { as: string }): void;
  closeMergeRequest(project: string, iid: number, p: { as: string }): Promise<void>;
  /** Registers an OAuth application. */
  oauthApp(
    app: { clientId: string; clientSecret: string; redirectUris?: string[]; scopes?: string[] },
  ): OAuthApp;
  /** Whom `/oauth/authorize` signs in and approves for, without asking. */
  signInAs(username: string | null): void;
  intercept(fn: Interceptor | null): void;
  /** A fetch against the API as `username` (a token is minted on first use). */
  client(username: string): (method: string, path: string, body?: unknown) => Promise<Response>;
  /** Waits for every webhook delivery in flight. */
  flush(): Promise<void>;
  redeliver(id: number): Promise<Delivery>;
  shutdown(): Promise<void>;
}

export async function startFakeGitlab(opts: FakeGitlabOptions = {}): Promise<FakeGitlab> {
  const basePath = (opts.basePath ?? "").replace(/\/+$/, "");
  const owned = opts.dir === undefined;
  const root = opts.dir ?? await mkdtemp(join(tmpdir(), "fake-gitlab-"));
  const reposDir = join(root, "repositories");
  const hooksDir = join(root, "hooks");
  await mkdir(reposDir, { recursive: true });
  await mkdir(hooksDir, { recursive: true });
  await writeHooks(hooksDir, process.execPath);

  const requests: RequestRecord[] = [];
  let interceptor: Interceptor | null = null;
  // Bound below, once the port is known.
  let gl: Instance | null = null;

  const router = new Router();
  accountRoutes(router);
  projectRoutes(router);
  issueRoutes(router);
  noteRoutes(router);
  mergeRequestRoutes(router);
  suggestionRoutes(router);

  const api = async (req: Request, path: string, url: URL): Promise<Response> => {
    const instance = gl!;
    const raw = tokenOf(req);
    const who = raw === null ? null : instance.authenticate(raw);
    if (raw !== null && !who) return json({ message: "401 Unauthorized" }, 401);
    const hit = router.match(req.method, path);
    if (hit === null) return json({ error: "404 Not Found" }, 404);
    if (hit === "method") return json({ error: "405 Method Not Allowed" }, 405);
    if (who && !scopesCover(who.token.scopes, hit.route.need)) {
      return json({
        error: "insufficient_scope",
        error_description:
          "The request requires higher privileges than provided by the access token.",
        scope: hit.route.need === "user"
          ? "api read_user"
          : hit.route.need === "read"
          ? "api read_api"
          : "api",
      }, 403);
    }
    try {
      const { input, form } = await readInput(req, url);
      return await hit.route.handler({
        req,
        url,
        gl: instance,
        user: who?.user ?? null,
        token: who?.token ?? null,
        params: hit.params,
        input,
        form,
      });
    } catch (e) {
      if (e instanceof ApiError) return json(e.body, e.status);
      if (e instanceof BadRequest) return json({ message: e.message }, 400);
      throw e;
    }
  };

  const webUpload = (path: string): Response | null => {
    const instance = gl!;
    const byId = /^\/-\/project\/(\d+)\/uploads\/([0-9a-f]{32})\/([^/]+)$/.exec(path);
    const byPath = /^\/(.+)\/uploads\/([0-9a-f]{32})\/([^/]+)$/.exec(path);
    const m = byId ?? byPath;
    if (!m) return null;
    const p = instance.world.project(byId ? Number(m[1]) : decodeURIComponent(m[1]!));
    // The web route needs a browser session for anything but a public project; the fake has
    // none, so only public uploads are served here.
    if (!p || p.visibility !== "public") return json({ message: "404 Not Found" }, 404);
    return serveUpload({ gl: instance }, p, m[2]!, decodeURIComponent(m[3]!));
  };

  const server = await serve({
    port: opts.port ?? 0,
    hostname: opts.hostname ?? "127.0.0.1",
    onListen() {},
  }, async (req) => {
    const url = new URL(req.url);
    let path = url.pathname;
    if (basePath) {
      if (path !== basePath && !path.startsWith(`${basePath}/`)) {
        return json({ error: "404 Not Found" }, 404);
      }
      path = path.slice(basePath.length) || "/";
    }
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
    requests.push({
      method: req.method,
      path: path + url.search,
      token: tokenOf(req) ??
        (basic
          ? Buffer.from(basic[1]!, "base64").toString("utf8").split(":").slice(1).join(":")
          : null),
    });
    if (interceptor) {
      const answer = await interceptor(req, path);
      if (answer) return answer;
    }
    if (path.startsWith("/api/v4/")) return await api(req, path.slice(7), url);
    const viaOauth = await oauth(gl!, req, path, url);
    if (viaOauth) return viaOauth;
    const viaGit = await gitHttp(gl!, req, path, url);
    if (viaGit) return viaGit;
    if (req.method === "GET") {
      const upload = webUpload(path);
      if (upload) return upload;
    }
    return json({ error: "404 Not Found" }, 404);
  });

  const url = `http://${opts.hostname ?? "127.0.0.1"}:${server.addr.port}${basePath}`;
  const instance = new Instance({
    url,
    reposDir,
    hooksDir,
    version: opts.version ?? "17.5.0",
    revision: "fakegitlab",
    now: opts.now ?? (() => new Date()),
    fetch: opts.fetch ?? fetch,
    countCap: opts.countCap ?? 10_000,
  });
  gl = instance;
  const world = instance.world;

  const userNamed = (username: string): User => {
    const u = world.userByUsername(username);
    if (!u) throw new Error(`no user ${username}`);
    return u;
  };
  const projectAt = (path: string): Project => {
    const p = world.project(path);
    if (!p) throw new Error(`no project ${path}`);
    return p;
  };
  const mrAt = (project: string, iid: number): MergeRequest => {
    const mr = world.mergeRequest(projectAt(project), iid);
    if (!mr) throw new Error(`no merge request !${iid} in ${project}`);
    return mr;
  };
  const clientTokens = new Map<string, string>();

  const fake: FakeGitlab = {
    url,
    apiUrl: `${url}/api/v4`,
    instance,
    world,
    deliveries: instance.hooks.deliveries,
    requests,

    addUser: (p) => instance.addUser(p),
    token: (username, p = {}) => instance.addToken(userNamed(username), p).token,
    revokeToken: (token) => {
      const t = world.tokens.get(token);
      if (t) t.revoked = true;
    },
    addGroup: (path, p) => instance.addGroup(path, p),
    addProject: (path, p) => instance.addProject(path, p),
    addMember(path, username, level, p = {}) {
      const u = userNamed(username);
      const target = world.project(path) ?? world.groupByPath(path);
      if (!target) throw new Error(`no group or project ${path}`);
      target.members.set(u.id, levelOf(level));
      if (p.awaiting) target.awaiting.add(u.id);
      else target.awaiting.delete(u.id);
    },
    blockUser(username) {
      userNamed(username).state = "blocked";
    },
    renameUser(from, to) {
      const u = userNamed(from);
      if (world.userByUsername(to) || world.groupByPath(to)) throw new Error(`${to} is taken`);
      u.username = to;
      return u;
    },
    setFeatureAccess(project, feature, access) {
      projectAt(project).features[feature] = access;
    },
    renameProject(from, to) {
      const p = projectAt(from);
      const cut = to.lastIndexOf("/");
      const ns = cut < 1 ? null : world.namespace(to.slice(0, cut));
      if (!ns) throw new Error(`no namespace for ${to}`);
      if (world.project(to) && world.project(to) !== p) throw new Error(`project ${to} exists`);
      world.redirects.set(p.path.toLowerCase(), p.id);
      world.redirects.delete(to.toLowerCase());
      p.path = to;
      p.name = to.slice(cut + 1);
      p.namespace = ns.kind === "group"
        ? { kind: "group", groupId: ns.group.id }
        : { kind: "user", userId: ns.user.id };
      return p;
    },
    protectBranch(project, branch, on = true) {
      const p = projectAt(project);
      if (on) p.protectedBranches.add(branch);
      else p.protectedBranches.delete(branch);
    },
    fork: (project, namespace, name) => instance.fork(projectAt(project), namespace, name),
    deleteProject: (project) => instance.deleteProject(projectAt(project)),
    addHook: (project, p) => instance.addHook(projectAt(project), p),
    addRyphHook(project, p) {
      const target = projectAt(project);
      const hookUrl = new URL(p.url);
      const generation = p.generation ?? 1;
      hookUrl.searchParams.set("project", String(target.id));
      hookUrl.searchParams.set("generation", String(generation));
      return instance.addHook(target, {
        url: hookUrl.toString(),
        token: deriveHookToken(p.master, target.id, generation),
        pushEvents: true,
        pushEventsBranchFilter: target.defaultBranch,
        noteEvents: true,
        mergeRequestsEvents: true,
        issuesEvents: false,
      });
    },
    commit: (project, p) => instance.commit(userNamed(p.as), projectAt(project), p),
    openIssue: (project, p) => instance.createIssue(userNamed(p.as), projectAt(project), p),
    async openMergeRequest(project, p) {
      const target = projectAt(project);
      return await instance.mrs.create(
        userNamed(p.as),
        p.sourceProject ? projectAt(p.sourceProject) : target,
        {
          target,
          sourceBranch: p.sourceBranch,
          targetBranch: p.targetBranch ?? target.defaultBranch,
          title: p.title,
          description: p.description,
          allowCollaboration: p.allowCollaboration,
          removeSourceBranch: p.removeSourceBranch,
        },
      );
    },
    async comment(project, thread, p) {
      const target = projectAt(project);
      const m = /^(issue|mr)-(\d+)$/.exec(thread);
      if (!m) throw new Error(`thread ${thread} is not issue-<iid> or mr-<iid>`);
      const on: Noteable | null = m[1] === "issue"
        ? world.issue(target, Number(m[2]))
        : world.mergeRequest(target, Number(m[2]));
      if (!on) throw new Error(`no ${thread} in ${project}`);
      const { note, discussion } = await instance.addNote(userNamed(p.as), on, {
        body: p.body,
        mode: "individual",
        internal: p.internal ?? false,
      });
      return { noteId: note.id, discussionId: discussion.id };
    },
    async merge(project, iid, p) {
      const mr = mrAt(project, iid);
      await instance.mrs.merge(userNamed(p.as), mr, {
        method: p.method,
        removeSourceBranch: p.removeSourceBranch,
      });
      return mr;
    },
    approve: (project, iid, p) => instance.mrs.approve(userNamed(p.as), mrAt(project, iid)),
    requestChanges: (project, iid, p) =>
      instance.mrs.requestChanges(userNamed(p.as), mrAt(project, iid)),
    closeMergeRequest: (project, iid, p) =>
      instance.mrs.update(userNamed(p.as), mrAt(project, iid), { stateEvent: "close" }),
    oauthApp(app) {
      const out: OAuthApp = {
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        redirectUris: app.redirectUris ?? [],
        scopes: app.scopes ?? ["read_user"],
      };
      world.oauthApps.push(out);
      return out;
    },
    signInAs(username) {
      world.oauthUserId = username === null ? null : userNamed(username).id;
    },
    intercept(fn) {
      interceptor = fn;
    },
    client(username) {
      return async (method, path, body) => {
        let token = clientTokens.get(username);
        if (!token) {
          token = instance.addToken(userNamed(username), { name: "fake-client" }).token;
          clientTokens.set(username, token);
        }
        return await fetch(`${url}/api/v4${path}`, {
          method,
          headers: {
            "private-token": token,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      };
    },
    flush: () => instance.hooks.flush(),
    redeliver: (id) => instance.hooks.redeliver(id),
    async shutdown() {
      await instance.hooks.flush();
      await server.shutdown();
      if (owned) await rm(root, { recursive: true, force: true });
    },
  };
  return fake;
}
