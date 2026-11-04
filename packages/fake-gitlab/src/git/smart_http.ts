// Git over smart HTTP, as GitLab serves it at `<instance>/<path>.git`: `git http-backend` does
// the protocol over the project's real bare repository, and this decides who may, the way GitLab
// does.
//
// - Credentials are HTTP Basic with the token as the password; any username goes for a personal
//   token, so `oauth2:<token>` works for both kinds.
// - Fetching takes a token scoped `read_repository`, `write_repository`, `read_api` or `api`
//   (else 403 "You are not allowed to download code."); pushing, `write_repository` or `api`
//   (else 403 "You are not allowed to upload code."). Verified on GitLab 17.11, `api` alone
//   included.
// - An anonymous request for anything but a public project's fetch is challenged (401); a
//   signed-in one for a project it may not see gets GitLab's 404 sentence.
// - Pushing takes Developer, or a fork merge request's `allow_collaboration` for its source
//   branch. A protected branch (the default branch, unless told otherwise) takes Maintainer, and
//   nobody may force-push or delete it. Per-ref refusals go through the pre-receive hook, so the
//   client prints `remote: GitLab: …` and `[remote rejected]` exactly as against GitLab.
// - After a push: webhooks, merge request updates and `merge_request.*` push options
//   (instance.ts `afterPush`).

import { gunzipSync } from "node:zlib";
import { command } from "@ryph/process";
import type { Instance } from "../instance.ts";
import { ACCESS, type Project, type User } from "../model.ts";
import { gitEnv, refs } from "./repo.ts";

const PATH = /^\/(.+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const NOT_FOUND =
  "The project you were looking for could not be found or you don't have permission to view it.";

/** GitLab's 401, with or without credentials presented (verified on GitLab 17.11). */
function challenge(instanceUrl: string): Response {
  const body =
    "HTTP Basic: Access denied. If a password was provided for Git authentication, the " +
    "password was incorrect or you're required to use a token instead of a password. If a token " +
    "was provided, it was either incorrect, expired, or improperly scoped. See " +
    `${instanceUrl}/help/topics/git/troubleshooting_git.md#error-on-git-fetch-http-basic-access-denied`;
  return new Response(body, {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="GitLab"', "content-type": "text/plain" },
  });
}

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, { status, headers: { "content-type": "text/plain" } });
}

/** The token a Basic header carries as its password. */
function basicToken(req: Request): string | null {
  const m = /^Basic\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const at = decoded.indexOf(":");
  if (at === -1) return null;
  const [user, password] = [decoded.slice(0, at), decoded.slice(at + 1)];
  return user === "" || password === "" ? null : password;
}

export interface ReceiveCommand {
  old: string;
  new: string;
  ref: string;
}

/** The ref updates and push options at the head of a `git-receive-pack` request body. */
export function parseReceive(body: Uint8Array): { commands: ReceiveCommand[]; options: string[] } {
  const commands: ReceiveCommand[] = [];
  const options: string[] = [];
  const dec = new TextDecoder();
  let pos = 0;
  let caps: string[] = [];
  const readSection = (into: (line: string) => void) => {
    while (pos + 4 <= body.length) {
      const len = parseInt(dec.decode(body.subarray(pos, pos + 4)), 16);
      if (Number.isNaN(len)) return;
      if (len === 0) {
        pos += 4;
        return;
      }
      const line = dec.decode(body.subarray(pos + 4, pos + len)).replace(/\n$/, "");
      pos += len;
      into(line);
    }
  };
  readSection((line) => {
    const nul = line.indexOf("\0");
    if (nul !== -1) {
      caps = line.slice(nul + 1).split(" ");
      line = line.slice(0, nul);
    }
    const [o, n, ref] = line.split(" ");
    if (o && n && ref) commands.push({ old: o, new: n, ref });
  });
  if (caps.includes("push-options")) readSection((line) => options.push(line));
  return { commands, options };
}

/** Answers a git smart-HTTP request, or null when the path is not one. */
export async function gitHttp(
  gl: Instance,
  req: Request,
  path: string,
  url: URL,
): Promise<Response | null> {
  const m = PATH.exec(path);
  if (!m) return null;
  const [, projectPath, tail] = m as unknown as [string, string, string];
  const service = tail === "info/refs" ? url.searchParams.get("service") : tail;
  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    return text(403, "Unsupported service");
  }
  const write = service === "git-receive-pack";

  let user: User | null = null;
  let scopes: string[] = [];
  const raw = basicToken(req);
  if (raw !== null) {
    const who = gl.authenticate(raw);
    if (!who) return challenge(gl.present.url);
    user = who.user;
    scopes = who.token.scopes;
  } else if (req.headers.has("authorization")) return challenge(gl.present.url);

  const project = gl.world.project(decodeURIComponent(projectPath));
  // A target's member pushing to a fork through `allow_collaboration` reaches it: such a fork is
  // never private (`collaborationPossible`), and the grant stands in for a role on it.
  const collaborates = user && project
    ? gl.world.collaborationGrants(user, project)
    : new Set<string>();
  if (!project || (!gl.world.canReadCode(user, project) && collaborates.size === 0)) {
    return user ? text(404, NOT_FOUND) : challenge(gl.present.url);
  }
  if (!write) {
    if (
      user &&
      !scopes.some((s) => ["read_repository", "write_repository", "read_api", "api"].includes(s))
    ) {
      return text(403, "You are not allowed to download code.");
    }
    return await backend(gl, req, project, tail, url, user, {});
  }
  if (!user) return challenge(gl.present.url);
  if (!scopes.some((s) => ["write_repository", "api"].includes(s))) {
    return text(403, "You are not allowed to upload code.");
  }
  if (!gl.world.can(user, project, ACCESS.developer) && collaborates.size === 0) {
    return text(403, "You are not allowed to push code to this project.");
  }
  if (tail === "info/refs") return await backend(gl, req, project, tail, url, user, {});

  const body = new Uint8Array(await req.arrayBuffer());
  const plain = req.headers.get("content-encoding") === "gzip"
    ? new Uint8Array(gunzipSync(body))
    : body;
  const { commands, options } = parseReceive(plain);
  const deny: Record<string, string> = {};
  const protectedRefs: string[] = [];
  for (const c of commands) {
    if (c.ref.startsWith("refs/heads/")) {
      const branch = c.ref.slice(11);
      if (!gl.world.canPushBranch(user, project, branch)) {
        deny[c.ref] = project.protectedBranches.has(branch)
          ? "You are not allowed to push code to protected branches on this project."
          : "You are not allowed to push code to this project.";
      } else if (project.protectedBranches.has(branch)) protectedRefs.push(c.ref);
    } else if (c.ref.startsWith("refs/tags/")) {
      if (!gl.world.can(user, project, ACCESS.developer)) {
        deny[c.ref] = "You are not allowed to create tags on this project.";
      }
    } else {
      deny[c.ref] = "You are not allowed to push code to this project.";
    }
  }
  return await gl.exclusive(project.id, async () => {
    const before = await refs(project.gitDir);
    const res = await backend(gl, req, project, tail, url, user, {
      FAKE_GITLAB_RULES: JSON.stringify({ deny, protected: protectedRefs }),
    }, body);
    const after = await refs(project.gitDir);
    await gl.afterPush(user, project, before, after, options);
    return res;
  });
}

/** Runs `git http-backend` for one request and turns its CGI answer into a response. */
async function backend(
  gl: Instance,
  req: Request,
  project: Project,
  tail: string,
  url: URL,
  user: User | null,
  extra: Record<string, string>,
  body?: Uint8Array,
): Promise<Response> {
  const input = body ?? (req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : null);
  const env: Record<string, string> = {
    GIT_PROJECT_ROOT: gl.reposDir,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${project.id}.git/${tail}`,
    REQUEST_METHOD: req.method,
    QUERY_STRING: url.search.replace(/^\?/, ""),
    CONTENT_TYPE: req.headers.get("content-type") ?? "",
    REMOTE_USER: user?.username ?? "",
    REMOTE_ADDR: "127.0.0.1",
    ...extra,
  };
  if (input) env.CONTENT_LENGTH = String(input.byteLength);
  const encoding = req.headers.get("content-encoding");
  if (encoding) env.HTTP_CONTENT_ENCODING = encoding;
  const protocol = req.headers.get("git-protocol");
  if (protocol) env.GIT_PROTOCOL = protocol;
  const child = await command("git", {
    args: ["http-backend"],
    env: gitEnv(env),
    stdin: input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input) {
    const w = child.stdin.getWriter();
    await w.write(input);
    await w.close();
  }
  const out = await child.output();
  return cgiResponse(out.stdout);
}

/** A CGI answer (headers, a blank line, the body) as a Response. */
export function cgiResponse(raw: Uint8Array): Response {
  let split = -1;
  let skip = 0;
  for (let i = 0; i + 1 < raw.length; i++) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
      split = i;
      skip = 4;
      break;
    }
    if (raw[i] === 10 && raw[i + 1] === 10) {
      split = i;
      skip = 2;
      break;
    }
  }
  if (split === -1) return text(500, "git http-backend gave no headers");
  const head = new TextDecoder().decode(raw.subarray(0, split));
  const headers = new Headers();
  let status = 200;
  for (const line of head.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    const k = line.slice(0, at).trim();
    const v = line.slice(at + 1).trim();
    if (k.toLowerCase() === "status") status = parseInt(v, 10);
    else headers.append(k, v);
  }
  return new Response(raw.slice(split + skip), { status, headers });
}
