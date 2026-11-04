// The repo-side environment contract, exercised directly on the helper:
// discovery and validation of setup.yml + environment.md, and step execution —
// ordering, failure, cancellation, and the brand-scoped env scrub.

import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeCredentials } from "../src/helpers/runtime_credentials.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  assertEnvironmentTotal,
  browserEgressProxy,
  cleanSetupOutput,
  describeSetupFailure,
  discoverEnvironment,
  discoverSetup,
  MAX_SETUP_ERROR,
  runChildEnv,
  runSetup,
  SETUP_PHASE_ENV,
  type SetupPhase,
  type SetupStep,
  stepLabel,
} from "../src/helpers/environment.ts";
import { ENV_PREFIX, REPO_CONFIG_DIR } from "../src/core/brand.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";

// Builds a throwaway checkout holding `files` (path → content, paths may nest).
async function makeCheckout(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "runner-env-test-"));
  for (const [path, content] of Object.entries(files)) {
    const parent = path.includes("/") ? `${dir}/${path.slice(0, path.lastIndexOf("/"))}` : dir;
    await mkdir(parent, { recursive: true });
    await writeFile(`${dir}/${path}`, content);
  }
  return dir;
}

function setupOpts(cwd: string, signal?: AbortSignal, phase: SetupPhase = "run") {
  return { cwd, phase, signal: signal ?? new AbortController().signal, diag: noopDiagnostics() };
}

test("discover: no config dir is a normal empty result", async () => {
  const ws = await makeCheckout();
  try {
    const env = await discoverEnvironment(ws);
    assertEquals(env.setup, []);
    assertEquals(env.environment, null);
  } finally {
    await rm(ws, { recursive: true });
  }
});

test("discover: setup.yml steps parse in order, name optional", async () => {
  const ws = await makeCheckout({
    [`${REPO_CONFIG_DIR}/setup.yml`]: "steps:\n" +
      "  - name: first\n" +
      "    run: echo one\n" +
      "  - run: echo two\n",
  });
  try {
    const env = await discoverEnvironment(ws);
    assertEquals(env.setup, [{ name: "first", run: "echo one" }, { run: "echo two" }]);
  } finally {
    await rm(ws, { recursive: true });
  }
});

test("discover: an empty or comments-only setup.yml is a placeholder, not an error", async () => {
  const empty = await makeCheckout({ [`${REPO_CONFIG_DIR}/setup.yml`]: "" });
  const comments = await makeCheckout({
    [`${REPO_CONFIG_DIR}/setup.yml`]: "# steps land here once the env needs them\n",
  });
  try {
    assertEquals((await discoverEnvironment(empty)).setup, []);
    assertEquals((await discoverEnvironment(comments)).setup, []);
  } finally {
    await rm(empty, { recursive: true });
    await rm(comments, { recursive: true });
  }
});

test("discover: setup.yaml is accepted, setup.yml wins when both exist", async () => {
  const both = await makeCheckout({
    [`${REPO_CONFIG_DIR}/setup.yml`]: "steps:\n  - run: from yml\n",
    [`${REPO_CONFIG_DIR}/setup.yaml`]: "steps:\n  - run: from yaml\n",
  });
  const yamlOnly = await makeCheckout({
    [`${REPO_CONFIG_DIR}/setup.yaml`]: "steps:\n  - run: from yaml\n",
  });
  try {
    assertEquals((await discoverEnvironment(both)).setup, [{ run: "from yml" }]);
    assertEquals((await discoverEnvironment(yamlOnly)).setup, [{ run: "from yaml" }]);
  } finally {
    await rm(both, { recursive: true });
    await rm(yamlOnly, { recursive: true });
  }
});

describe("discover: a broken setup.yml is a warning naming the file, never a throw", () => {
  const cases: Array<{ name: string; yaml: string; expect: string }> = [
    { name: "invalid YAML", yaml: "steps: [\n", expect: "not valid YAML" },
    { name: "missing steps", yaml: "step: []\n", expect: "unknown key" },
    { name: "steps not a list", yaml: "steps: go\n", expect: "`steps` must be a list" },
    { name: "step not a mapping", yaml: "steps:\n  - echo one\n", expect: "steps[0]" },
    {
      name: "unknown step key",
      yaml: "steps:\n  - run: echo one\n    when: always\n",
      expect: "unknown key `when`",
    },
    { name: "missing run", yaml: "steps:\n  - name: first\n", expect: "steps[0].run" },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const ws = await makeCheckout({ [`${REPO_CONFIG_DIR}/setup.yml`]: c.yaml });
      try {
        // Setup is an optimization: zero steps and the reason, so the run (and a build) goes
        // on and says why.
        const env = await discoverEnvironment(ws);
        assertEquals(env.setup, []);
        assertStringIncludes(env.setupError ?? "", "setup.yml");
        assertStringIncludes(env.setupError ?? "", c.expect);
        // What a build reads says the same.
        const declared = await discoverSetup(ws);
        assertEquals(declared.steps, []);
        assertEquals(declared.error, env.setupError);
      } finally {
        await rm(ws, { recursive: true });
      }
    });
  }
});

test("discover: a setup.yml error is bounded, however long the key or the line it quotes", async () => {
  const longKey = "k".repeat(50_000);
  const key = await makeCheckout({ [`${REPO_CONFIG_DIR}/setup.yml`]: `${longKey}: 1\n` });
  const stepKey = await makeCheckout({
    [`${REPO_CONFIG_DIR}/setup.yml`]: `steps:\n  - run: x\n    ${longKey}: 1\n`,
  });
  // a YAML error quotes the offending line back
  const line = await makeCheckout({
    [`${REPO_CONFIG_DIR}/setup.yml`]: `steps: [${"x".repeat(50_000)}\n`,
  });
  try {
    for (const ws of [key, stepKey]) {
      const { error } = await discoverSetup(ws);
      assertStringIncludes(error ?? "", `unknown key \`${"k".repeat(100)}…\``);
      assert((error ?? "").length < 300, `${error?.length}`);
    }
    const { error } = await discoverSetup(line);
    assertStringIncludes(error ?? "", "not valid YAML");
    assert((error ?? "").length <= MAX_SETUP_ERROR + 1, `${error?.length}`);
  } finally {
    for (const ws of [key, stepKey, line]) await rm(ws, { recursive: true });
  }
});

test("a discard is said in the platform's voice, naming the failed repos", () => {
  assertEquals(
    describeSetupFailure({ kind: "discarded", after: ["web"] }),
    "changes left in the tree after setup failed in `web/` were discarded: they could not be " +
      "told apart from what the failed step did",
  );
});

test("discover: environment.md is read and trimmed; blank is null; oversize throws", async () => {
  const present = await makeCheckout({
    [`${REPO_CONFIG_DIR}/environment.md`]: "\nA Postgres runs on :5432.\n",
  });
  const blank = await makeCheckout({ [`${REPO_CONFIG_DIR}/environment.md`]: "  \n\n" });
  const oversize = await makeCheckout({
    [`${REPO_CONFIG_DIR}/environment.md`]: "x".repeat(32_769),
  });
  try {
    assertEquals((await discoverEnvironment(present)).environment, "A Postgres runs on :5432.");
    assertEquals((await discoverEnvironment(blank)).environment, null);
    const err = await assertRejects(() => discoverEnvironment(oversize), Error);
    assertStringIncludes(err.message, "environment.md");
    assertStringIncludes(err.message, "exceeds the 32768-byte limit");
  } finally {
    await rm(present, { recursive: true });
    await rm(blank, { recursive: true });
    await rm(oversize, { recursive: true });
  }
});

test("discover: a symlinked config file is absent, not followed", async () => {
  const ws = await makeCheckout({ [`${REPO_CONFIG_DIR}/.keep`]: "" });
  try {
    // /dev/zero never ends; a whole-file read would never return. lstat sees a symlink.
    await symlink("/dev/zero", `${ws}/${REPO_CONFIG_DIR}/environment.md`);
    await symlink("/dev/zero", `${ws}/${REPO_CONFIG_DIR}/setup.yml`);
    await symlink("/dev/zero", `${ws}/${REPO_CONFIG_DIR}/services.yml`);
    assertEquals(await discoverEnvironment(ws), {
      setup: [],
      setupError: null,
      environment: null,
      declaredServices: [],
    });
  } finally {
    await rm(ws, { recursive: true });
  }
});

test("discover: a symlinked config DIRECTORY is absent, not followed", async () => {
  const ws = await makeCheckout({ "README.md": "hi" });
  const elsewhere = await makeCheckout({
    "environment.md": "not this checkout's",
    "setup.yml": "steps:\n  - run: echo escaped\n",
  });
  try {
    // Every file inside is a regular file, so a per-file lstat alone would read them all.
    await symlink(elsewhere, `${ws}/${REPO_CONFIG_DIR}`);
    assertEquals(await discoverEnvironment(ws), {
      setup: [],
      setupError: null,
      environment: null,
      declaredServices: [],
    });
  } finally {
    await rm(ws, { recursive: true });
    await rm(elsewhere, { recursive: true });
  }
});

test("environment.md across the checkout is bounded as a total, naming each repo's share", () => {
  const big = "x".repeat(30_000);
  assertEnvironmentTotal([
    { path: "a", environment: big },
    { path: "b", environment: big },
    { path: "c", environment: null },
  ]);
  const err = assertThrows(
    () =>
      assertEnvironmentTotal([
        { path: "a", environment: big },
        { path: "b", environment: big },
        { path: "c", environment: big },
      ]),
    Error,
  );
  assertStringIncludes(err.message, "90000 bytes exceeds the 65536-byte total limit");
  assertStringIncludes(err.message, "a: 30000, b: 30000, c: 30000");
});

describe("discover: services.yml is bounded and screened before it reaches the parser", () => {
  // The lenient read is lenient about SHAPE, not about being made to allocate. With
  // RYPH_SERVICES off the control plane never reads this file at all, so nothing upstream has
  // bounded or screened it — and a billion-laughs declaration would wedge the run's own
  // container during setting-up.
  const cases: Array<{ name: string; yaml: string; expect: string }> = [
    {
      name: "oversize",
      yaml: `services:\n  db:\n    uses: postgres@18 ${"x".repeat(65_536)}\n`,
      expect: "exceeds the 65536-byte limit",
    },
    {
      name: "an alias expansion",
      yaml: "a: &a [x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]\n" +
        "services:\n  db:\n    uses: postgres@18\n    env: [*b, *b, *b, *b, *b, *b, *b, *b, *b]\n",
      expect: "anchors and aliases are not allowed",
    },
    {
      name: "a bare anchor",
      yaml: "services:\n  db: &base\n    uses: postgres@18\n",
      expect: "anchors and aliases are not allowed",
    },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const ws = await makeCheckout({ [`${REPO_CONFIG_DIR}/services.yml`]: c.yaml });
      try {
        const err = await assertRejects(() => discoverEnvironment(ws), Error);
        assertStringIncludes(err.message, "services.yml");
        assertStringIncludes(err.message, c.expect);
      } finally {
        await rm(ws, { recursive: true });
      }
    });
  }

  test("an ordinary declaration still parses", async () => {
    // The screen matches a node-position `&`/`*` and nothing else: a password with an ampersand
    // in it is a scalar, and refusing that would be refusing what people actually write.
    const ws = await makeCheckout({
      [`${REPO_CONFIG_DIR}/services.yml`]:
        "services:\n  db:\n    uses: postgres@18\n    port: 5433\n" +
        "    env:\n      POSTGRES_PASSWORD: 'p&ssword'\n",
    });
    try {
      assertEquals((await discoverEnvironment(ws)).declaredServices, [{ name: "db", port: 5433 }]);
    } finally {
      await rm(ws, { recursive: true });
    }
  });

  test("a checks-only service is not one the run expects", async () => {
    // The control plane never starts it for a run, so counting it would fail every run of the
    // repo — on a deployment without service containers, with a message blaming the switch.
    const ws = await makeCheckout({
      [`${REPO_CONFIG_DIR}/services.yml`]:
        "services:\n  db:\n    uses: postgres@18\n    port: 5432\n    checks_only: true\n" +
        "  cache:\n    uses: redis@8\n    port: 6379\n    checks_only: false\n",
    });
    try {
      assertEquals((await discoverEnvironment(ws)).declaredServices, [
        { name: "cache", port: 6379 },
      ]);
    } finally {
      await rm(ws, { recursive: true });
    }
  });

  test("a checks_only that is not true or false fails the run, naming the key", async () => {
    // Where the control plane never read the file, a `yes` read as false would leave the run
    // waiting on a service it never gets, blamed on the deployment instead of the typo.
    const ws = await makeCheckout({
      [`${REPO_CONFIG_DIR}/services.yml`]:
        "services:\n  db:\n    uses: postgres@18\n    port: 5432\n    checks_only: yes\n",
    });
    try {
      await assertRejects(
        () => discoverEnvironment(ws),
        Error,
        "db.checks_only: must be true or false",
      );
    } finally {
      await rm(ws, { recursive: true });
    }
  });
});

test("runSetup: steps run in order, in the checkout, and narrate via onStep", async () => {
  const ws = await makeCheckout();
  const seen: string[] = [];
  try {
    await runSetup(
      [
        { name: "first", run: "echo one >> order.txt" },
        { run: "echo two >> order.txt" },
      ],
      {
        ...setupOpts(ws),
        onStep: (step, index) => seen.push(`${index}:${stepLabel(step, index)}`),
      },
    );
    assertEquals(await readFile(`${ws}/order.txt`, "utf8"), "one\ntwo\n");
    assertEquals(seen, ["0:first", "1:echo two >> order.txt"]);
  } finally {
    await rm(ws, { recursive: true });
  }
});

test("runSetup: the first failing step stops the sequence and returns label, exit, and output", async () => {
  const ws = await makeCheckout();
  try {
    const failed = await runSetup(
      [
        { run: "true" },
        { name: "boom", run: "echo kaput >&2; exit 7" },
        { run: "touch never.txt" },
        { run: "touch nor-this.txt" },
      ],
      setupOpts(ws),
    );
    // A result, not a throw: what a failure means is the caller's.
    assertEquals(failed, {
      kind: "step",
      step: "boom",
      index: 2,
      total: 4,
      code: 7,
      output: "kaput",
    });
    assertEquals(
      describeSetupFailure(failed!),
      'setup step "boom" failed (exit 7): kaput',
    );
    assertEquals(await stat(`${ws}/never.txt`).then(() => "present", (e) => e.code), "ENOENT");
    assertEquals(await stat(`${ws}/nor-this.txt`).then(() => "present", (e) => e.code), "ENOENT");
  } finally {
    await rm(ws, { recursive: true });
  }
});

test("runSetup: every step passing, or none declared, is no failure", async () => {
  const ws = await makeCheckout();
  try {
    assertEquals(await runSetup([{ run: "true" }, { run: "true" }], setupOpts(ws)), null);
    assertEquals(await runSetup([], setupOpts(ws)), null);
  } finally {
    await rm(ws, { recursive: true });
  }
});

test("runSetup: brand-scoped env never reaches a step; everything else does", async () => {
  const ws = await makeCheckout();
  const secret = `${ENV_PREFIX}_TEST_SECRET`;
  process.env[secret] = "shh";
  process.env.RUNNER_ENV_TEST_PLAIN = "visible";
  try {
    await runSetup(
      [{ run: `printf '%s %s' "\${${secret}:-absent}" "$RUNNER_ENV_TEST_PLAIN" > seen.txt` }],
      setupOpts(ws),
    );
    assertEquals(await readFile(`${ws}/seen.txt`, "utf8"), "absent visible");
  } finally {
    delete process.env[secret];
    delete process.env.RUNNER_ENV_TEST_PLAIN;
    await rm(ws, { recursive: true });
  }
});

test("runSetup: every step sees its phase, the one brand-scoped name the scrub keeps", async () => {
  for (const phase of ["run", "image"] as const) {
    const ws = await makeCheckout();
    // A stale value in the runner's own env must not leak through: the phase is the option's.
    process.env[SETUP_PHASE_ENV] = "stale";
    try {
      await runSetup(
        [{ run: `printf '%s' "$${SETUP_PHASE_ENV}" > phase.txt` }],
        setupOpts(ws, undefined, phase),
      );
      assertEquals(await readFile(`${ws}/phase.txt`, "utf8"), phase);
    } finally {
      delete process.env[SETUP_PHASE_ENV];
      await rm(ws, { recursive: true });
    }
  }
});

test("runSetup: an abort kills the in-flight step and skips the rest without throwing", async () => {
  const ws = await makeCheckout();
  const cancel = new AbortController();
  const started = performance.now();
  try {
    const timer = setTimeout(() => cancel.abort(), 100);
    const failed = await runSetup(
      [{ run: "sleep 5" }, { run: "touch after.txt" }],
      setupOpts(ws, cancel.signal),
    );
    // The kill was ours: never reported as the step's failure.
    assertEquals(failed, null);
    clearTimeout(timer);
    assert(performance.now() - started < 4_000, "abort must not wait the step out");
    assertEquals(await stat(`${ws}/after.txt`).then(() => "present", (e) => e.code), "ENOENT");
  } finally {
    await rm(ws, { recursive: true });
  }
});

/** Whether a process `pid` is running (this uid may signal it). A zombie is not: an orphan
 * waits as one until init reaps it, which a container's init may never do. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false; // reaped since the signal
  }
}

test("runSetup: a failed step's background children are ended before its failure returns", async () => {
  const ws = await makeCheckout();
  const started = performance.now();
  try {
    // A watcher that would write once told to, and one still holding the step's output pipes.
    // The writer waits on `go`, not a timer: however slow the machine, it can only write if it
    // outlived the step's failure.
    const failed = await runSetup(
      [{
        run: "( until [ -e go ]; do sleep 0.05; done; echo late > late.txt ) >/dev/null 2>&1 & " +
          "echo $! > writer.pid; sleep 30 & exit 3",
      }],
      setupOpts(ws),
    );
    assertEquals(failed?.code, 3);
    assert(
      performance.now() - started < 10_000,
      "a child holding the pipes must not hold the step",
    );
    const writer = Number(await readFile(`${ws}/writer.pid`, "utf8"));
    assertEquals(alive(writer), false, "the writer must be gone when the failure returns");
    await writeFile(`${ws}/go`, "");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assertEquals(await stat(`${ws}/late.txt`).then(() => "present", (e) => e.code), "ENOENT");
  } finally {
    await rm(ws, { recursive: true });
  }
});

test("runSetup: what a successful step starts in the background keeps running", async () => {
  const ws = await makeCheckout();
  let daemon = 0;
  try {
    const failed = await runSetup(
      [{ run: "sleep 30 >/dev/null 2>&1 & echo $! > daemon.pid" }, { run: "true" }],
      setupOpts(ws),
    );
    assertEquals(failed, null);
    daemon = Number(await readFile(`${ws}/daemon.pid`, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assertEquals(alive(daemon), true);
  } finally {
    if (daemon > 1) process.kill(daemon, "SIGKILL");
    await rm(ws, { recursive: true });
  }
});

test("stepLabel: name wins, else first line of the command, clipped", () => {
  assertEquals(stepLabel({ name: "install deps", run: "npm ci" }, 0), "install deps");
  assertEquals(stepLabel({ run: "line one\nline two" }, 0), "line one");
  const long: SetupStep = { run: "x".repeat(200) };
  assertEquals(stepLabel(long, 0).length, 81); // 80 chars + ellipsis
});

test("stepLabel: never empty — a `run: |` opening blank takes its first line with text", () => {
  // `run: |` with a blank first line, as YAML hands it over: the old label was "", which the
  // orchestrator's schema refuses, and the whole setup report with it.
  assertEquals(stepLabel({ run: "\n  \nnpm ci\nnpm test\n" }, 0), "npm ci");
  assertEquals(stepLabel({ name: "\n  build", run: "make" }, 3), "build");
  // Nothing printable at all: the step's position stands in.
  assertEquals(stepLabel({ run: "\u001b[0m\n\t\n" }, 2), "step 3");
});

test("cleanSetupOutput: no escapes, no controls, no credentials in URLs", () => {
  const raw = "\u001b[31merror\u001b[0m: fetch failed\r\n" +
    "proxy http://r-123:eyJ.secret.claim@egress:3128 refused\u0007\u202e done";
  assertEquals(
    cleanSetupOutput(raw),
    "error: fetch failed\nproxy http://***@egress:3128 refused done",
  );
});

test("runSetup: a failing step's output reaches the result cleaned", async () => {
  const ws = await makeCheckout();
  try {
    const failed = await runSetup(
      [{
        run: "printf '\\033[1mnpm ERR!\\033[0m via https://run:tok3n@proxy:3128\\n' >&2; exit 1",
      }],
      setupOpts(ws),
    );
    assertEquals(failed?.kind, "step");
    assertEquals(failed?.output, "npm ERR! via https://***@proxy:3128");
  } finally {
    await rm(ws, { recursive: true });
  }
});

test("runSetup: the output tail is cut after it is cleaned, so a cut never splits a credential", async () => {
  const ws = await makeCheckout();
  try {
    // One long line, the credential near its start: a cut of the raw tail would land inside
    // the URL and leave `u:SECRET@proxy yyy…`, which no redactor recognizes.
    const failed = await runSetup(
      [{
        run: "printf 'http://u:SECRET@proxy '; head -c 1985 /dev/zero | tr '\\0' y; echo; exit 1",
      }],
      setupOpts(ws),
    );
    assertEquals(failed?.kind, "step");
    assert(!failed!.output.includes("SECRET"), failed!.output);
    assert(failed!.output.endsWith("y"));
    // A line the cut lands inside is dropped when a whole one follows it.
    const many = await runSetup(
      [{ run: 'for i in $(seq 1 400); do echo "line-$i-padding"; done; exit 1' }],
      setupOpts(ws),
    );
    const lines = many!.output.split("\n");
    assert(lines.every((l) => /^line-\d+-padding$/.test(l)), lines[0]);
    assertEquals(lines.at(-1), "line-400-padding");
  } finally {
    await rm(ws, { recursive: true });
  }
});

test("runSetup: the trace's output lines are cleaned before they are clipped", async () => {
  const ws = await makeCheckout();
  try {
    const lines: string[] = [];
    const diag = {
      ...noopDiagnostics(),
      debug(event: string, fields?: Record<string, unknown>) {
        if (event === "setup.output") lines.push(String(fields?.line));
      },
    };
    await runSetup(
      [{ run: "printf '\\033[1mfetch\\033[0m via http://u:SECRET@proxy:3128\\n'" }],
      { ...setupOpts(ws), diag },
    );
    assertEquals(lines, ["fetch via http://***@proxy:3128"]);
  } finally {
    await rm(ws, { recursive: true });
  }
});

test("runSetup: a declared service is reached directly, not through the egress proxy", async () => {
  const ws = await makeCheckout();
  // `.ryph/services.yml` puts these on the run's own network, reachable by name for the whole
  // run. Without them on NO_PROXY a setup step doing `curl http://minio:9000/health` is
  // sent to the egress proxy, which answers 403 about an in-network address and points the
  // operator at RYPH_EGRESS_BUNDLES for a hostname no bundle could ever contain.
  runtimeCredentials.set(`${ENV_PREFIX}_EGRESS_PROXY`, "http://egress-proxy.test:7460");
  runtimeCredentials.set(`${ENV_PREFIX}_EGRESS_TOKEN`, "v1.token");
  runtimeCredentials.set(`${ENV_PREFIX}_RUN_ID`, "r-1");
  try {
    await runSetup([{ run: 'printf "%s" "$NO_PROXY" > seen.txt' }], {
      ...setupOpts(ws),
      services: ["minio", "postgres"],
    });
    const seen = await readFile(`${ws}/seen.txt`, "utf8");
    assertStringIncludes(seen, "minio");
    assertStringIncludes(seen, "postgres");
    // The platform's own hosts are still there — the boundary must never become a dependency
    // of a run's control channel.
    assertStringIncludes(seen, "127.0.0.1");
  } finally {
    for (const name of ["EGRESS_PROXY", "EGRESS_TOKEN", "RUN_ID"]) {
      runtimeCredentials.delete(`${ENV_PREFIX}_${name}`);
    }
    await rm(ws, { recursive: true });
  }
});

test("the harness gets the same way out the setup steps did", () => {
  // The phase split is gone, and this is the test that says so. An agent asked to upgrade a
  // dependency resolves a registry exactly as `npm ci` did — so the credential the runner hands
  // its setup steps is the credential it hands the harness, and what bounds a leak is the
  // claim's own expiry rather than which child was told about it.
  runtimeCredentials.set(`${ENV_PREFIX}_EGRESS_PROXY`, "http://egress-proxy.test:7460");
  runtimeCredentials.set(`${ENV_PREFIX}_EGRESS_TOKEN`, "v1.token");
  runtimeCredentials.set(`${ENV_PREFIX}_RUN_ID`, "r-1");
  try {
    const env = runChildEnv(["minio"]);
    // Both spellings: the ecosystem never settled on one, and a run that only set the uppercase
    // would leave curl going direct.
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      assertEquals(env[name], "http://r-1:v1.token@egress-proxy.test:7460");
    }
    // Node CLIs (including tools launched by npx) need this opt-in for native fetch.
    assertEquals(env.NODE_USE_ENV_PROXY, "1");
    assertStringIncludes(env.NO_PROXY, "minio");
    assertStringIncludes(env.no_proxy, "127.0.0.1");
    // The scrub still holds: the raw claim is not handed over under its own name, so nothing
    // reads it out of the environment by the name the runner knows it by.
    assertEquals(env[`${ENV_PREFIX}_EGRESS_TOKEN`], undefined);
  } finally {
    for (const name of ["EGRESS_PROXY", "EGRESS_TOKEN", "RUN_ID"]) {
      runtimeCredentials.delete(`${ENV_PREFIX}_${name}`);
    }
  }
});

test("every address the caller names goes direct, each one once", () => {
  // The regression this pins was measured on a live deployment: the harness carried the proxy,
  // its MCP client dialled `mcp-gateway.<ns>.svc:7430`, and the egress proxy refused the
  // in-network address — a run whose dependencies installed fine and then died at its first
  // tool call. Nothing here can see those addresses, so the caller names them, and naming one
  // twice (two servers behind one gateway) must not repeat it in NO_PROXY.
  runtimeCredentials.set(`${ENV_PREFIX}_EGRESS_PROXY`, "http://egress-proxy.test:7460");
  runtimeCredentials.set(`${ENV_PREFIX}_EGRESS_TOKEN`, "v1.token");
  runtimeCredentials.set(`${ENV_PREFIX}_RUN_ID`, "r-1");
  runtimeCredentials.set(`${ENV_PREFIX}_ORCHESTRATOR_URL`, "http://control-plane.test:7411");
  try {
    const env = runChildEnv(["minio", "mcp-gateway.test", "mcp-gateway.test", "127.0.0.1"]);
    assertEquals(
      env.NO_PROXY,
      "localhost,127.0.0.1,::1,[::1],control-plane.test,minio,mcp-gateway.test",
    );
    assertEquals(env.no_proxy, env.NO_PROXY);
  } finally {
    for (const name of ["EGRESS_PROXY", "EGRESS_TOKEN", "RUN_ID", "ORCHESTRATOR_URL"]) {
      runtimeCredentials.delete(`${ENV_PREFIX}_${name}`);
    }
  }
});

test("a deployment that wired no egress hands its children no proxy at all", () => {
  // Cleared for the test and put back after: run from inside a ryph run, this process already
  // holds the outer run's proxy under these very names, and the scrub passes them through.
  const names = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "NODE_USE_ENV_PROXY",
  ];
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  try {
    const env = runChildEnv(["minio"]);
    assertEquals(env.HTTPS_PROXY, undefined);
    assertEquals(env.NO_PROXY, undefined);
    assertEquals(env.NODE_USE_ENV_PROXY, undefined);
  } finally {
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }
});

test("the browser's bypass is loopback and the run's services, never the platform's hosts", () => {
  // A page's JavaScript is untrusted: a bypass for the control plane, the historian or the git
  // gateway would let it dial them directly. Through the proxy, which refuses them, it cannot.
  runtimeCredentials.set(`${ENV_PREFIX}_EGRESS_PROXY`, "http://egress-proxy.test:7460");
  runtimeCredentials.set(`${ENV_PREFIX}_EGRESS_TOKEN`, "v1.token");
  runtimeCredentials.set(`${ENV_PREFIX}_RUN_ID`, "r-1");
  runtimeCredentials.set(`${ENV_PREFIX}_ORCHESTRATOR_URL`, "http://control-plane.test:7411");
  runtimeCredentials.set(`${ENV_PREFIX}_HISTORY_URL`, "http://historian.test:7420");
  runtimeCredentials.set(`${ENV_PREFIX}_GIT_ORIGIN`, "http://forge.test:7450");
  try {
    assertEquals(browserEgressProxy(["minio", "minio"]), {
      server: "http://egress-proxy.test:7460",
      username: "r-1",
      password: "v1.token",
      bypass: ["localhost", "127.0.0.1", "::1", "minio"],
    });
    // The agent's shell keeps its own NO_PROXY, platform hosts and all.
    assertEquals(
      runChildEnv(["minio"]).NO_PROXY,
      "localhost,127.0.0.1,::1,[::1],control-plane.test,historian.test,forge.test,minio",
    );
  } finally {
    for (
      const name of [
        "EGRESS_PROXY",
        "EGRESS_TOKEN",
        "RUN_ID",
        "ORCHESTRATOR_URL",
        "HISTORY_URL",
        "GIT_ORIGIN",
      ]
    ) {
      runtimeCredentials.delete(`${ENV_PREFIX}_${name}`);
    }
  }
  assertEquals(browserEgressProxy(["minio"]), null);
});
