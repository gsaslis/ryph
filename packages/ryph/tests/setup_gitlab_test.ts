// The wizard's GitLab question: the instance, whose account, and how the token is held — what
// each set of answers writes, through the same scripted terminal as the rest of the wizard.

import { test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals } from "@std/assert";
import { answeringPrompter, NeedsAnswer } from "../src/prompt.ts";
import { parseSetupArgs, runWizard } from "../src/setup.ts";
import {
  GITLAB_BOT_KEYS,
  gitlabInstanceUrl,
  glabTokenCommand,
  glabTokenCommands,
  personalAccessTokenUrl,
} from "../src/setup_gitlab.ts";
import { context, RUNNER, Scripted } from "./wizard_double.ts";

/** Everything before the GitLab question: key skipped, docker, no local root, GitHub skipped. */
const BEFORE = ["3", ...RUNNER, "2", ""];
/** And after it: mail skipped. */
const AFTER = [""];

const script = (...gitlab: string[]) => new Scripted([...BEFORE, ...gitlab, ...AFTER]);

/** What glab's credential helper is asked for gitlab.com, its password line kept. */
const GLAB_GITLAB_COM = "printf 'protocol=https\\nhost=gitlab.com\\n\\n' | " +
  "glab auth git-credential get | sed -n 's/^password=//p'";

/** A glab that has a login for `hosts` alone, answering the command for it. */
const glabFor = (...hosts: string[]) => {
  const asked: string[] = [];
  return {
    asked,
    gitlabCli: (instance: string) => {
      const host = new URL(instance).host;
      asked.push(host);
      return Promise.resolve(hosts.includes(host) ? glabTokenCommands(instance)[0] : null);
    },
  };
};

test("GitLab is skipped by default, and writes nothing", async () => {
  const io = script("");
  const plan = await runWizard(io, context());
  for (const key of plan.config.keys()) assert(!key.startsWith("RYPH_GITLAB_"), key);
  assert(io.transcript().includes("GitLab"));
  assert(plan.notes.some((note) => note.includes("no way to reach a repository")));
});

test("acting as you on gitlab.com takes glab's login, and stores no token", async () => {
  const glab = glabFor("gitlab.com");
  // act as you, the default instance, the default token way (glab's login).
  const io = script("1", "", "");
  const plan = await runWizard(io, context({ gitlabCli: glab.gitlabCli }));
  assertEquals(glab.asked, ["gitlab.com"]);
  assertEquals(plan.config.get("RYPH_GITLAB_MODE"), "user");
  assertEquals(
    plan.config.get("RYPH_GITLAB_TOKEN_COMMAND"),
    GLAB_GITLAB_COM,
  );
  assertEquals(plan.config.get("RYPH_GITLAB_TOKEN"), null, "the two are exclusive");
  // gitlab.com is the default: the setting is removed rather than written.
  assertEquals(plan.config.get("RYPH_GITLAB_URL"), null);
  assertEquals(plan.notes.some((note) => note.includes("no way to reach")), false);
  // The pipeline caveat is said where the token is chosen.
  assert(io.transcript().includes(".gitlab-ci.yml"));
});

test("a self-managed instance under a prefix, with no glab login for it, takes a pasted token", async () => {
  const glab = glabFor("gitlab.com");
  const io = script("1", "https://git.example.com/gitlab/", "glpat-secret");
  const plan = await runWizard(io, context({ gitlabCli: glab.gitlabCli }));
  assertEquals(glab.asked, ["git.example.com"]);
  assertEquals(plan.config.get("RYPH_GITLAB_URL"), "https://git.example.com/gitlab");
  assertEquals(plan.config.get("RYPH_GITLAB_MODE"), "user");
  assertEquals(plan.config.get("RYPH_GITLAB_TOKEN"), "glpat-secret");
  assertEquals(plan.config.get("RYPH_GITLAB_TOKEN_COMMAND"), null);
  const said = io.transcript();
  assert(said.includes("glab auth login --hostname git.example.com"));
  assert(
    said.includes(
      "https://git.example.com/gitlab/-/user_settings/personal_access_tokens?name=ryph&scopes=" +
        "api,read_repository,write_repository",
    ),
  );
  assertEquals(said.includes("glpat-secret"), false, "never echoed");
});

test("a bot account is never offered: the binary has no sign-in to connect a project with", async () => {
  // A bot-mode project is connected and written to by a person whose GitLab identity is linked,
  // which takes GitLab sign-in the wizard never sets up: GitHub's question offers no App either.
  const glab = glabFor("gitlab.com");
  for (const current of [new Map<string, string>(), new Map([["RYPH_GITLAB_TOKEN", "glpat"]])]) {
    const io = script("");
    await runWizard(io, context({ current, gitlabCli: glab.gitlabCli }));
    const gitlab = io.offered.find((select) => select.question === "GitLab");
    assert(gitlab !== undefined);
    assertEquals(gitlab.labels.some((label) => /bot/i.test(label)), false, gitlab.labels.join());
  }
});

test("a hand-configured bot is kept as it is", async () => {
  const current = new Map([
    ["RYPH_GITLAB_MODE", "bot"],
    ["RYPH_GITLAB_TOKEN", "glpat-bot"],
    ["RYPH_GITLAB_WEBHOOK_SECRET", "whsec"],
  ]);
  const io = script("");
  const plan = await runWizard(io, context({ current }));
  for (const key of plan.config.keys()) assert(!key.startsWith("RYPH_GITLAB_"), key);
  const gitlab = io.offered.find((select) => select.question === "GitLab");
  assertEquals(gitlab?.labels[0], "keep the current GitLab login");
});

test("a configured GitLab is kept by default, and an empty paste changes nothing", async () => {
  const current = new Map([
    ["RYPH_GITLAB_MODE", "user"],
    ["RYPH_GITLAB_TOKEN_COMMAND", GLAB_GITLAB_COM],
  ]);
  const io = script("");
  const plan = await runWizard(io, context({ current }));
  for (const key of plan.config.keys()) assert(!key.startsWith("RYPH_GITLAB_"), key);
  assertEquals(plan.notes.some((note) => note.includes("no way to reach")), false);

  // keep, as you, off: as you, with no glab, and an empty paste.
  const empty = script("2", "", "");
  const unchanged = await runWizard(empty, context({ current }));
  for (const key of unchanged.config.keys()) assert(!key.startsWith("RYPH_GITLAB_"), key);
  assert(unchanged.notes.some((note) => note.includes("GitLab settings were not changed")));
});

test("switching a bot to acting as you confirms, then clears the bot-only settings", async () => {
  const current = new Map([
    ["RYPH_GITLAB_MODE", "bot"],
    ["RYPH_GITLAB_TOKEN", "glpat-bot"],
    ["RYPH_GITLAB_WEBHOOK_SECRET", "whsec"],
    ["RYPH_GITLAB_GROUP", "acme"],
  ]);
  // keep, as you, off. As you; Enter at the confirmation is no.
  const declined = script("2", "");
  const kept = await runWizard(declined, context({ current }));
  const asked = declined.said.find((q) => q.includes("Remove them?"));
  assert(asked?.includes("RYPH_GITLAB_WEBHOOK_SECRET") && asked.includes("RYPH_GITLAB_GROUP"));
  for (const key of kept.config.keys()) assert(!key.startsWith("RYPH_GITLAB_"), key);

  const io = script("2", "y", "", "glpat-mine");
  const plan = await runWizard(io, context({ current }));
  assertEquals(plan.config.get("RYPH_GITLAB_MODE"), "user");
  assertEquals(plan.config.get("RYPH_GITLAB_TOKEN"), "glpat-mine");
  assertEquals(plan.config.get("RYPH_GITLAB_WEBHOOK_SECRET"), null);
  assertEquals(plan.config.get("RYPH_GITLAB_GROUP"), null);
  // Only what is set is removed.
  assertEquals(plan.config.has("RYPH_GITLAB_CLIENT_ID"), false);
  const note = plan.notes.find((n) => n.includes("removed the GitLab bot settings"));
  assert(note?.includes("RYPH_GITLAB_WEBHOOK_SECRET") && note.includes("RYPH_GITLAB_GROUP"));
});

test("turning GitLab off removes every GitLab setting", async () => {
  const current = new Map([
    ["RYPH_GITLAB_URL", "https://git.example.com"],
    ["RYPH_GITLAB_MODE", "bot"],
    ["RYPH_GITLAB_TOKEN", "glpat-bot"],
    ["RYPH_GITLAB_CLIENT_ID", "cid"],
    ["RYPH_GITLAB_CLIENT_SECRET", "csec"],
  ]);
  // keep, as you, off; yes to removing the bot settings.
  const plan = await runWizard(script("3", "y"), context({ current }));
  for (
    const key of [
      "RYPH_GITLAB_URL",
      "RYPH_GITLAB_MODE",
      "RYPH_GITLAB_TOKEN",
      "RYPH_GITLAB_TOKEN_COMMAND",
      "RYPH_GITLAB_CLIENT_ID",
      "RYPH_GITLAB_CLIENT_SECRET",
    ]
  ) {
    assertEquals(plan.config.get(key), null, key);
  }
  assert(GITLAB_BOT_KEYS.includes("RYPH_GITLAB_WEBHOOK_SECRET"));
});

test("an instance URL is read as the forge reads it", () => {
  assertEquals(gitlabInstanceUrl("https://gitlab.com"), "https://gitlab.com");
  assertEquals(gitlabInstanceUrl("gitlab.example.com/"), "https://gitlab.example.com");
  assertEquals(
    gitlabInstanceUrl("http://localhost:8929/gitlab//"),
    "http://localhost:8929/gitlab",
  );
  for (
    const bad of [
      "",
      "ftp://gitlab.com",
      "https://u:p@gitlab.com",
      "https://g.com/?a=1",
      "https://g.com/#x",
    ]
  ) {
    assertEquals(gitlabInstanceUrl(bad), null, bad);
  }
  assertEquals(
    personalAccessTokenUrl("https://gitlab.com"),
    "https://gitlab.com/-/user_settings/personal_access_tokens?name=ryph&scopes=api,read_repository,write_repository",
  );
});

test("glab is asked for the instance's host, and a hostile host is never a command", async () => {
  // The credential helper, not `glab config get token`: only the helper renews an OAuth
  // login's two-hour access token, so the forge's re-run after a 401 gets a live one.
  assertEquals(glabTokenCommands("http://git.example.com:8443/gitlab"), [
    "printf 'protocol=http\\nhost=git.example.com:8443\\n\\n' | " +
    "glab auth git-credential get | sed -n 's/^password=//p'",
  ]);
  for (const command of glabTokenCommands("https://gitlab.com")) {
    assert(!command.includes("config get token"), command);
  }
  assertEquals(glabTokenCommands("https://gitlab.com; rm -rf ~"), []);
  assertEquals(glabTokenCommands("ftp://gitlab.com"), []);
  assertEquals(glabTokenCommands("gitlab.com"), []);

  const probed: string[] = [];
  const found = await glabTokenCommand("https://gitlab.com", (command) => {
    probed.push(command);
    return Promise.resolve(true);
  });
  assertEquals(found, GLAB_GITLAB_COM);
  assertEquals(probed, [GLAB_GITLAB_COM]);
  assertEquals(await glabTokenCommand("https://gitlab.com", () => Promise.resolve(false)), null);
});

test("glab's command prints the password line of what its credential helper answers", async () => {
  // A stand-in glab on PATH answering as glab 1.123's helper does for an OAuth login.
  const dir = await mkdtemp(join(tmpdir(), "ryph-glab-"));
  try {
    await writeFile(
      join(dir, "glab"),
      [
        "#!/bin/sh",
        '[ "$1 $2 $3" = "auth git-credential get" ] || exit 1',
        'case "$(cat)" in *"host=gitlab.com"*) ;; *) exit 1 ;; esac',
        "echo 'capability[]=authtype'",
        "echo 'username=oauth2'",
        "echo 'password=fresh-access-token'",
        "echo 'password_expiry_utc=1760000000'",
        "echo 'oauth_refresh_token=rotated'",
        "",
      ].join("\n"),
    );
    await chmod(join(dir, "glab"), 0o755);
    const run = Bun.spawn(["sh", "-c", GLAB_GITLAB_COM], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      stdout: "pipe",
    });
    assertEquals(await new Response(run.stdout).text(), "fresh-access-token\n");
    assertEquals(await run.exited, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("flags answer the GitLab questions with no terminal: a token implies acting as you", async () => {
  const { answers } = parseSetupArgs([
    "--agent-image",
    "ryph-agent:dev",
    "--gitlab-url",
    "gitlab.example.com",
    "--gitlab-token",
    "glpat-x",
  ]);
  // glab has a login here, so the token flag is what turns its default (the CLI login) away.
  const io = answeringPrompter(answers, null, () => {});
  const plan = await runWizard(io, context({ ...glabFor("gitlab.example.com") }));
  assertEquals(plan.config.get("RYPH_GITLAB_URL"), "https://gitlab.example.com");
  assertEquals(plan.config.get("RYPH_GITLAB_MODE"), "user");
  assertEquals(plan.config.get("RYPH_GITLAB_TOKEN"), "glpat-x");
  assertEquals(plan.config.get("RYPH_GITLAB_TOKEN_COMMAND"), null);

  const cli = answeringPrompter(
    parseSetupArgs(["--agent-image", "a", "--gitlab-login", "cli"]).answers,
    null,
    () => {},
  );
  const viaGlab = await runWizard(cli, context({ ...glabFor("gitlab.com") }));
  assertEquals(viaGlab.config.get("RYPH_GITLAB_TOKEN_COMMAND"), GLAB_GITLAB_COM);

  // Nothing said about GitLab skips it, as a person pressing Enter would.
  const quiet = answeringPrompter(new Map([["agent-image", "a"]]), null, () => {});
  assert(!(await runWizard(quiet, context())).config.has("RYPH_GITLAB_MODE"));

  assert(
    (() => {
      try {
        parseSetupArgs(["--gitlab-login", "cli", "--gitlab-token", "x"]);
        return false;
      } catch (err) {
        return err instanceof NeedsAnswer;
      }
    })(),
    "a token beside the CLI login is a contradiction",
  );
});
