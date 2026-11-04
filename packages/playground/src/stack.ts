/**
 * The processes a playground is: the `ryph` host from source (every service in one process,
 * migrations applied at boot, the forge embedded, the manual provisioner), the web app's Vite dev
 * server, and a mock model endpoint served from this process. Nothing here needs a container
 * runtime, which is the point: an agent's run pod has none.
 */

import { type FileHandle, mkdir, open } from "node:fs/promises";
import { command, type CommandStatus } from "@ryph/process";
import { join } from "@std/path";
import { parseSetupToken } from "../../../deploy/compose-networked/setup_token.ts";
import { type MockChat, serveMockChat } from "./mock_chat.ts";
import { GITLAB_SECRETS, type MockGitlab, serveMockGitlab } from "./mock_gitlab.ts";
import { serveMockModel } from "./mock_model.ts";

export interface Ports {
  control: number;
  forge: number;
  modelProxy: number;
  mcpGateway: number;
  app: number;
  mockModel: number;
  /** The mock Telegram, Zulip, Slack and Discord, and the page that shows what was said there. */
  mockChat: number;
  /** The fake GitLab (mock_gitlab.ts). */
  mockGitlab: number;
}

export function portsFor(offset: number): Ports {
  return {
    control: 7411 + offset,
    forge: 7412 + offset,
    modelProxy: 7420 + offset,
    mcpGateway: 7430 + offset,
    app: 5173 + offset,
    mockModel: 7480 + offset,
    mockChat: 7481 + offset,
    mockGitlab: 7482 + offset,
  };
}

export interface Layout {
  /** The repo checkout this playground runs from. */
  root: string;
  /** Everything the playground writes: under `data/`, which is gitignored. */
  dir: string;
  home: string;
  repos: string;
  work: string;
  logs: string;
  manifest: string;
}

export function layoutFor(root: string, name: string): Layout {
  const dir = join(root, "data", "playground", name);
  return {
    root,
    dir,
    home: join(dir, "home"),
    repos: join(dir, "repos"),
    work: join(dir, "work"),
    logs: join(dir, "logs"),
    manifest: join(dir, "manifest.json"),
  };
}

/** The manual provisioner's block on the host's stdout names the run and its bootstrap token. */
const TOKEN_LINE = /RYPH_RUN_ID="([^"]+)".*?RYPH_BOOTSTRAP_TOKEN="([0-9a-f]+)"/;

export interface Host {
  stop(): Promise<void>;
  exited: Promise<CommandStatus>;
  /** The token an unclaimed instance's first registration needs, as its output prints it: waited
   * for a few seconds, since it is printed just after the control plane starts answering. Null
   * when none comes, which is a claimed instance. */
  setupToken(): Promise<string | null>;
}

/** What the app's server vouches for client addresses with: one per playground, handed to the
 * host and the dev server alike. Multi-user, the host refuses to start without it. */
export function mintProxySecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The environment the host gets: this process's own, minus every RYPH_ variable, so a developer's
 * shell (a RYPH_DB, a GitHub token) can never point the playground at something real.
 */
function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...process.env } as Record<string, string>).filter(([k]) =>
      !k.startsWith("RYPH_")
    ),
  );
}

export async function startHost(
  layout: Layout,
  ports: Ports,
  proxySecret: string,
  onToken: (runId: string, token: string) => void,
  chat: MockChat["urls"],
  gitlabUrl: string,
): Promise<Host> {
  await mkdir(layout.home, { recursive: true });
  await mkdir(layout.repos, { recursive: true });
  await mkdir(layout.logs, { recursive: true });
  const log = await open(join(layout.logs, "host.log"), "a");
  const env: Record<string, string> = {
    ...cleanEnv(),
    RYPH_HOME: layout.home,
    // Nothing is launched: the scripted runner plays every run from the token the host prints.
    // `ryph up` refuses `manual` without the dev opt-in beside it.
    RYPH_PROVISIONER: "manual",
    RYPH_ALLOW_MANUAL_PROVISIONER: "1",
    // Multi-user, so the seed can register an owner and invite a team: a single-user ryph
    // refuses both. The first registration needs the setup token the host prints.
    RYPH_MULTIUSER: "on",
    RYPH_PROXY_SECRET: proxySecret,
    RYPH_LOCAL_REPO_ROOT: layout.repos,
    RYPH_PORT: String(ports.control),
    RYPH_FORGE_PORT: String(ports.forge),
    RYPH_MODEL_PROXY_PORT: String(ports.modelProxy),
    RYPH_MCP_GATEWAY_PORT: String(ports.mcpGateway),
    // The host would serve a built UI here when one exists; the playground uses Vite instead.
    RYPH_APP_PORT: String(ports.app + 1000),
    RYPH_APP_URL: `http://localhost:${ports.app}`,
    // The mock model and the stand-in tool server live on loopback.
    RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS: "1",
    RYPH_MCP_ALLOW_INSECURE: "1",
    RYPH_MCP_ALLOW_PRIVATE_UPSTREAMS: "1",
    RYPH_EGRESS: "open",
    // The mock chat platforms (mock_chat.ts). Zulip needs nothing: its realm is each room's own.
    RYPH_CHAT_TELEGRAM_API_URL: chat.telegram,
    RYPH_CHAT_SLACK_API_URL: chat.slack,
    RYPH_CHAT_DISCORD_API_URL: chat.discord,
    // The fake GitLab (mock_gitlab.ts), in bot mode: webhooks, sign-in and a sign-up group.
    RYPH_GITLAB_URL: gitlabUrl,
    RYPH_GITLAB_TOKEN: GITLAB_SECRETS.botToken,
    RYPH_GITLAB_WEBHOOK_SECRET: GITLAB_SECRETS.webhookSecret,
    RYPH_GITLAB_CLIENT_ID: GITLAB_SECRETS.clientId,
    RYPH_GITLAB_CLIENT_SECRET: GITLAB_SECRETS.clientSecret,
    RYPH_GITLAB_GROUP: GITLAB_SECRETS.group,
    // On, so the checks pages read the suites the gitlab fixture installs. Nothing can launch a
    // check here, so the service says it cannot run them and never starts one.
    RYPH_CHECKS: "on",
    // Short, so a run the playground abandons on purpose is marked lost while seeding waits.
    // Live runs beat every 10 s.
    RYPH_HEARTBEAT_TIMEOUT_MS: "15000",
    RYPH_REAPER_INTERVAL_MS: "3000",
    RYPH_LOG_LEVEL: "warn",
  };
  // This runtime, on the CLI's source: the binary's `up`, without the binary.
  const child = await command(process.execPath, {
    args: ["--no-env-file", "src/main.ts", "up", "--no-setup"],
    cwd: join(layout.root, "packages", "ryph"),
    env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  let setupToken: string | null = null;
  const readSetup = (line: string) => setupToken = parseSetupToken(line) ?? setupToken;
  const pumps = Promise.all([
    drain(child.stdout, log, (line) => {
      readSetup(line);
      const m = TOKEN_LINE.exec(line);
      if (m) onToken(m[1], m[2]);
    }),
    drain(child.stderr, log, readSetup),
  ]);
  const exited = child.status.then(async (s) => {
    await pumps.catch(() => {});
    await log.close();
    return s;
  });

  await waitFor(`http://127.0.0.1:${ports.control}/healthz`, 60_000, exited, "the host");
  return {
    exited,
    setupToken: async () => {
      for (let waited = 0; setupToken === null && waited < 5_000; waited += 100) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return setupToken;
    },
    stop: async () => {
      try {
        child.kill("SIGINT");
      } catch { /* already gone */ }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
      }, 20_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

export interface App {
  stop(): Promise<void>;
}

export async function startApp(
  layout: Layout,
  ports: Ports,
  proxySecret: string,
  gitlabUrl: string,
): Promise<App> {
  const log = await open(join(layout.logs, "app.log"), "a");
  // The app's own `dev` script, Vite's dev server.
  const child = await command(process.execPath, {
    args: ["run", "dev", "--port", String(ports.app), "--strictPort"],
    cwd: join(layout.root, "packages", "app"),
    // 127.0.0.1, not localhost: the host binds that alone, and localhost may be ::1 first.
    env: {
      ...cleanEnv(),
      RYPH_API_URL: `http://127.0.0.1:${ports.control}`,
      RYPH_PROXY_SECRET: proxySecret,
      PUBLIC_GITLAB_URL: gitlabUrl,
      PUBLIC_GITLAB_CLIENT_ID: GITLAB_SECRETS.clientId,
    },
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const pumps = Promise.all([drain(child.stdout, log), drain(child.stderr, log)]);
  const exited = child.status.then(async (s) => {
    await pumps.catch(() => {});
    await log.close();
    return s;
  });
  await waitFor(`http://localhost:${ports.app}/`, 120_000, exited, "the app's dev server");
  return {
    stop: async () => {
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      await exited;
    },
  };
}

export function startMockChat(layout: Layout, ports: Ports): Promise<MockChat> {
  return serveMockChat(ports.mockChat, join(layout.dir, "chat.json"));
}

export function startMockGitlab(ports: Ports): Promise<MockGitlab> {
  return serveMockGitlab(ports.mockGitlab, {
    appUrl: `http://localhost:${ports.app}`,
    hookUrl: `http://127.0.0.1:${ports.forge}/v1/hooks/gitlab`,
  });
}

export function startMockModel(ports: Ports): Promise<{ stop(): Promise<void> }> {
  return serveMockModel(ports.mockModel);
}

/** Copies a child's output into its log file, handing each complete line to `onLine`. */
async function drain(
  stream: ReadableStream<Uint8Array>,
  log: FileHandle,
  onLine?: (line: string) => void,
): Promise<void> {
  const enc = new TextEncoder();
  let buf = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    await log.write(enc.encode(chunk));
    if (!onLine) continue;
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  }
}

async function waitFor(
  url: string,
  timeoutMs: number,
  exited: Promise<CommandStatus>,
  what: string,
): Promise<void> {
  let gone = false;
  exited.then(() => gone = true);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (gone) throw new Error(`${what} exited during startup; see its log`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      await res.body?.cancel();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`${what} did not answer at ${url} within ${timeoutMs / 1000} s`);
}
