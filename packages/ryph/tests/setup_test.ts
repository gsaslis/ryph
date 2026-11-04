// The wizard's decisions, with the terminal and the machine scripted — the same seam the status
// block is tested through. What is asserted here is what a set of answers turns into on disk,
// because that is the only part a person ever sees again.

import { test } from "bun:test";
import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals } from "@std/assert";
import { command } from "@ryph/process";
import { answeringPrompter, NeedsAnswer } from "../src/prompt.ts";
import {
  applySetup,
  githubCliSignedIn,
  parseSetupArgs,
  runWizard,
  type SetupContext,
  SetupStopped,
  shouldRunSetup,
  suggestImage,
} from "../src/setup.ts";
import { describeSettings } from "../src/settings.ts";
import { readConfig } from "../src/config_file.ts";
import { context, RUNNER, Scripted } from "./wizard_double.ts";

test("the recommended path: mint a key, docker with an image, a local repo root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-repos-"));
  try {
    const io = new Scripted([
      "", // key: mint one now
      "ryph-agent:dev", // the agent image
      "ryph-browser:dev", // the browser image
      "", // internet access: allowlisted (docker cannot confine)
      "", // repositories: a directory on this machine
      root,
      "", // GitHub: skip (no CLI login here)
      "", // GitLab: skip
      "", // mail: skip
    ]);
    const plan = await runWizard(io, context());

    assertEquals(plan.key.action, "store");
    assert(plan.key.action === "store" && plan.key.minted);
    assertEquals(plan.config.get("RYPH_PROVISIONER"), "docker");
    assertEquals(plan.config.get("RYPH_AGENT_IMAGE"), "ryph-agent:dev");
    assertEquals(plan.config.get("RYPH_BROWSER_IMAGE"), "ryph-browser:dev");
    assertEquals(plan.config.get("RYPH_LOCAL_REPO_ROOT"), root);
    // Egress is wired rather than left for the operator to discover: a key to sign allowlists
    // with, and an address a container can actually dial.
    assertEquals(plan.config.get("RYPH_EGRESS"), "proxy");
    assertEquals(
      plan.config.get("RYPH_EGRESS_PROXY_URL"),
      "http://host.docker.internal:7460",
    );
    assertEquals((plan.config.get("RYPH_EGRESS_KEY") ?? "").length, 64);
    // And the listener stays on loopback. docker cannot confine a run, so the container keeps
    // its own default route and reaches this process at host.docker.internal without :7460
    // leaving localhost — and opening it anyway would publish a port that answers
    // Proxy-Authorization to the whole LAN, for a boundary this backend has already said it
    // does not enforce. A run's claim is not hard to come by: `docker inspect` shows it, and
    // every setup step reads HTTPS_PROXY by design.
    assertEquals(plan.config.get("RYPH_EGRESS_BIND"), null);
    assertEquals(
      plan.notes.length,
      0,
      "no caveats left on the recommended path now the port stays shut",
    );
  } finally {
    await rmdir(root);
  }
});

test("no agent image stops setup at that step, rather than turning the runner off", async () => {
  const io = new Scripted([
    "3", // key: skip
    " ", // no image
  ]);
  const stopped = await runWizard(io, context()).then(() => null, (err: Error) => err);

  // Docker without an image refuses to boot, and no provisioner at all is refused too: there is
  // nothing to write that runs anything, so nothing is.
  assert(stopped instanceof SetupStopped, String(stopped));
  assert(stopped.message.includes("bun run agent-image"), stopped.message);
  assert(stopped.message.includes("ryph setup"), stopped.message);
});

test("without docker setup stops before asking anything, and says how to fix it", async () => {
  const io = new Scripted([]); // a question asked would throw: no scripted answer left
  const stopped = await runWizard(
    io,
    context({
      docker: { available: false, reason: "docker is not running", fix: "start Docker Desktop" },
    }),
  ).then(() => null, (err: Error) => err);

  assert(stopped instanceof SetupStopped, String(stopped));
  assert(stopped.message.includes("docker is not running"), stopped.message);
  assert(stopped.message.includes("start Docker Desktop"), "the fix is named");
  assertEquals(io.said.some((line) => line.includes("Master key")), false);
});

test("an image already built on this machine is offered as the default", async () => {
  const io = new Scripted(["3", "", "", "", "2", "", "", ""]);
  const plan = await runWizard(
    io,
    context({
      agentImages: ["ryph-agent:dev"],
      browserImages: ["ryph-browser:dev"],
    }),
  );
  assertEquals(plan.config.get("RYPH_AGENT_IMAGE"), "ryph-agent:dev");
  assertEquals(
    plan.config.get("RYPH_BROWSER_IMAGE"),
    "ryph-browser:dev",
    "the browser the same task built is on by default under docker",
  );
});

test("docker with no browser image built says how to get one", async () => {
  // Nothing in the store and nothing typed: no browser, and a note naming the task, because an
  // agent switched to a browser would otherwise start every run without one and say so only there.
  const io = new Scripted(["3", "", "", "", "2", "", "", ""]);
  const plan = await runWizard(
    io,
    context({ agentImages: ["ryph-agent:dev"] }),
  );
  assertEquals(plan.config.get("RYPH_PROVISIONER"), "docker");
  assertEquals(plan.config.get("RYPH_BROWSER_IMAGE"), null);
  assert(plan.notes.some((note) => note.includes("bun run agent-image")));
});

/** What a binary built at a known commit offers when nothing is built locally. */
const PUBLISHED = {
  agent: "quay.io/ryph/ryph-agent:sha-0123456789ab",
  browser: "quay.io/ryph/ryph-browser:sha-0123456789ab",
  "run-gate": "quay.io/ryph/ryph-run-gate:sha-0123456789ab",
};

test("a binary with nothing built locally offers the published images, and says so", async () => {
  // key: skip; docker; agent and browser: the defaults; internet: confined (the default, since a
  // published gate counts as one); repos: skip; GitHub, GitLab, mail: skip.
  const io = new Scripted(["3", "", "", "", "2", "", "", ""]);
  const plan = await runWizard(
    io,
    context({
      publishedImages: PUBLISHED,
      confineDockerRuns: () => Promise.resolve({ confined: true }),
    }),
  );
  assertEquals(plan.config.get("RYPH_AGENT_IMAGE"), PUBLISHED.agent);
  assertEquals(plan.config.get("RYPH_BROWSER_IMAGE"), PUBLISHED.browser);
  assertEquals(plan.config.get("RYPH_DOCKER_GATE_IMAGE"), PUBLISHED["run-gate"]);
  assert(io.transcript().includes("published for this version of ryph"));
  assertEquals(io.transcript().includes("bun run agent-image"), false);
});

test("a local :dev build is preferred over the published image, and named as one", async () => {
  const io = new Scripted(["3", "", "", "", "2", "", "", ""]);
  const plan = await runWizard(
    io,
    context({
      publishedImages: PUBLISHED,
      agentImages: ["ryph-agent:old", "ryph-agent:dev"],
      gateImages: ["ryph-run-gate:dev"],
      confineDockerRuns: () => Promise.resolve({ confined: true }),
    }),
  );
  assertEquals(plan.config.get("RYPH_AGENT_IMAGE"), "ryph-agent:dev");
  // No local browser: the published one.
  assertEquals(plan.config.get("RYPH_BROWSER_IMAGE"), PUBLISHED.browser);
  assertEquals(plan.config.get("RYPH_DOCKER_GATE_IMAGE"), "ryph-run-gate:dev");
  assert(io.transcript().includes("Offering ryph-agent:dev — built on this machine"));
});

test("a binary pinned to its commit asks no image question and writes no image", async () => {
  // key: skip; docker; internet: confined; repos: skip; GitHub, GitLab, mail: skip. No image
  // answers: local :dev builds and an older binary's pin are both passed over.
  const io = new Scripted(["3", "", "2", "", "", ""]);
  const plan = await runWizard(
    io,
    context({
      publishedImages: PUBLISHED,
      imagesPinned: true,
      agentImages: ["ryph-agent:dev"],
      browserImages: ["ryph-browser:dev"],
      gateImages: ["ryph-run-gate:dev"],
      current: new Map([["RYPH_AGENT_IMAGE", "quay.io/ryph/ryph-agent:sha-ba9876543210"]]),
      confineDockerRuns: () => Promise.resolve({ confined: true }),
    }),
  );
  assertEquals(plan.config.get("RYPH_PROVISIONER"), "docker");
  // Null deletes: the default follows the binary, so an upgrade moves to its own images.
  assertEquals(plan.config.get("RYPH_AGENT_IMAGE"), null);
  assertEquals(plan.config.get("RYPH_BROWSER_IMAGE"), null);
  assertEquals(plan.config.get("RYPH_DOCKER_GATE_IMAGE"), null);
  assertEquals(plan.config.get("RYPH_DOCKER_RUN_NETWORK") !== undefined, true);
  assert(io.transcript().includes(`Agents run in ${PUBLISHED.agent}`));
  assertEquals(io.transcript().includes("Offering"), false);
});

test("a pinned binary keeps an image of your own, and still asks", async () => {
  // key: skip; docker; agent: keep mine:1; internet: confined; repos: skip; GitHub, GitLab,
  // mail: skip.
  const io = new Scripted(["3", "", "", "2", "", "", ""]);
  const plan = await runWizard(
    io,
    context({
      publishedImages: PUBLISHED,
      imagesPinned: true,
      current: new Map([["RYPH_AGENT_IMAGE", "mine:1"]]),
      confineDockerRuns: () => Promise.resolve({ confined: true }),
    }),
  );
  assertEquals(plan.config.get("RYPH_AGENT_IMAGE"), "mine:1");
  assertEquals(plan.config.get("RYPH_BROWSER_IMAGE"), null);
});

test("a pinned binary passes over what earlier setups wrote, and keeps a choice of yours", () => {
  const ctx = (image: string) => ({
    current: new Map([["RYPH_AGENT_IMAGE", image]]),
    publishedImages: PUBLISHED,
    imagesPinned: true,
  });
  const pick = (image: string) =>
    suggestImage("agent", ctx(image), ["ryph-agent:dev"], "RYPH_AGENT_IMAGE");
  // An older binary's pin, and a local build an earlier setup preferred.
  assertEquals(pick("quay.io/ryph/ryph-agent:sha-ba9876543210")?.from, "published");
  assertEquals(pick("quay.io/ryph/ryph-agent:0.1.0")?.from, "published");
  assertEquals(pick("ryph-agent:dev")?.from, "published");
  // Tracking edge is a choice.
  assertEquals(pick("quay.io/ryph/ryph-agent:edge"), {
    image: "quay.io/ryph/ryph-agent:edge",
    from: "configured",
  });
});

test("a binary turns the browser off with `off`, which unset cannot say", async () => {
  // Pinned, with `off` already set: no question, and the setting stays.
  const kept = new Scripted(["3", "", "2", "", "", ""]);
  const plan = await runWizard(
    kept,
    context({
      publishedImages: PUBLISHED,
      imagesPinned: true,
      current: new Map([["RYPH_BROWSER_IMAGE", "off"]]),
      confineDockerRuns: () => Promise.resolve({ confined: true }),
    }),
  );
  assertEquals(plan.config.has("RYPH_BROWSER_IMAGE"), false);
  assert(kept.transcript().includes("No browser for agents"));
  // Unpinned, answering `off` writes it rather than deleting the setting.
  const emptied = new Scripted(["3", "", "off", "", "2", "", "", ""]);
  const unpinned = await runWizard(
    emptied,
    context({
      publishedImages: PUBLISHED,
      confineDockerRuns: () => Promise.resolve({ confined: true }),
    }),
  );
  assertEquals(unpinned.config.get("RYPH_BROWSER_IMAGE"), "off");
});

test("a pinned binary passes over a configured gate that is gone, and keeps one that is there", () => {
  const gate = "RYPH_DOCKER_GATE_IMAGE";
  const ctx = (image: string) => ({
    current: new Map([[gate, image]]),
    publishedImages: PUBLISHED,
    imagesPinned: true,
  });
  assertEquals(
    suggestImage("run-gate", ctx("ryph-run-gate:gone"), [], gate, true),
    { image: PUBLISHED["run-gate"], from: "published" },
  );
  assertEquals(
    suggestImage("run-gate", ctx("mine-gate:1"), ["mine-gate:1"], gate, true),
    { image: "mine-gate:1", from: "configured" },
  );
});

test("which image is offered: configured, then local :dev, then published, then any local", () => {
  const ctx = (current: [string, string][] = [], published = PUBLISHED) => ({
    current: new Map(current),
    publishedImages: published,
  });
  assertEquals(
    suggestImage("agent", ctx([["RYPH_AGENT_IMAGE", "mine:1"]]), [], "RYPH_AGENT_IMAGE"),
    {
      image: "mine:1",
      from: "configured",
    },
  );
  assertEquals(
    suggestImage("agent", ctx(), ["ryph-agent:v2", "ryph-agent:dev"], "RYPH_AGENT_IMAGE"),
    { image: "ryph-agent:dev", from: "local build" },
  );
  assertEquals(suggestImage("agent", ctx(), ["ryph-agent:v2"], "RYPH_AGENT_IMAGE"), {
    image: PUBLISHED.agent,
    from: "published",
  });
  // From source there is nothing published: any local tag, or nothing.
  const source = { current: new Map<string, string>() };
  assertEquals(suggestImage("agent", source, ["ryph-agent:v2"], "RYPH_AGENT_IMAGE"), {
    image: "ryph-agent:v2",
    from: "local build",
  });
  assertEquals(suggestImage("agent", source, [], "RYPH_AGENT_IMAGE"), null);
  // A configured gate is kept only while it exists: locally, or as the published one.
  const gate = "RYPH_DOCKER_GATE_IMAGE";
  assertEquals(
    suggestImage("run-gate", ctx([[gate, "ryph-run-gate:gone"]]), [], gate, true)?.image,
    PUBLISHED["run-gate"],
  );
  assertEquals(
    suggestImage("run-gate", ctx([[gate, PUBLISHED["run-gate"]]]), [], gate, true)?.from,
    "configured",
  );
});

test("an existing master key is kept by default, and replacing it warns first", async () => {
  const keep = new Scripted(["", ...RUNNER, "2", "", "", ""]);
  const kept = await runWizard(keep, context({ storedKeyPath: "/tmp/ryph/secrets.key" }));
  assertEquals(kept.key.action, "keep");

  const replace = new Scripted(["2", ...RUNNER, "2", "", "", ""]); // mint a new one
  const replaced = await runWizard(replace, context({ storedKeyPath: "/tmp/ryph/secrets.key" }));
  assertEquals(replaced.key.action, "store");
  assert(
    replace.transcript().includes("deleted and re-added"),
    "replacing a key orphans everything it sealed, and that has to be said before it happens",
  );
});

test("a key from the environment is left alone", async () => {
  const io = new Scripted([...RUNNER, "2", "", "", ""]); // no key question: straight to the runner
  const plan = await runWizard(io, context({ keyFromEnv: true }));
  assertEquals(plan.key.action, "keep");
});

test("a pasted key is taken as given; a malformed one is not written over the top", async () => {
  const good = "a".repeat(64);
  const io = new Scripted(["2", good, ...RUNNER, "2", "", "", ""]);
  const plan = await runWizard(io, context());
  assert(plan.key.action === "store" && plan.key.hex === good && !plan.key.minted);

  const bad = new Scripted(["2", "nope", ...RUNNER, "2", "", "", ""]);
  const stopped = await runWizard(bad, context()).then(() => null, (e) => e);
  assert(stopped instanceof SetupStopped, "stopped, rather than a minted key nobody asked for");
});

test("the GitHub CLI login is the default where gh has one, and stores no token", async () => {
  const io = new Scripted([
    "3", // key: skip
    ...RUNNER, // docker
    "2", // repositories on this machine: skip
    "", // GitHub: the default, which is the CLI login
    "", // GitLab: skip
    "", // mail: skip
  ]);
  const plan = await runWizard(io, context({ githubCli: true }));
  assertEquals(plan.config.get("RYPH_GITHUB_TOKEN_COMMAND"), "gh auth token");
  assertEquals(plan.config.get("RYPH_GITHUB_TOKEN"), null, "the two are exclusive");
  assertEquals(plan.notes.some((note) => note.includes("no way to reach")), false);
});

test("without a CLI login the wizard says how to get one, and skips by default", async () => {
  const io = new Scripted(["3", ...RUNNER, "2", "", "", ""]);
  const plan = await runWizard(io, context());
  assert(io.transcript().includes("gh auth login"));
  assertEquals(plan.config.has("RYPH_GITHUB_TOKEN_COMMAND"), false);
  assert(plan.notes.some((note) => note.includes("no way to reach a repository")));
});

test("a pasted token names its permissions first and is never echoed", async () => {
  // With one configured, "keep" comes first and is the default: nothing is asked.
  const keep = new Scripted(["3", ...RUNNER, "2", "", "", ""]);
  const kept = await runWizard(
    keep,
    context({ current: new Map([["RYPH_GITHUB_TOKEN_COMMAND", "gh auth token"]]) }),
  );
  assertEquals(kept.config.has("RYPH_GITHUB_TOKEN"), false);
  assertEquals(kept.config.has("RYPH_GITHUB_TOKEN_COMMAND"), false);

  // GitHub: paste a token, the first choice where the CLI is not signed in.
  const paste = new Scripted(["3", ...RUNNER, "2", "1", "github_pat_secret", "", ""]);
  const pasted = await runWizard(paste, context());
  assertEquals(pasted.config.get("RYPH_GITHUB_TOKEN"), "github_pat_secret");
  assertEquals(pasted.config.get("RYPH_GITHUB_TOKEN_COMMAND"), null);
  const said = paste.transcript();
  for (const permission of ["Contents", "Pull requests", "Issues", "Metadata"]) {
    assert(said.includes(permission), `names ${permission}`);
  }
  // No Checks to grant (a fine-grained token has none; only an App posts check runs), and
  // Workflows is to be left off.
  assert(!said.includes("Checks:"), "asks for no Checks permission");
  assert(said.includes("Leave Workflows off"));
  assertEquals(said.includes("github_pat_secret"), false);
});

test("a configured GitHub App is kept by default: Enter leaves every App key alone", async () => {
  const app = new Map([
    ["RYPH_GITHUB_APP_ID", "123"],
    ["RYPH_GITHUB_PRIVATE_KEY_PATH", "/keys/app.pem"],
    ["RYPH_GITHUB_WEBHOOK_SECRET", "whsec"],
  ]);
  // Even with the GitHub CLI signed in, the default is "keep the current GitHub App".
  const io = new Scripted(["3", ...RUNNER, "2", "", "", ""]);
  const plan = await runWizard(io, context({ githubCli: true, current: app }));
  assert(io.transcript().includes("GitHub"));
  for (const key of app.keys()) assertEquals(plan.config.has(key), false, `${key} untouched`);
  assertEquals(plan.config.has("RYPH_GITHUB_TOKEN_COMMAND"), false);
  assertEquals(plan.notes.some((n) => n.includes("no way to reach a repository")), false);

  // Picking the CLI login asks first, naming what goes, and Enter there is no.
  const declined = new Scripted(["3", ...RUNNER, "2", "2", "", "", ""]);
  const kept = await runWizard(declined, context({ githubCli: true, current: app }));
  const asked = declined.said.find((q) => q.includes("Remove them?"));
  assert(asked?.includes("RYPH_GITHUB_PRIVATE_KEY_PATH") && asked.includes("RYPH_GITHUB_APP_ID"));
  for (const key of app.keys()) assertEquals(kept.config.has(key), false, `${key} untouched`);
  assertEquals(kept.config.has("RYPH_GITHUB_TOKEN_COMMAND"), false);

  // A token paste left empty after saying yes changes nothing either.
  const empty = new Scripted(["3", ...RUNNER, "2", "3", "y", "", "", ""]);
  const unchanged = await runWizard(empty, context({ githubCli: true, current: app }));
  for (const key of app.keys()) assertEquals(unchanged.config.has(key), false, `${key} untouched`);
  assertEquals(unchanged.config.has("RYPH_GITHUB_TOKEN"), false);
});

test("turning GitHub off with an App configured confirms, then removes the App", async () => {
  const app = new Map([["RYPH_GITHUB_APP_ID", "123"], ["RYPH_GITHUB_CLIENT_SECRET", "cs"]]);
  // keep, token, off (no CLI).
  const io = new Scripted(["3", ...RUNNER, "2", "3", "y", "", ""]);
  const plan = await runWizard(io, context({ current: app }));
  assertEquals(plan.config.get("RYPH_GITHUB_APP_ID"), null);
  assertEquals(plan.config.get("RYPH_GITHUB_CLIENT_SECRET"), null);
  assert(plan.notes.some((n) => n.includes("removed the GitHub App settings")));
});

test("switching from a GitHub App to user mode clears its settings, webhook secret included, and says so", async () => {
  // keep the App, CLI login, ... — the CLI login, then yes to removing the App.
  const io = new Scripted(["3", ...RUNNER, "2", "2", "y", "", ""]);
  const plan = await runWizard(
    io,
    context({
      githubCli: true,
      current: new Map([
        ["RYPH_GITHUB_APP_ID", "123"],
        ["RYPH_GITHUB_WEBHOOK_SECRET", "whsec"],
      ]),
    }),
  );
  // The forge refuses to start with either beside a token.
  assertEquals(plan.config.get("RYPH_GITHUB_APP_ID"), null);
  assertEquals(plan.config.get("RYPH_GITHUB_WEBHOOK_SECRET"), null);
  assertEquals(plan.config.has("RYPH_GITHUB_CLIENT_ID"), false, "only what is set is removed");
  const note = plan.notes.find((n) => n.includes("removed the GitHub App settings"));
  assert(note?.includes("RYPH_GITHUB_APP_ID") && note.includes("RYPH_GITHUB_WEBHOOK_SECRET"));
});

test("the GitHub CLI probe is bounded: a command that hangs behind a pipe answers no", async () => {
  const marker = `7.${crypto.getRandomValues(new Uint32Array(1))[0]}`;
  const started = performance.now();
  assertEquals(await githubCliSignedIn(`sleep ${marker} | cat`, 300), false);
  assert(performance.now() - started < 3_000, "the deadline waited for the pipeline");
  const left = await command("pgrep", { args: ["-f", `sleep ${marker}`] }).output();
  assertEquals(new TextDecoder().decode(left.stdout).trim(), "");
  assertEquals(await githubCliSignedIn("echo tok", 5_000), true);
  assertEquals(await githubCliSignedIn("exit 1", 5_000), false);
});

// TODO(bun): there is no --allow-run left to restrict. Under Deno the binary's scoped allowlist
// refused `Deno.kill(-pid)`, so this probed the group kill under exactly that list; the group is
// now signalled directly (process.kill(-pid)), which the test above covers.
test.skip("the GitHub CLI probe kills the whole group under the binary's restricted --allow-run", () => {});

test("turning GitHub off removes both ways of holding a token", async () => {
  // keep, cli, token, off: the last is "turn GitHub off" once one is configured.
  const io = new Scripted(["3", ...RUNNER, "2", "4", "", ""]);
  const plan = await runWizard(
    io,
    context({ githubCli: true, current: new Map([["RYPH_GITHUB_TOKEN", "ghp_x"]]) }),
  );
  assertEquals(plan.config.get("RYPH_GITHUB_TOKEN"), null);
  assertEquals(plan.config.get("RYPH_GITHUB_TOKEN_COMMAND"), null);
});

test("choosing a local root says where repositories are added from", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-repos-"));
  try {
    const io = new Scripted(["3", ...RUNNER, "1", root, "", "", ""]);
    const plan = await runWizard(io, context());
    assert(
      io.transcript().includes(`Add repositories under ${root} in the web UI`),
      "the line around what the deployment may read is stated where it is chosen",
    );
    assert(
      io.transcript().includes("Repos → Connect repository → On this machine"),
      "the way there is named as the UI labels it",
    );
    assertEquals(
      plan.notes.some((note) => note.includes("mount")),
      false,
      "runs clone through the forge, so no provisioner is needed to mount anything",
    );
  } finally {
    await rmdir(root);
  }
});

test("the local root offers the home directory when nothing was chosen before", async () => {
  const home = await mkdtemp(join(tmpdir(), "ryph-home-"));
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const io = new Scripted(["3", ...RUNNER, "1", "", "", "", ""]); // take the offered directory
    const plan = await runWizard(io, context());
    assertEquals(plan.config.get("RYPH_LOCAL_REPO_ROOT"), home);

    // An earlier, narrower answer is what is offered next time, not home again.
    const again = new Scripted(["3", ...RUNNER, "1", "", "", "", ""]);
    const kept = await runWizard(
      again,
      context({ current: new Map([["RYPH_LOCAL_REPO_ROOT", "/tmp"]]) }),
    );
    assertEquals(kept.config.get("RYPH_LOCAL_REPO_ROOT"), "/tmp");

    // A root turned off before is not offered back; home is.
    const off = new Scripted(["3", ...RUNNER, "1", "", "", "", ""]);
    const on = await runWizard(
      off,
      context({ current: new Map([["RYPH_LOCAL_REPO_ROOT", "off"]]) }),
    );
    assertEquals(on.config.get("RYPH_LOCAL_REPO_ROOT"), home);
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
    await rmdir(home);
  }
});

test("a directory that is not there is refused rather than written", async () => {
  const io = new Scripted(["3", ...RUNNER, "1", "/definitely/not/here", ""]);
  const failure = await runWizard(io, context()).catch((err: Error) => err.message);
  assert(String(failure).includes("does not exist"));
});

test("`up` asks only when somebody is there to answer", () => {
  const base = { interactive: true, configExists: false, disabled: false, dbUrl: "pglite:/tmp/d" };
  assertEquals(shouldRunSetup(base), true);
  assertEquals(shouldRunSetup({ ...base, interactive: false }), false, "a container never asks");
  assertEquals(shouldRunSetup({ ...base, configExists: true }), false, "asked and answered");
  assertEquals(shouldRunSetup({ ...base, disabled: true }), false, "--no-setup");
  assertEquals(
    shouldRunSetup({ ...base, dbUrl: "pglite:memory://" }),
    false,
    "a throwaway database is not a machine anyone is setting up",
  );
});

test("`up` does not ask a deployment the environment already configures", () => {
  process.env.RYPH_PROVISIONER = "docker";
  try {
    assertEquals(
      shouldRunSetup({
        interactive: true,
        configExists: false,
        disabled: false,
        dbUrl: "pglite:/tmp/d",
      }),
      false,
    );
  } finally {
    delete process.env.RYPH_PROVISIONER;
  }
});

test("`config` names the layer that decided each value, and redacts what it must", () => {
  const rows = describeSettings({
    env: new Map([["RYPH_PORT", "9999"]]),
    file: new Map([
      ["RYPH_PORT", "8888"],
      ["RYPH_PROVISIONER", "docker"],
      ["RYPH_GITHUB_TOKEN", "ghp_abcdefghijklmnop"],
    ]),
    defaults: {
      dbUrl: "pglite:/home/x/.ryph/data",
      appPort: 3000,
      apiPort: 7411,
      localRepoRoot: "/home/x",
    },
    storedKeyPath: "/home/x/.ryph/secrets.key",
    home: "/home/x/.ryph",
  });
  const row = (key: string) => rows.find((r) => r.key === key)!;

  assertEquals(row("RYPH_PORT").value, "9999");
  assertEquals(row("RYPH_PORT").source, "environment", "the file is outranked, and it says so");
  assertEquals(row("RYPH_PROVISIONER").source, "settings file");
  assertEquals(row("RYPH_APP_PORT").source, "default");
  assertEquals(
    row("RYPH_SECRETS_KEY").value,
    "/home/x/.ryph/secrets.key",
    "a stored key is neither env nor file, and reporting it as unset is the lie this prevents",
  );
  assertEquals(row("RYPH_SECRETS_KEY").source, "stored");
  assertEquals(row("RYPH_GITHUB_TOKEN").value.includes("abcdefgh"), false);
  assertEquals(row("RYPH_LOCAL_REPO_ROOT").value, "/home/x");
  assertEquals(row("RYPH_LOCAL_REPO_ROOT").source, "default", "home is a boundary nobody typed");
  // The file's docker turns builds and checks on by default.
  assertEquals(row("RYPH_ENVIRONMENTS"), {
    key: "RYPH_ENVIRONMENTS",
    value: "on",
    source: "default",
  });
  assertEquals(row("RYPH_CHECKS").value, "on");
  // Fewer check pods than a cluster runs, and each check held to half the daemon.
  assertEquals(row("RYPH_CHECKS_CONCURRENCY").value, "2");
  assertEquals(row("RYPH_CHECKS_CPUS").value, "auto");
  assertEquals(row("RYPH_CHECKS_MEMORY").value, "auto");
});

test("`config` reports the check caps unset when the docker launcher is elsewhere", () => {
  const rows = describeSettings({
    env: new Map([["RYPH_LAUNCHER_URL", "http://launcher:7470"]]),
    file: new Map([["RYPH_PROVISIONER", "docker"]]),
    defaults: {
      dbUrl: "pglite:/home/x/.ryph/data",
      appPort: 3000,
      apiPort: 7411,
      localRepoRoot: null,
    },
    storedKeyPath: null,
    home: "/home/x/.ryph",
  });
  // The launcher keeps its own; setting them here is refused at boot.
  for (const key of ["RYPH_CHECKS_CPUS", "RYPH_CHECKS_MEMORY"]) {
    assertEquals(rows.find((r) => r.key === key)!.source, "unset");
  }
});

test("`config` reports no local root when `up` would hand the forge none", () => {
  const rows = describeSettings({
    env: new Map(),
    file: new Map(),
    defaults: {
      dbUrl: "pglite:/home/x/.ryph/data",
      appPort: 3000,
      apiPort: 7411,
      localRepoRoot: null,
    },
    storedKeyPath: null,
    home: "/home/x/.ryph",
  });
  assertEquals(rows.find((r) => r.key === "RYPH_LOCAL_REPO_ROOT")!.source, "unset");
  assertEquals(rows.find((r) => r.key === "RYPH_ENVIRONMENTS")!.value, "off", "none builds none");
  // No default to report: `up` refuses to start without one.
  assertEquals(rows.find((r) => r.key === "RYPH_PROVISIONER"), {
    key: "RYPH_PROVISIONER",
    value: "—",
    source: "unset",
  });
});

test("what the answers become on disk: the key beside the database, the rest in the file", async () => {
  const home = await mkdtemp(join(tmpdir(), "ryph-home-"));
  const before = process.env.RYPH_HOME;
  process.env.RYPH_HOME = home;
  try {
    const dbUrl = `pglite:${home}/data`;
    const hex = "b".repeat(64);
    const applied = await applySetup(
      {
        key: { action: "store", hex, minted: true },
        config: new Map([["RYPH_PROVISIONER", "docker"], ["RYPH_AGENT_IMAGE", "img:1"]]),
        notes: [],
      },
      { ...context(), dbUrl, storableKeyPath: `${home}/secrets.key` },
    );

    assertEquals(applied.keyPath, `${home}/secrets.key`);
    assertEquals((await readFile(applied.keyPath!, "utf8")).trim(), hex);
    const { values } = await readConfig();
    assertEquals(values.get("RYPH_PROVISIONER"), "docker");
    assertEquals(
      values.has("RYPH_SECRETS_KEY"),
      false,
      "the master key has one home, and a settings file is not it",
    );
  } finally {
    if (before === undefined) delete process.env.RYPH_HOME;
    else process.env.RYPH_HOME = before;
    await rm(home, { recursive: true });
  }
});

test("a postgres:// database has nowhere to pair a key, so it goes in the settings file", async () => {
  const home = await mkdtemp(join(tmpdir(), "ryph-home-"));
  const before = process.env.RYPH_HOME;
  process.env.RYPH_HOME = home;
  try {
    const hex = "c".repeat(64);
    const applied = await applySetup(
      { key: { action: "store", hex, minted: true }, config: new Map(), notes: [] },
      {
        ...context(),
        dbUrl: "postgres://ryph@localhost:5432/ryph",
        storableKeyPath: null,
      },
    );
    assertEquals(applied.keyPath, null);
    assertEquals((await readConfig()).values.get("RYPH_SECRETS_KEY"), hex);
  } finally {
    if (before === undefined) delete process.env.RYPH_HOME;
    else process.env.RYPH_HOME = before;
    await rm(home, { recursive: true });
  }
});

test("docker is the provisioner, and is not asked about", async () => {
  const io = new Scripted(["3", "ryph-agent:dev", "", "", "2", "", "", ""]);
  assertEquals(
    (await runWizard(io, context())).config.get("RYPH_PROVISIONER"),
    "docker",
  );
  assertEquals(io.said.includes("Provisioner"), false, "no choice with one answer");
  assert(io.transcript().includes("Docker 27.3.1"), "what was detected is said");
});

test("docker gets the address a container can actually reach the host at", async () => {
  const io = new Scripted(["3", "ryph-agent:dev", "", "", "2", "", "", ""]);
  const plan = await runWizard(io, context({ apiPort: 8000, proxyPort: 8020 }));
  assertEquals(plan.config.get("RYPH_PUBLIC_URL"), "http://host.docker.internal:8000");
  assertEquals(plan.config.get("RYPH_MODEL_PROXY_URL"), "http://host.docker.internal:8020");
  assertEquals(plan.config.get("RYPH_MCP_GATEWAY_URL"), "http://host.docker.internal:7430");
  // Docker forwards host.docker.internal to loopback, so the gateway stays there.
  assertEquals(plan.config.get("RYPH_MCP_GATEWAY_HOST"), null);
  assertEquals(plan.config.has("RYPH_BIND"), false);
});

test("setup leaves RYPH_BIND to the person, whatever it holds", async () => {
  // The run address is the host's to detect at boot; a list written by hand, or by an older
  // setup, is neither rewritten nor cleared.
  const current = new Map([
    ["RYPH_BIND", "172.17.0.1,10.0.0.5"],
    ["RYPH_PUBLIC_URL", "http://host.docker.internal:7411"],
  ]);
  const linux = await runWizard(
    new Scripted(["3", "ryph-agent:dev", "", "", "2", "", "", ""]),
    withGate({ dockerBridgeGateway: "172.17.0.2", current }),
  );
  assertEquals(linux.config.has("RYPH_BIND"), false);
  const desktop = await runWizard(
    new Scripted(["3", "ryph-agent:dev", "", "", "2", "", "", ""]),
    context({ current }),
  );
  assertEquals(desktop.config.has("RYPH_BIND"), false);
});

// ── internet access ────────────────────────────────────────────────────────────────────────────
//
// The answer decides three settings that only make sense together: whether a boundary is claimed,
// the address a run dials to reach it, and whether the listener is on that address at all. A
// wizard that wrote one without the others would produce a deployment that claims a boundary and
// cannot reach it — which fails at the first `npm install`, a long way from this question.

test("allowlisted wires the proxy without confining anything", async () => {
  const io = new Scripted(["3", "ryph-agent:dev", "", "2", "2", "", "", ""]);
  const plan = await runWizard(io, withGate());

  assertEquals(plan.config.get("RYPH_EGRESS"), "proxy");
  assertEquals(plan.config.get("RYPH_EGRESS_PROXY_URL"), "http://host.docker.internal:7460");
  assertEquals(
    plan.config.get("RYPH_DOCKER_RUN_NETWORK"),
    null,
    "nothing was confined, so nothing claims to be",
  );
  // Cooperative, so the run keeps its own default route and reaches this process at
  // host.docker.internal without the listener leaving loopback. Opening :7460 to the LAN would
  // publish a port that answers Proxy-Authorization for a boundary nothing enforces.
  assertEquals(plan.config.get("RYPH_EGRESS_BIND"), null);
});

test("direct says `open` rather than leaving a boundary claimed and unwired", async () => {
  const io = new Scripted(["3", "ryph-agent:dev", "", "3", "2", "", "", ""]);
  const plan = await runWizard(
    io,
    withGate({ current: new Map([["RYPH_DOCKER_RUN_NETWORK", "ryph-runs"]]) }),
  );

  // RYPH_EGRESS defaults to `proxy`, so saying nothing here would leave a deployment claiming a
  // boundary it was just told not to enforce. That is the one state the setting must never be
  // configured into by accident.
  assertEquals(plan.config.get("RYPH_EGRESS"), "open");
  assertEquals(plan.config.has("RYPH_EGRESS_KEY"), false, "nothing to sign an allowlist with");
  // CLEARED, not merely unwritten: `updateConfig` only touches the keys the plan carries, so a
  // re-run that moves confined → direct would otherwise leave the old answer's settings in
  // place. RYPH_DOCKER_RUN_NETWORK surviving is the bad one — runs keep launching onto an
  // internal network with no default route while the deployment reads as open, so they are
  // handed no proxy either and every install hangs with nothing to blame.
  assertEquals(plan.config.get("RYPH_EGRESS_PROXY_URL"), null);
  assertEquals(plan.config.get("RYPH_EGRESS_BIND"), null, "no port opened for a proxy nobody uses");
  assertEquals(plan.config.get("RYPH_DOCKER_RUN_NETWORK"), null);
  // The addresses a run still needs are written all the same — the runner has to reach ryph.
  assertEquals(plan.config.get("RYPH_PUBLIC_URL"), "http://host.docker.internal:7411");
});

test("an egress key that already exists is not replaced", async () => {
  const io = new Scripted(["3", "ryph-agent:dev", "", "", "2", "", "", ""]);
  const plan = await runWizard(io, withGate({ egressKeyPresent: true }));

  assertEquals(
    plan.config.has("RYPH_EGRESS_KEY"),
    false,
    "minting over the old one would orphan every token already handed to a running run",
  );
  assertEquals(plan.config.get("RYPH_DOCKER_RUN_NETWORK"), "ryph-runs", "the rest is still wired");
});

test("docker is not offered confinement without a run gate to reach ryph through", async () => {
  const io = new Scripted(["3", "ryph-agent:dev", "", "", "2", "", "", ""]);
  const plan = await runWizard(
    io,
    context({
      confineDockerRuns: () => Promise.resolve({ confined: true }),
      gateImages: [],
    }),
  );

  assertEquals(plan.config.get("RYPH_PROVISIONER"), "docker");
  assertEquals(plan.config.get("RYPH_DOCKER_RUN_NETWORK"), null);
  assertEquals(plan.config.get("RYPH_EGRESS_PROXY_URL"), "http://host.docker.internal:7460");
  assert(
    io.transcript().includes("Internet access"),
    "the question is still asked — the allowlist still shapes what setup installs",
  );
});

/** Docker up, its internal network creatable, and a run gate built. */
const withGate = (over: Partial<SetupContext> = {}): SetupContext =>
  context({
    gateImages: ["ryph-run-gate:dev"],
    confineDockerRuns: () => Promise.resolve({ confined: true }),
    ...over,
  });

test("docker with a run gate is confined by default, every address on the gate", async () => {
  const io = new Scripted(["3", "ryph-agent:dev", "", "", "2", "", "", ""]);
  const plan = await runWizard(io, withGate());

  assertEquals(plan.config.get("RYPH_PROVISIONER"), "docker");
  assertEquals(plan.config.get("RYPH_DOCKER_RUN_NETWORK"), "ryph-runs");
  assertEquals(plan.config.get("RYPH_DOCKER_GATE_IMAGE"), "ryph-run-gate:dev");
  assertEquals(plan.config.get("RYPH_EGRESS"), "proxy");
  // A confined docker run has no route to the host: every platform address is the gate's name,
  // and the gate relays exactly these ports.
  assertEquals(plan.config.get("RYPH_PUBLIC_URL"), "http://ryph-gate-default:7411");
  assertEquals(plan.config.get("RYPH_MODEL_PROXY_URL"), "http://ryph-gate-default:7420");
  assertEquals(plan.config.get("RYPH_MCP_GATEWAY_URL"), "http://ryph-gate-default:7430");
  assertEquals(plan.config.get("RYPH_EGRESS_PROXY_URL"), "http://ryph-gate-default:7460");
  // And no listener leaves loopback: the gate reaches them at host.docker.internal, which Docker
  // Desktop forwards to this machine's loopback.
  assertEquals(plan.config.get("RYPH_EGRESS_BIND"), null);
  assertEquals(plan.config.get("RYPH_MCP_GATEWAY_HOST"), null);
});

test("the gate and the run network are named for the deployment network", async () => {
  const io = new Scripted(["3", "ryph-agent:dev", "", "", "2", "", "", ""]);
  const made: string[] = [];
  const plan = await runWizard(
    io,
    withGate({
      dockerNetwork: "ryph",
      confineDockerRuns: (network) => {
        made.push(network);
        return Promise.resolve({ confined: true });
      },
    }),
  );
  assertEquals(plan.config.get("RYPH_PUBLIC_URL"), "http://ryph-gate-ryph:7411");
  // Its own run network, so two deployments on one daemon never share one.
  assertEquals(plan.config.get("RYPH_DOCKER_RUN_NETWORK"), "ryph-runs-ryph");
  assertEquals(made, ["ryph-runs-ryph"]);
});

test("on a Linux docker engine the listeners bind the docker bridge, not loopback", async () => {
  // There `host.docker.internal` is the bridge's address, which a 127.0.0.1 listener never
  // answers: the gate (or an unconfined run) would dial a port nothing listens on.
  const io = new Scripted(["3", "ryph-agent:dev", "", "", "2", "", "", ""]);
  const plan = await runWizard(io, withGate({ dockerBridgeGateway: "172.17.0.1" }));
  assertEquals(plan.config.get("RYPH_DOCKER_RUN_NETWORK"), "ryph-runs");
  assertEquals(plan.config.get("RYPH_EGRESS_BIND"), "172.17.0.1");
  assertEquals(plan.config.get("RYPH_MCP_GATEWAY_HOST"), "172.17.0.1");
  // The control plane and the model proxy bind the bridge too, but the host detects it at boot.
  assertEquals(plan.config.has("RYPH_BIND"), false);
  assert(plan.notes.some((note) => note.includes("172.17.0.1:7460")));
  // The addresses runs dial are unchanged: still the gate's name.
  assertEquals(plan.config.get("RYPH_EGRESS_PROXY_URL"), "http://ryph-gate-default:7460");

  // And direct, with no proxy to reach, moves only the MCP gateway.
  const direct = await runWizard(
    new Scripted(["3", "ryph-agent:dev", "", "3", "2", "", "", ""]),
    withGate({ dockerBridgeGateway: "172.17.0.1" }),
  );
  assertEquals(direct.config.get("RYPH_EGRESS_BIND"), null);
  assertEquals(direct.config.get("RYPH_MCP_GATEWAY_HOST"), "172.17.0.1");
});

test("a docker run network that cannot be made downgrades loudly, to the host's name", async () => {
  const io = new Scripted(["3", "ryph-agent:dev", "", "", "2", "", "", ""]);
  const plan = await runWizard(
    io,
    withGate({
      confineDockerRuns: () =>
        Promise.resolve({ confined: false, why: "docker 27.5.1 is older than 28.0, so …" }),
    }),
  );

  assertEquals(plan.config.get("RYPH_DOCKER_RUN_NETWORK"), null);
  assertEquals(plan.config.get("RYPH_DOCKER_GATE_IMAGE"), null);
  assert(plan.notes.some((note) => note.includes("NOT confined") && note.includes("27.5.1")));
  assertEquals(plan.config.get("RYPH_PUBLIC_URL"), "http://host.docker.internal:7411");
  assertEquals(plan.config.get("RYPH_EGRESS_PROXY_URL"), "http://host.docker.internal:7460");
});

test("leaving docker's confinement clears the run network, not just stops writing it", async () => {
  // Answer 2: allowlisted. A previous confined answer's network surviving would launch runs onto
  // an internal network whose addresses now name the host, which they cannot reach.
  const io = new Scripted(["3", "ryph-agent:dev", "", "2", "2", "", "", ""]);
  const plan = await runWizard(
    io,
    withGate({
      current: new Map([
        ["RYPH_DOCKER_RUN_NETWORK", "ryph-runs"],
        ["RYPH_DOCKER_GATE_IMAGE", "ryph-run-gate:dev"],
      ]),
    }),
  );
  assertEquals(plan.config.get("RYPH_DOCKER_RUN_NETWORK"), null);
  assertEquals(plan.config.get("RYPH_DOCKER_GATE_IMAGE"), null);
  assertEquals(plan.config.get("RYPH_PUBLIC_URL"), "http://host.docker.internal:7411");
});

test("mail: an SMTP server is written as a pair, and turning it off removes both", async () => {
  const io = new Scripted([
    "3", // key: skip
    ...RUNNER, // docker
    "2", // repositories on this machine: skip
    "", // GitHub: skip
    "", // GitLab: skip
    "2", // mail: an SMTP server
    "smtp://user:secret@smtp.example.com:587",
    "ryph <ryph@example.com>",
  ]);
  const plan = await runWizard(io, context({ multiUser: true }));
  assertEquals(plan.config.get("RYPH_SMTP_URL"), "smtp://user:secret@smtp.example.com:587");
  assertEquals(plan.config.get("RYPH_MAIL_FROM"), "ryph <ryph@example.com>");

  // …mail: turn off (offered once one is set)
  const off = new Scripted(["3", ...RUNNER, "2", "", "", "3"]);
  const cleared = await runWizard(
    off,
    context({
      multiUser: true,
      current: new Map([
        ["RYPH_SMTP_URL", "smtp://old.example.com:25"],
        ["RYPH_MAIL_FROM", "old <old@example.com>"],
      ]),
    }),
  );
  assertEquals(cleared.config.get("RYPH_SMTP_URL"), null);
  assertEquals(cleared.config.get("RYPH_MAIL_FROM"), null);
});

test("Radicle is offered only where `rad self` answered, and acting as it is opt-in", async () => {
  const radicle = { did: "did:key:z6MkehUNS8bxayxDsyV7fwquX89NgTpU614CuxXy9V6Qxibb", alias: "ada" };
  // No identity here: no question, and the script needs no answer for one.
  const none = await runWizard(new Scripted(["3", ...RUNNER, "2", "", "", ""]), context());
  assertEquals(none.config.has("RYPH_RADICLE_URL"), false);

  // Offered, and Enter skips it.
  const skip = new Scripted(["3", ...RUNNER, "2", "", "", "", ""]);
  const skipped = await runWizard(skip, context({ radicle }));
  assertEquals(skipped.config.has("RYPH_RADICLE_URL"), false);
  assert(skip.transcript().includes("Radicle"));

  // Chosen: the bridge runs in-process, and that alone is a way to reach a repository.
  const on = await runWizard(
    new Scripted(["3", ...RUNNER, "2", "", "", "1", ""]),
    context({ radicle }),
  );
  assertEquals(on.config.get("RYPH_RADICLE_URL"), "embedded");
  assertEquals(on.notes.some((note) => note.includes("no way to reach")), false);

  // On already: kept by default, and turned off when asked.
  const current = new Map([["RYPH_RADICLE_URL", "embedded"]]);
  const kept = await runWizard(
    new Scripted(["3", ...RUNNER, "2", "", "", "", ""]),
    context({ radicle, current }),
  );
  assertEquals(kept.config.has("RYPH_RADICLE_URL"), false);
  const off = await runWizard(
    new Scripted(["3", ...RUNNER, "2", "", "", "2", ""]),
    context({ radicle, current }),
  );
  assertEquals(off.config.get("RYPH_RADICLE_URL"), null);
});

test("Radicle turned on can be turned off even where `rad self` no longer answers", async () => {
  const current = new Map([["RYPH_RADICLE_URL", "embedded"]]);
  const off = new Scripted(["3", ...RUNNER, "2", "", "", "2", ""]);
  const plan = await runWizard(off, context({ radicle: null, current }));
  assertEquals(plan.config.get("RYPH_RADICLE_URL"), null);
  assert(off.transcript().includes("Radicle"));
});

test("flags alone drive the whole wizard, and every other question takes its default", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-repos-"));
  try {
    const said: string[] = [];
    const { answers } = parseSetupArgs([
      "--agent-image",
      "ryph-agent:dev",
      "--browser-image=off",
      "--egress",
      "direct",
      "--repo-root",
      root,
      "--github-token",
      "ghp_x",
    ]);
    const io = answeringPrompter(answers, null, (text = "") => said.push(text));
    const plan = await runWizard(io, context());

    assertEquals(plan.key.action, "store", "the key question took its default: mint one");
    assertEquals(plan.config.get("RYPH_AGENT_IMAGE"), "ryph-agent:dev");
    assertEquals(plan.config.get("RYPH_EGRESS"), "open");
    assertEquals(
      plan.config.get("RYPH_LOCAL_REPO_ROOT"),
      root,
      "--repo-root implies --repos local",
    );
    assertEquals(
      plan.config.get("RYPH_GITHUB_TOKEN"),
      "ghp_x",
      "--github-token implies --github token",
    );
    assertEquals(io.unused(), []);
    assert(said.includes("Internet access: direct"), "an unattended answer is said back");
  } finally {
    await rmdir(root);
  }
});

test("a flag naming a choice this machine does not offer is refused with the ones it does", async () => {
  // No gh login here, so `cli` is not on offer.
  const { answers } = parseSetupArgs(["--agent-image", "a", "--github", "cli"]);
  const io = answeringPrompter(answers, null, () => {});
  const err = await runWizard(io, context()).then(() => null, (e) => e);
  assert(err instanceof NeedsAnswer);
  assert(err.message.includes("--github cli") && err.message.includes("token, skip"), err.message);
});

test("a question with no flag and no default names the flag it needs", async () => {
  const io = answeringPrompter(new Map(), null, () => {});
  const err = await runWizard(io, context()).then(() => null, (e) => e);
  assert(err instanceof SetupStopped, String(err));
  assert(err.message.includes("--agent-image"), err.message);

  const mail = answeringPrompter(new Map([["agent-image", "a"], ["mail", "smtp"]]), null, () => {});
  const needs = await runWizard(mail, context({ multiUser: true })).then(() => null, (e) => e);
  assert(needs instanceof NeedsAnswer, String(needs));
  assert(needs.message.includes("--smtp-url"), needs.message);
});

test("setup flags: typos and contradictions are refused, not defaulted", () => {
  const refused = (argv: string[]) => {
    try {
      parseSetupArgs(argv);
      return null;
    } catch (err) {
      return err instanceof NeedsAnswer ? err.message : String(err);
    }
  };
  assert(refused(["--egres", "direct"])?.includes("unexpected"));
  assert(refused(["--egress"])?.includes("needs a value"));
  assert(refused(["--egress", "--yes"])?.includes("needs a value"));
  assert(refused(["--repos", "skip", "--repo-root", "/x"])?.includes("--repos local"));
  assertEquals(refused(["--github-token", "-", "-y"]), null, "- is stdin, not a flag");
  const args = parseSetupArgs(["-y", "--mail=smtp", "--smtp-url", "smtp://h"]);
  assertEquals(args.yes, true);
  assertEquals(args.answers.get("mail"), "smtp");
});

test("a malformed key stops setup instead of minting one over the stored key", async () => {
  const { answers } = parseSetupArgs(["--key-value", "abc"]);
  const io = answeringPrompter(answers, null, () => {});
  const err = await runWizard(io, context({ storedKeyPath: "/tmp/ryph/secrets.key" })).then(
    () => null,
    (e) => e,
  );
  assert(err instanceof SetupStopped, String(err));
});

test("mail is not asked about when only the owner uses this instance", async () => {
  const said: string[] = [];
  const io = answeringPrompter(new Map([["agent-image", "a"]]), null, (t = "") => said.push(t));
  const plan = await runWizard(io, context());
  assertEquals(plan.config.has("RYPH_SMTP_URL"), false);
  assert(!said.some((line) => line.startsWith("Mail:")), "no mail question");
  assert(said.some((line) => line.includes("Three quick questions")));

  const multi = answeringPrompter(
    new Map([["agent-image", "a"], ["smtp-url", "smtp://h:587"], ["mail", "smtp"]]),
    null,
    () => {},
  );
  const asked = await runWizard(multi, context({ multiUser: true }));
  assertEquals(asked.config.get("RYPH_SMTP_URL"), "smtp://h:587");
});
