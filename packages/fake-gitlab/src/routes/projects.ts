// Projects and what hangs off them directly: listing and reading projects, effective membership,
// labels, commit statuses, uploads, project hooks, and single commits and branches.

import { ApiError } from "../errors.ts";
import { git, log, revParse } from "../git/repo.ts";
import {
  bool,
  type Ctx,
  int,
  json,
  missing,
  notFound,
  paginate,
  type Router,
  str,
} from "../http.ts";
import { ACCESS, hex32, type Project } from "../model.ts";
import { codeProjectOf, need, projectOf, signedIn } from "./common.ts";

/** The branches holding `sha`, by name. */
async function branchesContaining(gitDir: string, sha: string): Promise<string[]> {
  const r = await git(gitDir, [
    "for-each-ref",
    "--contains",
    sha,
    "--sort=refname",
    "--format=%(refname:lstrip=2)",
    "refs/heads",
  ]);
  return r.stdout.split("\n").filter((b) => b !== "");
}

export function projectRoutes(r: Router) {
  r.add("GET", "/projects", async (ctx) => {
    const { world } = ctx.gl;
    const membership = bool(ctx.input.membership) === true;
    const minLevel = int(ctx.input.min_access_level) ?? 0;
    const search = str(ctx.input.search)?.toLowerCase() ?? null;
    let hits = [...world.projects.values()].filter((p) => world.canSee(ctx.user, p));
    if (membership || minLevel > 0) {
      if (!ctx.user) return paginate(ctx, [], () => null);
      hits = hits.filter((p) => world.accessLevel(ctx.user, p) >= Math.max(minLevel, ACCESS.guest));
    }
    if (search) hits = hits.filter((p) => p.path.toLowerCase().includes(search));
    if (bool(ctx.input.owned) === true) {
      hits = hits.filter((p) => world.accessLevel(ctx.user, p) >= ACCESS.owner);
    }
    const asc = str(ctx.input.sort) === "asc";
    const by = str(ctx.input.order_by) ?? "created_at";
    hits.sort((a, b) => {
      const c = by === "id"
        ? a.id - b.id
        : by === "path"
        ? a.path.localeCompare(b.path)
        : by === "last_activity_at"
        ? a.lastActivityAt.localeCompare(b.lastActivityAt) || a.id - b.id
        : a.createdAt.localeCompare(b.createdAt) || a.id - b.id;
      return asc ? c : -c;
    });
    const simple = bool(ctx.input.simple) === true;
    const empties = new Map<number, boolean>();
    for (const p of hits) empties.set(p.id, await ctx.gl.isEmpty(p));
    return paginate(
      ctx,
      hits,
      (p) =>
        simple
          ? ctx.gl.present.projectSimple(p)
          : ctx.gl.present.project(p, ctx.user, empties.get(p.id)!),
    );
  });

  r.add("GET", "/projects/:id", async (ctx) => {
    const p = projectOf(ctx);
    return json(ctx.gl.present.project(p, ctx.user, await ctx.gl.isEmpty(p)));
  });

  r.add("GET", "/projects/:id/members/all/:user_id", (ctx) => {
    const p = projectOf(ctx);
    const u = ctx.gl.world.users.get(Number(ctx.params.user_id));
    const held = u ? ctx.gl.world.memberRecord(u, { kind: "project", project: p }) : null;
    if (!u || held === null) return notFound("Member");
    return json(ctx.gl.present.member(u, held.level, held.state));
  });

  r.add("GET", "/projects/:id/members/all", (ctx) => {
    const p = projectOf(ctx);
    const members = [...ctx.gl.world.users.values()].flatMap((u) => {
      const held = ctx.gl.world.memberRecord(u, { kind: "project", project: p });
      return held === null ? [] : [{ u, held }];
    });
    return paginate(ctx, members, (m) => ctx.gl.present.member(m.u, m.held.level, m.held.state));
  });

  r.add("GET", "/projects/:id/labels", (ctx) => {
    const p = projectOf(ctx);
    // `include_ancestor_groups` defaults to true, as GitLab's.
    const withGroups = bool(ctx.input.include_ancestor_groups) !== false;
    return paginate(ctx, ctx.gl.world.labelsOf(p, withGroups), (l) => ctx.gl.present.label(l, p));
  });

  r.add("POST", "/projects/:id/labels", (ctx) => {
    const p = projectOf(ctx);
    need(ctx, p, ACCESS.reporter);
    const name = str(ctx.input.name);
    if (!name) return missing("name");
    const color = str(ctx.input.color);
    if (!color) return missing("color");
    if (ctx.gl.world.labelsOf(p, false).some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      return json({ message: "Label already exists" }, 409);
    }
    const label = {
      id: ctx.gl.world.nextId("label"),
      name,
      color,
      description: str(ctx.input.description),
      groupId: null,
    };
    p.labels.push(label);
    return json(ctx.gl.present.label(label, p), 201);
  });

  r.add("GET", "/projects/:id/repository/commits/:sha/statuses", (ctx) => {
    const p = codeProjectOf(ctx);
    const sha = ctx.params.sha!;
    const ref = str(ctx.input.ref);
    const name = str(ctx.input.name);
    let hits = ctx.gl.world.statuses.filter((s) =>
      s.projectId === p.id && s.sha === sha && (ref === null || s.ref === ref) &&
      (name === null || s.name === name)
    );
    // Without `all`, only the latest status per name, as GitLab's.
    if (bool(ctx.input.all) !== true) {
      const latest = new Map<string, (typeof hits)[number]>();
      for (const s of hits) latest.set(s.name, s);
      hits = [...latest.values()];
    }
    return paginate(ctx, hits.sort((a, b) => b.id - a.id), (s) => ctx.gl.present.status(s));
  });

  r.add("POST", "/projects/:id/statuses/:sha", async (ctx) => {
    const p = projectOf(ctx);
    const user = need(ctx, p, ACCESS.developer);
    const sha = ctx.params.sha!;
    const state = str(ctx.input.state);
    if (!state) return missing("state");
    if (!/^[0-9a-f]{40}$/.test(sha) || !(await revParse(p.gitDir, sha))) {
      return notFound("Commit");
    }
    // Verified on GitLab 17.11: without a `ref`, the commit's pipeline's ref, else the first
    // branch (by name) holding the commit; a commit no branch holds — a fork merge request's
    // head in the target project — is GitLab's 404 "References for commit".
    const ref = str(ctx.input.ref) ??
      ctx.gl.world.statuses.findLast((s) => s.projectId === p.id && s.sha === sha)?.ref ??
      (await branchesContaining(p.gitDir, sha))[0];
    if (ref === undefined) return notFound("References for commit");
    // A status starts a pipeline for its ref: a protected branch's takes what pushing it takes.
    if (p.protectedBranches.has(ref) && !ctx.gl.world.canPushBranch(user, p, ref)) {
      throw new ApiError(403, { message: "403 Forbidden" });
    }
    const name = str(ctx.input.name) ?? str(ctx.input.context) ?? "default";
    const description = str(ctx.input.description);
    if (description !== null && description.length > 255) {
      return json({ message: { description: ["is too long (maximum is 255 characters)"] } }, 400);
    }
    const status = ctx.gl.postStatus(user, p, {
      sha,
      state,
      ref,
      name,
      targetUrl: str(ctx.input.target_url),
      description,
    });
    return json(ctx.gl.present.status(status), 201);
  });

  // The merge requests of this project whose head is the commit (GitLab lists every one whose
  // commits include it; the head is what ryph asks about).
  r.add("GET", "/projects/:id/repository/commits/:sha/merge_requests", async (ctx) => {
    const p = codeProjectOf(ctx);
    const sha = await revParse(p.gitDir, ctx.params.sha!);
    if (!sha) return notFound("Commit");
    const hits = ctx.gl.world.mergeRequests.filter((m) =>
      m.projectId === p.id && m.headSha === sha
    );
    return paginate(ctx, hits, (m) => ctx.gl.present.mergeRequest(m));
  });

  r.add("GET", "/projects/:id/repository/commits/:sha", async (ctx) => {
    const p = codeProjectOf(ctx);
    const sha = await revParse(p.gitDir, ctx.params.sha!);
    if (!sha) return notFound("Commit");
    const c = (await log(p.gitDir, sha, true))[0]!;
    return json(ctx.gl.present.commit(c, p));
  });

  r.add("GET", "/projects/:id/repository/branches/:branch", async (ctx) => {
    const p = codeProjectOf(ctx);
    const branch = ctx.params.branch!;
    const sha = await revParse(p.gitDir, `refs/heads/${branch}`);
    if (!sha) return notFound("Branch");
    const c = (await log(p.gitDir, sha, true))[0]!;
    return json({
      name: branch,
      merged: false,
      protected: p.protectedBranches.has(branch),
      default: branch === p.defaultBranch,
      developers_can_push: !p.protectedBranches.has(branch),
      developers_can_merge: !p.protectedBranches.has(branch),
      can_push: ctx.user ? ctx.gl.world.canPushBranch(ctx.user, p, branch) : false,
      web_url: `${ctx.gl.present.projectWebUrl(p)}/-/tree/${branch}`,
      commit: ctx.gl.present.commit(c, p),
    });
  });

  r.add("POST", "/projects/:id/uploads", async (ctx) => {
    const p = projectOf(ctx);
    const user = signedIn(ctx);
    if (!ctx.gl.world.can(user, p, ACCESS.guest) && p.visibility === "private") {
      throw new ApiError(403, { message: "403 Forbidden" });
    }
    const file = ctx.form?.get("file");
    if (!file || typeof file === "string") return missing("file");
    // GitLab keeps a sanitised name: anything but a word character, `.`, `-` or `+` becomes `_`
    // ("shot one.png" is "shot_one.png", verified on GitLab 17.11).
    const filename = ((file as File).name || "file").replace(/[^\p{L}\p{N}_.+-]/gu, "_");
    const upload = {
      id: ctx.gl.world.nextId("upload"),
      projectId: p.id,
      secret: hex32(),
      filename,
      contentType: (file as File).type || "application/octet-stream",
      bytes: new Uint8Array(await (file as File).arrayBuffer()),
    };
    ctx.gl.world.uploads.push(upload);
    return json(uploadJson(upload.id, upload.secret, filename, upload.contentType, p), 201);
  });

  r.add("GET", "/projects/:id/uploads/:secret/:filename", (ctx) => {
    const p = projectOf(ctx);
    // The route arrived in 17.4; an older instance has no such path.
    if (!versionAtLeast(ctx.gl.version, 17, 4)) return fail404();
    return serveUpload(ctx, p, ctx.params.secret!, ctx.params.filename!, { api: true });
  });

  r.add("GET", "/projects/:id/hooks", (ctx) => {
    const p = projectOf(ctx);
    need(ctx, p, ACCESS.maintainer);
    return paginate(ctx, p.hooks, (h) => ctx.gl.present.hook(h, p));
  });

  r.add("POST", "/projects/:id/hooks", (ctx) => {
    const p = projectOf(ctx);
    need(ctx, p, ACCESS.maintainer);
    const url = str(ctx.input.url);
    if (!url) return missing("url");
    const hook = ctx.gl.addHook(p, {
      url,
      token: str(ctx.input.token),
      pushEvents: bool(ctx.input.push_events) ?? true,
      pushEventsBranchFilter: str(ctx.input.push_events_branch_filter),
      noteEvents: bool(ctx.input.note_events) ?? false,
      mergeRequestsEvents: bool(ctx.input.merge_requests_events) ?? false,
      issuesEvents: bool(ctx.input.issues_events) ?? false,
      confidentialNoteEvents: bool(ctx.input.confidential_note_events) ?? false,
      confidentialIssuesEvents: bool(ctx.input.confidential_issues_events) ?? false,
    });
    return json(ctx.gl.present.hook(hook, p), 201);
  });

  r.add("DELETE", "/projects/:id/hooks/:hook_id", (ctx) => {
    const p = projectOf(ctx);
    need(ctx, p, ACCESS.maintainer);
    const at = p.hooks.findIndex((h) => h.id === Number(ctx.params.hook_id));
    if (at === -1) return notFound("Project Hook");
    p.hooks.splice(at, 1);
    return new Response(null, { status: 204 });
  });

  r.add("GET", "/projects/:id/protected_branches", (ctx) => {
    const p = projectOf(ctx);
    need(ctx, p, ACCESS.maintainer);
    const names = [...p.protectedBranches];
    return paginate(ctx, names, (name) => ({
      name,
      push_access_levels: [{ access_level: 40, access_level_description: "Maintainers" }],
      merge_access_levels: [{ access_level: 40, access_level_description: "Maintainers" }],
      allow_force_push: false,
    }));
  });

  r.add("GET", "/projects/:id/repository/tree", async (ctx) => {
    const p = codeProjectOf(ctx);
    const ref = str(ctx.input.ref) ?? p.defaultBranch;
    const sha = await revParse(p.gitDir, ref);
    if (!sha) return notFound("Tree");
    const out = await git(p.gitDir, ["ls-tree", "-r", "--full-tree", sha]);
    const entries = out.stdout.split("\n").filter(Boolean).map((l) => {
      const [meta, path] = l.split("\t");
      const [mode, type, id] = meta!.split(" ");
      return { id, name: path!.split("/").at(-1), type, path, mode };
    });
    return paginate(ctx, entries, (e) => e);
  });

  r.add("GET", "/projects/:id/repository/files/:file_path/raw", async (ctx) => {
    const p = codeProjectOf(ctx);
    const ref = str(ctx.input.ref) ?? p.defaultBranch;
    const res = await git(p.gitDir, ["cat-file", "blob", `${ref}:${ctx.params.file_path}`], {
      ok: [128],
    });
    if (res.code !== 0) return notFound("File");
    return new Response(res.stdout, { headers: { "content-type": "text/plain; charset=utf-8" } });
  });
}

const fail404 = () => json({ error: "404 Not Found" }, 404);

export function versionAtLeast(version: string, major: number, minor: number): boolean {
  const [a = 0, b = 0] = version.split(".").map(Number);
  return a > major || (a === major && b >= minor);
}

export function uploadJson(
  id: number,
  secret: string,
  filename: string,
  contentType: string,
  p: Project,
) {
  const url = `/uploads/${secret}/${encodeURIComponent(filename)}`;
  const image = contentType.startsWith("image/");
  return {
    id,
    alt: filename.replace(/\.[^.]*$/, ""),
    url,
    full_path: `/-/project/${p.id}/uploads/${secret}/${encodeURIComponent(filename)}`,
    markdown: `${image ? "!" : ""}[${filename.replace(/\.[^.]*$/, "")}](${url})`,
  };
}

/** An upload's bytes, when it belongs to `p` under that secret and filename. The API serves them
 * as GitLab 17.11 does: `application/octet-stream`, as an attachment, to a Developer as to anyone
 * who may read the project. */
export function serveUpload(
  ctx: Pick<Ctx, "gl">,
  p: Project,
  secret: string,
  filename: string,
  opts: { api?: boolean } = {},
): Response {
  const u = ctx.gl.world.uploads.find((x) =>
    x.projectId === p.id && x.secret === secret && x.filename === filename
  );
  if (!u) return json({ message: "404 Not Found" }, 404);
  return new Response(u.bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "content-type": opts.api ? "application/octet-stream" : u.contentType,
      "content-length": String(u.bytes.byteLength),
      "content-disposition": `${opts.api ? "attachment" : "inline"}; filename="${u.filename}"`,
    },
  });
}
