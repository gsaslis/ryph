/**
 * The repositories a playground connects: small, real git repos with a few weeks of history by a
 * few people, so a run can clone them, read real files and edit real lines. The scripts in
 * stories.ts edit these files by exact text, so a change here must keep the lines they find.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { command } from "@ryph/process";
import { join } from "@std/path";

export interface RepoFixture {
  name: string;
  description: string;
  /** Commits oldest first; each one writes the files it lists. */
  commits: Array<
    { author: string; daysAgo: number; message: string; files: Record<string, string> }
  >;
}

const PEOPLE: Record<string, string> = {
  owner: "Olivia Owner <owner@ryph.local>",
  member: "Max Member <member@ryph.local>",
  priya: "Priya Raman <priya@acme.example>",
};

export const REPOS: RepoFixture[] = [
  {
    name: "acme-api",
    description: "The billing and accounts HTTP service (Deno).",
    commits: [
      {
        author: "priya",
        daysAgo: 60,
        message: "Initial service skeleton",
        files: {
          "README.md": `# acme-api

The billing and accounts service behind acme.example.

\`\`\`sh
deno task dev     # serve on :8000
deno task test    # unit tests
\`\`\`
`,
          "deno.json": `{
  "tasks": {
    "dev": "deno run --watch --allow-net --allow-env src/server.ts",
    "test": "deno test --allow-env tests/"
  },
  "imports": {
    "@std/assert": "jsr:@std/assert@1"
  }
}
`,
          "src/server.ts": `import { handleWebhook } from "./billing/webhook.ts";
import { requireSession } from "./auth/session.ts";

const routes: Record<string, (req: Request) => Promise<Response>> = {
  "POST /webhooks/stripe": handleWebhook,
  "GET /me": async (req) => Response.json(await requireSession(req)),
};

Deno.serve({ port: 8000 }, (req) => {
  const key = \`\${req.method} \${new URL(req.url).pathname}\`;
  const route = routes[key];
  return route ? route(req) : new Response("not found", { status: 404 });
});
`,
          "src/auth/session.ts": `export interface Session {
  userId: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

export async function requireSession(req: Request): Promise<Session> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    throw new Response("unauthorized", { status: 401 });
  }
  return session;
}
`,
        },
      },
      {
        author: "member",
        daysAgo: 41,
        message: "Retry Stripe webhooks that time out",
        files: {
          "src/billing/webhook.ts": `import { recordPayment } from "./ledger.ts";

export async function handleWebhook(req: Request): Promise<Response> {
  const event = await req.json();
  await deliver(event);
  return new Response(null, { status: 204 });
}

async function deliver(event: unknown): Promise<void> {
  while (true) {
    try {
      await recordPayment(event);
      return;
    } catch (err) {
      console.warn("ledger write failed, retrying", err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
`,
          "src/billing/ledger.ts":
            `export async function recordPayment(event: unknown): Promise<void> {
  const res = await fetch(Deno.env.get("LEDGER_URL") + "/payments", {
    method: "POST",
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(\`ledger answered \${res.status}\`);
}
`,
        },
      },
      {
        author: "owner",
        daysAgo: 30,
        message: "Add session and webhook tests",
        files: {
          "tests/session_test.ts": `import { assertRejects } from "@std/assert";
import { requireSession } from "../src/auth/session.ts";

Deno.test("an unknown token is refused", async () => {
  await assertRejects(() => requireSession(new Request("http://x/me")));
});

Deno.test("an expired session is refused", async () => {
  const req = new Request("http://x/me", { headers: { authorization: "Bearer stale" } });
  await assertRejects(() => requireSession(req));
});
`,
        },
      },
    ],
  },
  {
    name: "acme-web",
    description: "The customer dashboard (SvelteKit).",
    commits: [
      {
        author: "priya",
        daysAgo: 55,
        message: "Scaffold the dashboard",
        files: {
          "README.md": `# acme-web

The customer dashboard. \`npm run dev\` serves it on :5173 against a local acme-api.
`,
          "package.json": `{
  "name": "acme-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "check": "svelte-check"
  }
}
`,
          "src/routes/+page.svelte": `<script lang="ts">
  import InvoiceTable from "$lib/InvoiceTable.svelte";
  let { data } = $props();
</script>

<h1>Billing</h1>
<InvoiceTable invoices={data.invoices} />
`,
          "src/lib/InvoiceTable.svelte": `<script lang="ts">
  let { invoices } = $props();
</script>

<table>
  <thead>
    <tr><th>Invoice</th><th>Amount</th><th>Status</th></tr>
  </thead>
  <tbody>
    {#each invoices as invoice}
      <tr>
        <td>{invoice.number}</td>
        <td>{invoice.amount}</td>
        <td>{invoice.status}</td>
      </tr>
    {/each}
  </tbody>
</table>
`,
        },
      },
      {
        author: "member",
        daysAgo: 20,
        message: "Show an empty state when there are no invoices",
        files: {
          "src/lib/EmptyState.svelte": `<script lang="ts">
  let { title, body } = $props();
</script>

<div class="empty">
  <h2>{title}</h2>
  <p>{body}</p>
</div>
`,
        },
      },
    ],
  },
  {
    name: "infra",
    description: "Terraform and Kubernetes manifests for the acme stack.",
    commits: [
      {
        author: "owner",
        daysAgo: 50,
        message: "Cluster and api deployment",
        files: {
          "README.md": `# infra

Terraform for the GKE cluster (\`terraform/\`) and the manifests deployed to it (\`k8s/\`).
`,
          "terraform/main.tf": `resource "google_container_cluster" "acme" {
  name     = "acme-prod"
  location = "us-central1"

  enable_autopilot = true
}
`,
          "k8s/api.yaml": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: acme-api
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/acme-api:latest
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
`,
        },
      },
    ],
  },
];

async function git(dir: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  const out = await command("git", {
    args,
    cwd: dir,
    env,
    stdout: "null",
    stderr: "piped",
  })
    .output();
  if (!out.success) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  }
}

/** Writes the repo under `root` with its history, each commit dated as its fixture says. */
export async function createRepo(root: string, repo: RepoFixture): Promise<string> {
  const dir = join(root, repo.name);
  await rm(dir, { recursive: true }).catch(() => {});
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "--quiet", "-b", "main"]);
  for (const commit of repo.commits) {
    for (const [path, content] of Object.entries(commit.files)) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    const [, name, email] = /^(.*) <(.*)>$/.exec(PEOPLE[commit.author])!;
    const date = new Date(Date.now() - commit.daysAgo * 86_400_000).toISOString();
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "--quiet", "-m", commit.message], {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: date,
    });
  }
  return dir;
}
