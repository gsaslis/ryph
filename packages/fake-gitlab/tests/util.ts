// What the fake's own suites share: a seeded instance, a git CLI kept away from the machine's
// configuration, and a receiver for webhook deliveries.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "@ryph/process";
import { serve } from "@ryph/service";
import { type FakeGitlab, type FakeGitlabOptions, startFakeGitlab } from "../src/mod.ts";

/**
 * A fake with the cast every suite uses: `root` (admin), `ryph-bot` (bot, Developer on
 * `acme/widgets`), `maya` (Maintainer of the `acme` group), `dev` (Developer on
 * `acme/widgets`), `guest` (Guest on it), `outsider` (no membership); `acme/widgets` is private
 * with a README on `main`, nested under `acme` > `acme/platform` as `acme/platform/widgets`.
 * Disposing it shuts it down.
 */
export async function seeded(opts: FakeGitlabOptions = {}): Promise<FakeGitlab & AsyncDisposable> {
  const started = await startFakeGitlab(opts);
  const fake = Object.assign(started, { [Symbol.asyncDispose]: () => started.shutdown() });
  fake.addUser({ username: "root", name: "Administrator", admin: true });
  fake.addUser({ username: "ryph-bot", name: "ryph", bot: true });
  fake.addUser({ username: "maya", name: "Maya Maintainer" });
  fake.addUser({ username: "dev", name: "Dee Developer" });
  fake.addUser({ username: "guest", name: "Gus Guest" });
  fake.addUser({ username: "outsider", name: "Otto Outsider" });
  fake.addGroup("acme");
  fake.addGroup("acme/platform");
  fake.addMember("acme", "maya", "maintainer");
  await fake.addProject("acme/platform/widgets", {
    files: {
      "README.md": "# widgets\n",
      "src/app.ts": "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
    },
  });
  fake.addMember("acme/platform/widgets", "ryph-bot", "developer");
  fake.addMember("acme/platform/widgets", "dev", "developer");
  fake.addMember("acme/platform/widgets", "guest", "guest");
  return fake;
}

export const WIDGETS = "acme/platform/widgets";

/** git, with no global or system config and no prompt. Answers stdout and stderr; throws on a
 * failure unless `allowFail`. */
export async function gitCli(
  args: string[],
  opts: { cwd?: string; allowFail?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await command("git", {
    args,
    cwd: opts.cwd,
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      // An editor's askpass (VS Code sets one) would be asked for the password on a 401 and hang.
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdin: "null",
  }).output();
  const dec = new TextDecoder();
  const res = { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
  if (out.code !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res;
}

/** A clone URL carrying `oauth2:<token>`, as ryph's `fetchAuth` frames it. */
export function cloneUrl(fake: FakeGitlab, path: string, token?: string): string {
  const u = new URL(`${fake.url}/${path}.git`);
  if (token) {
    u.username = "oauth2";
    u.password = token;
  }
  return u.toString();
}

export async function tempDir(): Promise<{ path: string; [Symbol.asyncDispose](): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "fake-gitlab-test-"));
  return { path, [Symbol.asyncDispose]: () => rm(path, { recursive: true, force: true }) };
}

/** A webhook payload, read loosely: the assertions on it are its schema. */
// oxlint-disable-next-line no-explicit-any
export type Payload = Record<string, any>;

export interface Received {
  headers: Record<string, string>;
  body: Payload;
  url: string;
}

/**
 * A webhook receiver: every request it gets, answering `status`. The fake sends deliveries
 * concurrently, as GitLab does, so they can land out of order; given the fake's `deliveries`,
 * `of` answers them in the order they were sent instead.
 */
export async function receiver(
  status = 200,
  sent?: readonly { headers: Record<string, string> }[],
) {
  const got: Received[] = [];
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    got.push({
      headers: Object.fromEntries(req.headers.entries()),
      body: await req.json() as Payload,
      url: req.url,
    });
    return new Response("ok", { status });
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}/v1/hooks/gitlab`,
    got,
    of: (event: string) => {
      const of = got.filter((g) => g.headers["x-gitlab-event"] === event);
      if (!sent) return of;
      const order = (g: Received) =>
        sent.findIndex((d) =>
          d.headers["x-gitlab-event-uuid"] === g.headers["x-gitlab-event-uuid"]
        );
      return of.sort((a, b) => order(a) - order(b));
    },
    shutdown: () => server.shutdown(),
  };
}
