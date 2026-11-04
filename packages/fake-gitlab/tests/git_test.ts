// Git over smart HTTP with a real git client: clone and push as `oauth2:<token>`, GitLab's
// refusals (protected branch, force push, no access), merge request heads, push options, and
// pushing to a fork through `allow_collaboration`.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { revParse } from "../src/git/repo.ts";
import { cloneUrl, gitCli, seeded, tempDir, WIDGETS } from "./util.ts";

async function cloneAs(
  fake: Awaited<ReturnType<typeof seeded>>,
  dir: string,
  username: string,
  path = WIDGETS,
) {
  const token = fake.token(username);
  await gitCli(["clone", "--quiet", cloneUrl(fake, path, token), dir]);
  return token;
}

async function commitIn(dir: string, file: string, content: string, message = "change") {
  await writeFile(join(dir, file), content);
  await gitCli(["add", file], { cwd: dir });
  await gitCli(["commit", "--quiet", "-m", message], { cwd: dir });
}

test("clone and push a branch as a Developer; the default branch is protected", async () => {
  await using fake = await seeded();
  await using tmp = await tempDir();
  const dir = join(tmp.path, "w");
  await cloneAs(fake, dir, "ryph-bot");
  assertEquals(
    (await gitCli(["log", "--format=%s"], { cwd: dir })).stdout.trim(),
    "Initial commit",
  );

  await gitCli(["checkout", "--quiet", "-b", "ryph/fix"], { cwd: dir });
  await commitIn(dir, "fix.txt", "fixed\n");
  await gitCli(["push", "--quiet", "origin", "ryph/fix"], { cwd: dir });
  const p = fake.world.project(WIDGETS)!;
  assertEquals(
    await revParse(p.gitDir, "refs/heads/ryph/fix"),
    (await gitCli(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim(),
  );

  // main: the Developer bot is refused with GitLab's sentence, through the hook.
  await gitCli(["checkout", "--quiet", "main"], { cwd: dir });
  await commitIn(dir, "main.txt", "x\n");
  const refused = await gitCli(["push", "origin", "main"], { cwd: dir, allowFail: true });
  assert(refused.code !== 0);
  assertStringIncludes(
    refused.stderr,
    "GitLab: You are not allowed to push code to protected branches on this project.",
  );
  assertStringIncludes(
    refused.stderr,
    "[remote rejected] main -> main (pre-receive hook declined)",
  );
});

test("force pushes: allowed on an unprotected branch, never on a protected one", async () => {
  await using fake = await seeded();
  await using tmp = await tempDir();
  const dir = join(tmp.path, "w");
  await cloneAs(fake, dir, "maya");
  await gitCli(["checkout", "--quiet", "-b", "topic"], { cwd: dir });
  await commitIn(dir, "a.txt", "a\n");
  await gitCli(["push", "--quiet", "origin", "topic"], { cwd: dir });
  await gitCli(["commit", "--quiet", "--amend", "-m", "rewritten"], { cwd: dir });
  await gitCli(["push", "--quiet", "--force-with-lease", "origin", "topic"], { cwd: dir });

  // A Maintainer pushes main, but not by force.
  await gitCli(["checkout", "--quiet", "main"], { cwd: dir });
  await commitIn(dir, "b.txt", "b\n");
  await gitCli(["push", "--quiet", "origin", "main"], { cwd: dir });
  await gitCli(["commit", "--quiet", "--amend", "-m", "rewrite main"], { cwd: dir });
  const forced = await gitCli(["push", "--force", "origin", "main"], { cwd: dir, allowFail: true });
  assertStringIncludes(
    forced.stderr,
    "You are not allowed to force push code to a protected branch on this project.",
  );
  const deleted = await gitCli(["push", "origin", ":main"], { cwd: dir, allowFail: true });
  assertStringIncludes(
    deleted.stderr,
    "You can only delete protected branches using the web interface.",
  );
});

test("access: anonymous challenged, outsiders told not found, Guests and read-only tokens may not push", async () => {
  await using fake = await seeded();
  await using tmp = await tempDir();
  const anon = await gitCli(["ls-remote", cloneUrl(fake, WIDGETS)], { allowFail: true });
  assert(anon.code !== 0);
  const outsider = await gitCli(["ls-remote", cloneUrl(fake, WIDGETS, fake.token("outsider"))], {
    allowFail: true,
  });
  assert(outsider.code !== 0);
  const bad = await gitCli(["ls-remote", cloneUrl(fake, WIDGETS, "glpat-wrong")], {
    allowFail: true,
  });
  assert(bad.code !== 0);
  // Raw answers, as GitLab's.
  const raw = await fetch(`${fake.url}/${WIDGETS}.git/info/refs?service=git-upload-pack`);
  assertEquals([raw.status, raw.headers.get("www-authenticate")], [401, 'Basic realm="GitLab"']);
  const auth = `Basic ${btoa(`oauth2:${fake.token("outsider")}`)}`;
  const hidden = await fetch(`${fake.url}/${WIDGETS}.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: auth },
  });
  assertEquals(hidden.status, 404);
  assertStringIncludes(await hidden.text(), "The project you were looking for could not be found");

  // A Guest of a private project cannot even read code.
  const guest = await gitCli(["ls-remote", cloneUrl(fake, WIDGETS, fake.token("guest"))], {
    allowFail: true,
  });
  assert(guest.code !== 0);

  // A read_repository token fetches but cannot push.
  const reader = fake.token("dev", { scopes: ["read_repository"] });
  await gitCli(["clone", "--quiet", cloneUrl(fake, WIDGETS, reader), join(tmp.path, "r")]);
  const push = await fetch(`${fake.url}/${WIDGETS}.git/info/refs?service=git-receive-pack`, {
    headers: { authorization: `Basic ${btoa(`oauth2:${reader}`)}` },
  });
  assertEquals(push.status, 403);

  // A public project clones anonymously.
  await fake.addProject("acme/open", { visibility: "public", files: { "a": "a\n" } });
  await gitCli(["clone", "--quiet", cloneUrl(fake, "acme/open"), join(tmp.path, "o")]);
});

test("a push moves its merge request: the head ref, an update hook with oldrev, a system note", async () => {
  await using fake = await seeded();
  await using tmp = await tempDir();
  const dir = join(tmp.path, "w");
  await cloneAs(fake, dir, "dev");
  await gitCli(["checkout", "--quiet", "-b", "feat"], { cwd: dir });
  await commitIn(dir, "f.txt", "1\n");
  await gitCli(["push", "--quiet", "origin", "feat"], { cwd: dir });
  const mr = await fake.openMergeRequest(WIDGETS, {
    as: "dev",
    sourceBranch: "feat",
    title: "Feat",
  });
  const first = mr.headSha;
  await commitIn(dir, "f.txt", "2\n");
  await gitCli(["push", "--quiet", "origin", "feat"], { cwd: dir });
  const p = fake.world.project(WIDGETS)!;
  const second = (await gitCli(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
  assertEquals(mr.headSha, second);
  assertEquals(await revParse(p.gitDir, "refs/merge-requests/1/head"), second);
  assert(
    mr.discussions.some((d) => d.notes[0]!.system && d.notes[0]!.body.startsWith("added 1 commit")),
  );
  assert(first !== second);

  // The head ref fetches, as ryph's gateway fetches `merge-requests/<iid>/head`.
  const other = join(tmp.path, "o");
  await cloneAs(fake, other, "ryph-bot");
  await gitCli(["fetch", "--quiet", "origin", "refs/merge-requests/1/head:mr-1"], { cwd: other });
  assertEquals((await gitCli(["rev-parse", "mr-1"], { cwd: other })).stdout.trim(), second);
  // Nobody pushes into the merge request namespace.
  const sneaky = await gitCli(["push", "origin", "HEAD:refs/merge-requests/1/head"], {
    cwd: other,
    allowFail: true,
  });
  assert(sneaky.code !== 0);

  // Pushing the head into main by hand merges it.
  const maya = join(tmp.path, "m");
  await cloneAs(fake, maya, "maya");
  await gitCli(["fetch", "--quiet", "origin", "feat"], { cwd: maya });
  await gitCli(["merge", "--quiet", "--ff-only", "origin/feat"], { cwd: maya });
  await gitCli(["push", "--quiet", "origin", "main"], { cwd: maya });
  assertEquals(mr.state, "merged");
});

test("push options: merge_request.create opens one, titled and targeted", async () => {
  await using fake = await seeded();
  await using tmp = await tempDir();
  const dir = join(tmp.path, "w");
  await cloneAs(fake, dir, "ryph-bot");
  await gitCli(["checkout", "--quiet", "-b", "ryph/opt"], { cwd: dir });
  await commitIn(dir, "o.txt", "o\n");
  await gitCli([
    "push",
    "--quiet",
    "-o",
    "merge_request.create",
    "-o",
    "merge_request.title=Via push",
    "-o",
    "merge_request.target=main",
    "-o",
    "merge_request.draft",
    "origin",
    "ryph/opt",
  ], { cwd: dir });
  const mr = fake.world.mergeRequests.at(-1)!;
  assertEquals([mr.title, mr.sourceBranch, mr.targetBranch], [
    "Draft: Via push",
    "ryph/opt",
    "main",
  ]);
});

test("fork pushes: allow_collaboration lets a target Maintainer push the source branch, a Developer not", async () => {
  await using fake = await seeded();
  await using tmp = await tempDir();
  const fork = await fake.fork(WIDGETS, "outsider");
  await fake.commit(fork.path, { as: "outsider", branch: "patch", files: { "p.txt": "p\n" } });
  // GitLab lets a fork's merge request allow collaboration only when neither project is private.
  const parent = fake.world.project(WIDGETS)!;
  parent.visibility = "internal";
  fork.visibility = "internal";
  const mr = await fake.openMergeRequest(WIDGETS, {
    as: "outsider",
    sourceProject: fork.path,
    sourceBranch: "patch",
    title: "Fork",
    allowCollaboration: true,
  });

  // maya (Maintainer of the target, which has a protected main) pushes the fork's branch.
  const dir = join(tmp.path, "m");
  const token = fake.token("maya");
  await gitCli(["clone", "--quiet", "--branch", "patch", cloneUrl(fake, fork.path, token), dir]);
  await commitIn(dir, "p.txt", "maintainer edit\n");
  await gitCli(["push", "--quiet", "origin", "patch"], { cwd: dir });
  assertEquals(mr.headSha, (await gitCli(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim());
  // …but no other branch of the fork.
  const other = await gitCli(["push", "origin", "HEAD:refs/heads/elsewhere"], {
    cwd: dir,
    allowFail: true,
  });
  assertStringIncludes(other.stderr, "You are not allowed to push code to this project.");

  // The Developer bot cannot merge into protected main, so GitLab's rule refuses it the fork:
  // the HTTP 403 GitLab 17.11 answers a push to a project one may read and not push.
  const bot = await fetch(`${fake.url}/${fork.path}.git/info/refs?service=git-receive-pack`, {
    headers: { authorization: `Basic ${btoa(`oauth2:${fake.token("ryph-bot")}`)}` },
  });
  assertEquals(bot.status, 403);
  assertStringIncludes(await bot.text(), "You are not allowed to push code to this project.");
  // Unprotect main and it may.
  fake.protectBranch(WIDGETS, "main", false);
  const now = await fetch(`${fake.url}/${fork.path}.git/info/refs?service=git-receive-pack`, {
    headers: { authorization: `Basic ${btoa(`oauth2:${fake.token("ryph-bot")}`)}` },
  });
  assertEquals(now.status, 200);
});
