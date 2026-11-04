/**
 * The scripts seeded runs play. Each is one task as a person might have given it, the work an
 * agent would plausibly have done, and how it ended — together they cover what the UI has to
 * show: patches awaiting approval, approved, rejected; conversations; background commands;
 * platform and MCP tool calls; failures, errors, cancellations and a lost run.
 *
 * Edits name exact text from the repos in repos.ts; `deno task test` in this package plays
 * every script against them, so a drifted line fails there rather than mid-seed.
 */

import type { Outcome, Step } from "./runner.ts";
import type { SeedCheck } from "./context.ts";

export interface Story {
  key: string;
  title: string;
  instructions: string;
  /** The fixture repo the task targets, or the workspace when `workspace` is set. */
  repo: string;
  /** Targets the GitLab project replaying `repo` (mock_gitlab.ts) instead of the local repo. */
  gitlab?: "billing" | "infra";
  workspace?: boolean;
  /** Who started the task. */
  by?: "owner" | "member";
  steps: Step[];
  outcome: Outcome;
  /** What a person does with the patch the script submits. */
  patch?: "pending" | "approve" | "reject";
  /** How long the run took, for backdating. */
  minutes: number;
}

export const STORIES: Story[] = [
  {
    key: "bounded-retries",
    title: "Stop the Stripe webhook retrying forever",
    instructions:
      "When the ledger is down, `deliver` in src/billing/webhook.ts retries in a tight loop " +
      "forever and the webhook never answers. Bound it: a few attempts with backoff, then fail " +
      "the webhook so Stripe retries it later.",
    repo: "acme-api",
    by: "member",
    minutes: 14,
    patch: "approve",
    steps: [
      {
        think:
          "The loop in `deliver` never gives up. Stripe already retries failed webhooks for three days, so the right fix is a short bounded retry here and a 5xx when it is exhausted.",
      },
      { read: "src/billing/webhook.ts" },
      {
        bash: "rg -n 'recordPayment' src/",
        out:
          'src/billing/webhook.ts:1:import { recordPayment } from "./ledger.ts";\nsrc/billing/webhook.ts:12:      await recordPayment(event);\nsrc/billing/ledger.ts:1:export async function recordPayment(event: unknown): Promise<void> {',
      },
      {
        say:
          "Only the webhook calls `recordPayment`, so bounding the loop there is safe. I'll try 4 times with exponential backoff (0.5 s, 1 s, 2 s) and then answer 503.",
      },
      {
        edit: "src/billing/webhook.ts",
        find: `async function deliver(event: unknown): Promise<void> {
  while (true) {
    try {
      await recordPayment(event);
      return;
    } catch (err) {
      console.warn("ledger write failed, retrying", err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}`,
        replace: `const ATTEMPTS = 4;

async function deliver(event: unknown): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await recordPayment(event);
      return;
    } catch (err) {
      if (attempt === ATTEMPTS) throw err;
      console.warn(\`ledger write failed (attempt \${attempt}/\${ATTEMPTS}), retrying\`, err);
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
  }
}`,
      },
      {
        edit: "src/billing/webhook.ts",
        find: `  const event = await req.json();
  await deliver(event);
  return new Response(null, { status: 204 });`,
        replace: `  const event = await req.json();
  try {
    await deliver(event);
  } catch {
    // Stripe retries a failed webhook with its own backoff for up to three days.
    return new Response("ledger unavailable", { status: 503 });
  }
  return new Response(null, { status: 204 });`,
      },
      {
        background: {
          label: "integration tests",
          command: "deno task test:integration --reporter=pretty",
          exitCode: 1,
          log: [
            "Task test:integration deno test --allow-env --allow-net --reporter=pretty tests/integration/",
            "Download https://jsr.io/@std/assert/1.0.13/mod.ts",
            "Download https://jsr.io/@std/testing/1.0.9/bdd.ts",
            "Check file:///tmp/acme-api/tests/integration/webhook_test.ts",
            "Check file:///tmp/acme-api/tests/integration/ledger_test.ts",
            "running 6 tests from ./tests/integration/ledger_test.ts",
            "records a payment once ... ok (12ms)",
            "refuses a payment for an unknown customer ... ok (4ms)",
            "rounds amounts to the currency's minor unit ... ok (3ms)",
            "writes an audit row for every payment ... ok (9ms)",
            "is idempotent on the Stripe event id ... ok (7ms)",
            "survives a ledger restart mid-write ... ok (151ms)",
            "running 4 tests from ./tests/integration/webhook_test.ts",
            "answers 204 for a delivered event ... ok (18ms)",
            "answers 400 for a payload with a bad signature ... ok (2ms)",
            "retries a ledger that is briefly unavailable ... ok (1s)",
            "answers 503 once the retries are exhausted ... FAILED (7s)",
            "",
            " ERRORS ",
            "",
            "answers 503 once the retries are exhausted => ./tests/integration/webhook_test.ts:61:6",
            "error: AssertionError: Values are not equal.",
            "",
            "    [Diff] Actual / Expected",
            "",
            "-   500",
            "+   503",
            "",
            "  throw new AssertionError(message);",
            "        ^",
            "    at assertEquals (https://jsr.io/@std/assert/1.0.13/equals.ts:64:9)",
            "    at Object.<anonymous> (file:///tmp/acme-api/tests/integration/webhook_test.ts:74:5)",
            "    at eventLoopTick (ext:core/01_core.js:179:7)",
            "    at async innerWrapped (ext:cli/40_test.js:181:5)",
            "    at async exitSanitizer (ext:cli/40_test.js:97:27)",
            "    at async outerWrapped (ext:cli/40_test.js:124:14)",
            '{"level":"warn","msg":"ledger unavailable, giving up","attempts":4,"lastError":"ECONNREFUSED 127.0.0.1:5433 (connect ECONNREFUSED 127.0.0.1:5433)","event":"evt_1PxQ2nL7a9cWb3K8sR4tYzUv","customer":"cus_Q8mN2vB7xL4kP9","elapsedMs":3512}',
            "",
            " FAILURES ",
            "",
            "answers 503 once the retries are exhausted => ./tests/integration/webhook_test.ts:61:6",
            "",
            "FAILED | 9 passed | 1 failed (9s)",
            "",
            "error: Test failed",
            "",
          ].join("\n"),
        },
      },
      {
        background: {
          label: "unit tests",
          command: "deno task test",
          exitCode: 0,
          log:
            "Task test deno test --allow-env tests/\nrunning 2 tests from ./tests/session_test.ts\nan unknown token is refused ... ok (2ms)\nan expired session is refused ... ok (1ms)\n\nok | 2 passed | 0 failed (41ms)\n",
        },
      },
      { bash: "deno check src/server.ts", out: "Check file:///tmp/acme-api/src/server.ts" },
      {
        submit: {
          title: "Bound the Stripe webhook's ledger retries",
          description:
            "`deliver` now tries the ledger 4 times with exponential backoff, then the webhook answers 503 so Stripe retries it on its own schedule instead of this process looping forever.",
        },
      },
    ],
    outcome: {
      kind: "success",
      summary:
        "The webhook now gives up after 4 attempts (0.5 s, 1 s, 2 s backoff) and answers **503**, so Stripe's own retry schedule takes over. Tests and type check pass. The patch is up for approval.",
    },
  },
  {
    key: "flaky-session-test",
    title: "Fix the flaky expired-session test",
    instructions:
      "`an expired session is refused` passes for the wrong reason: the token is unknown, not expired. Make it test expiry.",
    repo: "acme-api",
    minutes: 9,
    patch: "pending",
    steps: [
      { read: "tests/session_test.ts" },
      { read: "src/auth/session.ts" },
      {
        think:
          "The sessions map is private, so the test can't plant an expired session. A small `createSession` export with an injectable expiry is the least invasive seam.",
      },
      {
        edit: "src/auth/session.ts",
        find: "const sessions = new Map<string, Session>();\n",
        replace: `const sessions = new Map<string, Session>();

export function createSession(token: string, userId: string, ttlMs: number): Session {
  const session = { userId, expiresAt: Date.now() + ttlMs };
  sessions.set(token, session);
  return session;
}
`,
      },
      {
        edit: "tests/session_test.ts",
        find: `Deno.test("an expired session is refused", async () => {
  const req = new Request("http://x/me", { headers: { authorization: "Bearer stale" } });`,
        replace: `Deno.test("an expired session is refused", async () => {
  createSession("stale", "u1", -1);
  const req = new Request("http://x/me", { headers: { authorization: "Bearer stale" } });`,
      },
      {
        edit: "tests/session_test.ts",
        find: `import { requireSession } from "../src/auth/session.ts";`,
        replace: `import { createSession, requireSession } from "../src/auth/session.ts";`,
      },
      {
        bash: "deno task test",
        out:
          "running 2 tests from ./tests/session_test.ts\nan unknown token is refused ... ok (2ms)\nan expired session is refused ... ok (1ms)\n\nok | 2 passed | 0 failed (38ms)",
      },
      { submit: { title: "Test session expiry for real" } },
    ],
    outcome: {
      kind: "success",
      summary:
        "The expiry test now plants a session that expired a millisecond ago, so it fails if expiry stops being checked. Added a small `createSession` export for it.",
    },
  },
  {
    key: "empty-state",
    title: "Use the empty state on the billing page",
    instructions:
      "There's an EmptyState component nobody uses yet. Show it on the billing page when there are no invoices.",
    repo: "acme-web",
    by: "member",
    minutes: 26,
    patch: "pending",
    steps: [
      { read: "src/routes/+page.svelte" },
      { read: "src/lib/EmptyState.svelte" },
      {
        edit: "src/routes/+page.svelte",
        find: `<h1>Billing</h1>
<InvoiceTable invoices={data.invoices} />`,
        replace: `<h1>Billing</h1>
{#if data.invoices.length === 0}
  <EmptyState title="No invoices" body="Invoices appear here once you are billed." />
{:else}
  <InvoiceTable invoices={data.invoices} />
{/if}`,
      },
      {
        edit: "src/routes/+page.svelte",
        find: `  import InvoiceTable from "$lib/InvoiceTable.svelte";`,
        replace: `  import EmptyState from "$lib/EmptyState.svelte";
  import InvoiceTable from "$lib/InvoiceTable.svelte";`,
      },
      {
        say:
          "The billing page now shows the empty state when there are no invoices. Want different copy?",
      },
      {
        user: "Looks good. Can the copy say when the first invoice will arrive instead?",
        from: "member",
      },
      {
        think:
          "Billing runs on the 1st of the month, per the README of acme-api? It doesn't say. Keep it generic but concrete: 'at the start of next month'.",
      },
      {
        edit: "src/routes/+page.svelte",
        find: `body="Invoices appear here once you are billed."`,
        replace: `body="Your first invoice arrives at the start of next month."`,
      },
      { bash: "npm run check", out: "svelte-check found 0 errors and 0 warnings" },
      {
        submit: {
          title: "Show an empty state on the billing page",
          description: "Uses the existing EmptyState component when there are no invoices.",
        },
      },
    ],
    outcome: {
      kind: "success",
      summary:
        "The billing page shows **No invoices — your first invoice arrives at the start of next month** when the list is empty. Patch submitted.",
    },
  },
  {
    key: "currency",
    title: "Format invoice amounts as currency",
    instructions: "Amounts in the invoice table are raw cents. Format them.",
    repo: "acme-web",
    minutes: 7,
    patch: "reject",
    steps: [
      { read: "src/lib/InvoiceTable.svelte" },
      {
        edit: "src/lib/InvoiceTable.svelte",
        find: "        <td>{invoice.amount}</td>",
        replace:
          `        <td>{(invoice.amount / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}</td>`,
      },
      { submit: { title: "Format invoice amounts as USD" } },
    ],
    outcome: { kind: "success", summary: "Amounts are formatted as US dollars." },
  },
  {
    key: "latency",
    title: "Why is GET /me slow under load?",
    instructions:
      "p95 of GET /me jumped to 800 ms last week. Find out why; don't change anything yet.",
    repo: "acme-api",
    minutes: 18,
    steps: [
      {
        tool: "memory__search",
        args: { query: "GET /me latency" },
        result:
          "1 memory:\n- (fact) acme-api's sessions live in process memory; every pod has its own map.",
      },
      { read: "src/auth/session.ts" },
      {
        bash: "git log --oneline -5",
        out:
          "3f2a91c Add session and webhook tests\n8e1d4b0 Retry Stripe webhooks that time out\n1c0ffee Initial service skeleton",
      },
      {
        think:
          "Nothing touched sessions recently. The map is per-pod, so with replicas > 1 a session minted on one pod misses on the others — but that would be 401s, not latency. Let me look at the deployment.",
      },
      {
        tool: "web__fetch",
        args: { url: "https://docs.deno.com/runtime/reference/env_variables/" },
        result: "# Environment variables\n\nDENO_V8_FLAGS … (trimmed)",
      },
      {
        bash: "rg -n 'replicas|cpu' ../infra/k8s/api.yaml",
        out: "rg: ../infra/k8s/api.yaml: No such file or directory (os error 2)",
        exit: 2,
      },
      {
        say:
          "I can't see the infra repo from this task. Based on the code alone: `requireSession` is O(1) and does no I/O, so the latency is not in it. The likeliest cause is CPU throttling: the api pod requests 250m, which matches the other services' complaints.",
      },
    ],
    outcome: {
      kind: "no-changes",
      summary:
        "`GET /me` does no I/O; the handler can't be the 800 ms. The api pod requests **250m CPU** (infra/k8s/api.yaml), and the jump lines up with the traffic increase, so CPU throttling is the likely cause. Suggest raising the request to 500m and watching `container_cpu_cfs_throttled_seconds_total`.",
    },
  },
  {
    key: "bump-cpu",
    title: "Raise the api's CPU request to 500m",
    instructions:
      "Follow-up to the /me latency investigation: raise acme-api's CPU request to 500m.",
    repo: "infra",
    minutes: 4,
    patch: "approve",
    steps: [
      { read: "k8s/api.yaml" },
      { edit: "k8s/api.yaml", find: "              cpu: 250m", replace: "              cpu: 500m" },
      {
        bash: "kubectl apply --dry-run=client -f k8s/api.yaml",
        out: "deployment.apps/acme-api configured (dry run)",
      },
      { submit: { title: "acme-api: request 500m CPU" } },
    ],
    outcome: { kind: "success", summary: "acme-api now requests 500m CPU." },
  },
  {
    key: "terraform-plan",
    title: "Plan a regional node pool for the cluster",
    instructions: "Add a second node pool in europe-west4 and show me the terraform plan.",
    repo: "infra",
    by: "member",
    minutes: 11,
    steps: [
      { read: "terraform/main.tf" },
      {
        think:
          "This is an Autopilot cluster: node pools are managed by Google and can't be added. A regional cluster or a second cluster would be the alternatives.",
      },
      {
        bash: "terraform -chdir=terraform plan",
        out:
          'Error: No valid credential sources found\n\n  with provider["registry.terraform.io/hashicorp/google"],\n  on <empty> line 0:\n  (source code not available)',
        exit: 1,
      },
      {
        say:
          "I can't run a plan here: there are no Google credentials in this environment. And the request itself doesn't fit: `acme-prod` is an **Autopilot** cluster, which has no user-managed node pools.",
      },
    ],
    outcome: {
      kind: "failed",
      summary:
        "Couldn't do this: `acme-prod` is an Autopilot cluster (no node pools to add), and the environment has no Google credentials for `terraform plan`. A second regional cluster would need a design decision first.",
    },
  },
  {
    key: "postgres",
    title: "Move sessions to Postgres",
    instructions: "Sessions live in memory, so every pod has its own. Store them in Postgres.",
    repo: "acme-api",
    minutes: 6,
    steps: [
      { read: "src/auth/session.ts" },
      {
        think:
          "There's no database client in this service yet. I'll need a driver, a migration, and a pool.",
      },
      { bash: "deno add jsr:@db/postgres", out: "Add jsr:@db/postgres@0.19.5" },
      {
        write: "migrations/0001_sessions.sql",
        content:
          "create table sessions (\n  token text primary key,\n  user_id text not null,\n  expires_at timestamptz not null\n);\n",
      },
      {
        say:
          "Added a migration for a `sessions` table. Next: the pool and swapping the map for queries.",
      },
      { cancel: true },
    ],
    outcome: { kind: "success", summary: "unused: the person cancels first" },
  },
  {
    key: "clone-error",
    title: "Update the README badges",
    instructions: "Add CI and coverage badges to the README.",
    repo: "acme-web",
    minutes: 1,
    steps: [],
    outcome: {
      kind: "error",
      reason: "git clone failed: the gateway answered 502 (upstream unavailable)",
      during: "cloning",
    },
  },
  {
    key: "lost",
    title: "Profile the ledger client",
    instructions: "Profile recordPayment under load and report the hot spots.",
    repo: "acme-api",
    minutes: 3,
    steps: [
      { read: "src/billing/ledger.ts" },
      {
        background: {
          label: "load test",
          command: "deno run -A bench/ledger.ts",
          exitCode: 0,
          service: true,
          log: "warming up…\n1000 req/s\n",
        },
      },
      { say: "Load test is running; collecting a CPU profile next." },
    ],
    outcome: { kind: "lost" },
  },
  {
    key: "readme",
    title: "Document the dev setup in the README",
    instructions: "The README doesn't say you need acme-api running. Fix that.",
    repo: "acme-web",
    minutes: 5,
    patch: "approve",
    steps: [
      { read: "README.md" },
      {
        edit: "README.md",
        find:
          "The customer dashboard. `npm run dev` serves it on :5173 against a local acme-api.\n",
        replace:
          "The customer dashboard. `npm run dev` serves it on :5173 against a local acme-api.\n\n## Developing\n\n1. Start acme-api: `deno task dev` in that repo (it serves on :8000).\n2. `npm install && npm run dev` here.\n",
      },
      { submit: { title: "README: how to run the dashboard locally" } },
    ],
    outcome: {
      kind: "success",
      summary: "The README now says to start acme-api first, with the commands.",
    },
  },
  {
    key: "stripe-version",
    title: "Which Stripe API version do we pin?",
    instructions:
      "Quick question: which Stripe API version does acme-api pin, and is it still supported?",
    repo: "acme-api",
    minutes: 3,
    steps: [
      { bash: "rg -n -i 'stripe-version|apiVersion' .", out: "", exit: 1 },
      {
        tool: "web__search",
        args: { query: "Stripe API versioning default version webhook" },
        result:
          "1. Versioning | Stripe Documentation — https://docs.stripe.com/api/versioning\n2. Upgrading your API version — https://docs.stripe.com/upgrades",
      },
      { say: "Nothing in the code pins a version." },
    ],
    outcome: {
      kind: "no-changes",
      summary:
        "acme-api pins **no** Stripe API version, so webhooks arrive in the account's default version (set in the Stripe dashboard). Pinning one in the webhook endpoint's settings would make upgrades deliberate.",
    },
  },
];

/**
 * The gitlab fixture's stories, on the GitLab projects that replay acme-api and infra
 * (mock_gitlab.ts): each submits a patch that becomes a merge request there.
 */
export const GITLAB_STORIES = {
  /** Approved, so it opens !1 on acme/billing-api; the fixture then talks on that thread. */
  ledgerTimeout: {
    key: "gitlab-ledger-timeout",
    title: "Time out ledger writes after 5 seconds",
    instructions:
      "`recordPayment` waits on the ledger forever when it hangs. Give the request a timeout so " +
      "the webhook's retry can kick in.",
    repo: "acme-api",
    gitlab: "billing",
    minutes: 9,
    patch: "approve",
    steps: [
      { read: "src/billing/ledger.ts" },
      {
        think:
          "There is no timeout on the fetch, so a hung ledger holds the webhook open until Stripe gives up. AbortSignal.timeout is enough here.",
      },
      {
        edit: "src/billing/ledger.ts",
        find: `    method: "POST",
    body: JSON.stringify(event),
  });`,
        replace: `    method: "POST",
    body: JSON.stringify(event),
    // A hung ledger fails the attempt, so the webhook's retry gets a turn.
    signal: AbortSignal.timeout(5_000),
  });`,
      },
      {
        bash: "deno task test",
        out:
          "running 2 tests from ./tests/session_test.ts\nan unknown token is refused ... ok (2ms)\nan expired session is refused ... ok (1ms)\n\nok | 2 passed | 0 failed (41ms)",
      },
      {
        submit: {
          title: "Time out ledger writes after 5 seconds",
          description:
            "`recordPayment` now aborts after 5 s, so a hung ledger fails the attempt instead of holding the webhook open.",
        },
      },
    ],
    outcome: {
      kind: "success",
      summary: "Ledger writes now time out after 5 seconds; the merge request is open for review.",
    },
  },
  /** Auto-submitted on acme/platform/infra-live, then merged there. */
  replicas: {
    key: "gitlab-replicas",
    title: "Run two acme-api replicas",
    instructions: "One replica means every deploy is an outage. Run two.",
    repo: "infra",
    gitlab: "infra",
    minutes: 4,
    steps: [
      { read: "k8s/api.yaml" },
      { edit: "k8s/api.yaml", find: "  replicas: 1\n", replace: "  replicas: 2\n" },
      { submit: { title: "Run two acme-api replicas" } },
    ],
    outcome: { kind: "success", summary: "acme-api now runs two replicas." },
  },
} satisfies Record<string, Story>;

/** The checks each GitLab story's merge request ends up with: ryph's suite, and its statuses. */
export const GITLAB_CHECKS: Record<keyof typeof GITLAB_STORIES, SeedCheck[]> = {
  ledgerTimeout: [
    { name: "lint", run: "deno lint", state: "passed", seconds: 14, logTail: "Checked 12 files" },
    {
      name: "test",
      run: "deno task test",
      state: "failed",
      seconds: 48,
      logTail: [
        "running 3 tests from ./tests/ledger_test.ts",
        "a hung ledger fails the attempt ... FAILED (5s)",
        "",
        "error: AssertionError: expected the retry to be scheduled",
        "",
        "FAILED | 2 passed | 1 failed (5s)",
      ].join("\n"),
    },
  ],
  replicas: [
    {
      name: "kubeconform",
      run: "kubeconform -strict k8s/",
      state: "passed",
      seconds: 6,
      logTail: "Summary: 4 resources found in 2 files - Valid: 4, Invalid: 0, Errors: 0",
    },
  ],
};

/** What the run a `/ryph` comment on the ledger merge request starts does. */
export const GITLAB_FOLLOW_UP: { steps: Step[]; outcome: Outcome } = {
  steps: [
    { read: "src/billing/ledger.ts" },
    {
      say:
        "5 s is well under Stripe's own 20 s webhook timeout, so a retry still fits. I'd keep it fixed until someone needs it tuned.",
    },
  ],
  outcome: {
    kind: "no-changes",
    summary:
      "Kept the timeout at 5 s: it leaves room for a retry inside Stripe's 20 s webhook timeout. Say if you want it configurable.",
  },
};

/** What the run a `/ryph` comment on a GitLab issue starts does. */
export const GITLAB_ISSUE_RUN: { steps: Step[]; outcome: Outcome } = {
  steps: [
    { read: "src/billing/webhook.ts" },
    {
      bash: "rg -n 'setTimeout' src/billing/",
      out: "src/billing/webhook.ts:16:      await new Promise((r) => setTimeout(r, 1000));",
    },
    {
      think:
        "The 500s line up with the retry loop: it never gives up, so the request is cut by the platform's timeout, which answers 500.",
    },
  ],
  outcome: {
    kind: "no-changes",
    summary:
      "The 500s come from `deliver` in src/billing/webhook.ts: it retries the ledger forever, so the platform cuts the request off. Bounding the retries and answering 503 would let Stripe retry instead.",
  },
};

/** Put an approved patch, an awaiting-review patch and a no-change conversation first, so a
 * small history is useful without depending on the catalogue's incidental order. */
export function historyStories(count: number): Story[] {
  const keys = ["bounded-retries", "empty-state", "stripe-version"];
  const first = keys.map((key) => STORIES.find((story) => story.key === key)!);
  const ordered = [...first, ...STORIES.filter((story) => !keys.includes(story.key))];
  return Array.from({ length: count }, (_, i) => ordered[i % ordered.length]);
}

/** The scripts live runs loop through while the playground is up. */
export const WORKING: Step[] = [
  { think: "Next: the session store needs a cleanup job for expired rows." },
  { read: "src/auth/session.ts" },
  {
    bash: "deno task test",
    out:
      "running 2 tests from ./tests/session_test.ts\nan unknown token is refused ... ok (2ms)\nan expired session is refused ... ok (1ms)\n\nok | 2 passed | 0 failed (40ms)",
  },
  { say: "Tests still pass. Looking at how expired sessions get cleaned up." },
  {
    bash: "rg -n 'expiresAt' src/",
    out:
      "src/auth/session.ts:3:  expiresAt: number;\nsrc/auth/session.ts:12:  if (!session || session.expiresAt < Date.now()) {",
  },
  {
    think:
      "Nothing ever deletes an expired session; the map only grows. A sweep on an interval, or deleting on read, would fix it.",
  },
];

/**
 * The live run's opening: three subagents, one answered, one answered and continued, and one still
 * at work for as long as the playground runs.
 */
export const DELEGATING: Step[] = [
  { think: "Starting with how sessions are stored. Three things to look at; I'll hand them out." },
  {
    subagent: {
      label: "Find where sessions are read",
      mode: "explore",
      task:
        "In acme-api, find every place a session is read or written. List file:line for each, and say which ones check `expiresAt`.",
      steps: [
        { think: "A grep for the store's map and for `expiresAt` should cover it." },
        {
          bash: "rg -n 'sessions\\.|expiresAt' src/",
          out:
            "src/auth/session.ts:3:  expiresAt: number;\nsrc/auth/session.ts:8:const sessions = new Map<string, Session>();\nsrc/auth/session.ts:12:  if (!session || session.expiresAt < Date.now()) {",
        },
        { read: "src/auth/session.ts" },
      ],
      answer:
        "Sessions live in one `Map` in src/auth/session.ts:8. Only `getSession` (line 12) reads them, and it checks `expiresAt`. Nothing ever deletes one.",
    },
  },
  {
    subagent: {
      label: "Review the test coverage",
      mode: "explore",
      task:
        "Read tests/session_test.ts and say what an expiry sweep would need tested that is not covered yet.",
      steps: [
        { read: "tests/session_test.ts" },
        { think: "Two tests, neither about removal." },
      ],
      answer:
        "The tests cover an unknown token and an expired one being refused. Nothing checks that an expired session is removed, or that a live one survives a sweep.",
    },
  },
  { ends: "Find where sessions are read" },
  { ends: "Review the test coverage" },
  {
    tell: {
      label: "Review the test coverage",
      message: "Draft the two missing test cases as code, but do not write the file.",
      steps: [{ think: "Two cases: a sweep removes the expired one and keeps the live one." }],
      answer:
        '```ts\nDeno.test("a sweep removes expired sessions", () => { /* ... */ });\nDeno.test("a sweep keeps live sessions", () => { /* ... */ });\n```',
    },
  },
  { ends: "Review the test coverage" },
  {
    subagent: {
      label: "Watch the test suite",
      mode: "work",
      task: "Run the test suite in watch mode and tell me when anything fails.",
      steps: [
        {
          bash: "deno task test --watch",
          out:
            "Watcher Test started.\nok | 2 passed | 0 failed (40ms)\nWatcher Process finished. Restarting on file change...",
        },
      ],
    },
  },
  { tell: { label: "Watch the test suite", message: "Only report failures, not passes." } },
  {
    say:
      "Sessions are only ever added. I'll add a sweep on an interval; a subagent is watching the tests while I do.",
  },
  // The work is not done, and the page shows that: Cancel stays, no Finish.
  {
    tool: "ryph__report_outcome",
    args: {
      outcome: "in-progress",
      summary: "Adding an expiry sweep; a subagent is watching the tests.",
    },
    result:
      "Noted: in-progress. The run stays open. Report again once that changes; if it ends on its idle clock meanwhile, it ends unfinished.",
  },
];

/** What a scripted run answers any message with: it does not pretend to understand it. */
export function replyTo(text: string): Step[] {
  const quoted = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  return [
    {
      think:
        `The person wrote: "${quoted}". This is the playground's scripted runner, so I acknowledge it and carry on.`,
    },
    { bash: "git status --short", out: "" },
    {
      say:
        `Got it: "${quoted}". _(This run is played by the playground's scripted runner, which answers every message the same way.)_`,
    },
  ];
}

/** What a run nobody scripted does: a task started in the UI, or an automation's. */
export function opening(title: string, instructions: string): Step[] {
  return [
    { think: `Task: ${title || "(no title)"}. ${instructions.slice(0, 300)}` },
    { bash: "ls", out: "README.md\nsrc\ntests" },
    {
      say:
        "I've read the task and looked around the checkout. _(Scripted: the playground plays this run, so nothing real happens. Send a message to see the conversation flow.)_",
    },
  ];
}
