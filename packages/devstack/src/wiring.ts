/**
 * Cross-package wiring checks for the dev stack: the documented links between host, forge, and
 * app .env files — URLs that must point at the sibling service, credentials that must match on
 * both sides, and settings that require companions.
 *
 * Invariants:
 * - Checks read only the declared .env files the running stack actually consumes (host, forge,
 *   app); standalone-mode files (orchestrator, auth, model-proxy) are out of scope.
 * - Secret values are compared, never carried in a note; notes may carry URLs, ports, and
 *   public identifiers only.
 * - Every check names the env var it validated and the package that declares it, so a failure
 *   points directly at the knob to edit.
 *
 * Documented rules deliberately not checked here, because .env files cannot answer them:
 * - RUNNER_HEARTBEAT_INTERVAL_MS must sit well under the control plane's
 *   RYPH_HEARTBEAT_TIMEOUT_MS — the runner side is set per container, not in a stack .env.
 * - RYPH_AGENT_IMAGE must name an image that actually carries the harness layer — only a
 *   launch can tell, and the orchestrator refuses a harness kind it does not offer anyway.
 * - The GitHub App's OAuth callback URL must land on the app's /github/callback route — that
 *   value lives in the App's settings on github.com, outside this machine entirely. The same
 *   holds for a GitLab OAuth application's /gitlab/callback, and for each GitLab project's
 *   webhook, pasted into the project's settings on the instance.
 */

import { readFile } from "node:fs/promises";
import { repoRoot } from "./stack.ts";

export interface WiringCheck {
  label: string;
  status: "ok" | "bad" | "skip";
  note: string;
  /**
   * True when the unit reading this value refuses to BOOT on it, as opposed to booting with a
   * link that leads nowhere: `up` stops before launching on these, and only these.
   */
  fatal?: boolean;
}

export async function wiringChecks(): Promise<WiringCheck[]> {
  const host = await envOf("host");
  const forge = await envOf("forge");
  const app = await envOf("app");
  const hostPort = int(host.get("RYPH_PORT")) ?? 7411;
  const forgePort = int(forge.get("RYPH_FORGE_PORT")) ?? 7412;
  const proxyPort = int(host.get("RYPH_MODEL_PROXY_PORT")) ?? 7420;
  const mcpPort = int(host.get("RYPH_MCP_GATEWAY_PORT")) ?? 7430;
  const provisioner = host.get("RYPH_PROVISIONER") ?? "manual";
  const docker = provisioner === "docker";
  // Docker puts the runner behind a boundary the host's loopback does not cross, so the loopback
  // checks below apply only there.
  const hostFix = "use host.docker.internal";

  const checks: WiringCheck[] = [];
  const add = (label: string, status: WiringCheck["status"], note: string) =>
    checks.push({ label, status, note });
  const fatal = (label: string, note: string) =>
    checks.push({ label, status: "bad", note, fatal: true });

  const local = (url: string): boolean =>
    hostname(url) === "localhost" || hostname(url) === "127.0.0.1";

  const malformed = (url: string): boolean => hostname(url) === null;

  // A local service-to-service URL that names `localhost`: the host binds 127.0.0.1 alone, and
  // the name may resolve to ::1 first, where something else could take the bearer token.
  const v6First = (url: string): boolean => hostname(url) === "localhost";
  const loopbackFix = "localhost may resolve to ::1 first; use 127.0.0.1";

  const orch = forge.get("RYPH_ORCHESTRATOR_URL");
  const orchLabel = "forge ─ RYPH_ORCHESTRATOR_URL → host";
  if (!orch) fatal(orchLabel, "unset — forge cannot boot");
  else if (malformed(orch)) add(orchLabel, "bad", `${orch} — not a valid URL`);
  else if (!local(orch)) add(orchLabel, "bad", `${orch} — points off-machine; host is local`);
  else if (v6First(orch)) add(orchLabel, "bad", `${orch} — ${loopbackFix}`);
  else if (port(orch) === hostPort) add(orchLabel, "ok", `${orch} — host's declared port`);
  else add(orchLabel, "bad", `${orch} — host listens on :${hostPort}`);

  const forgeUrl = host.get("RYPH_FORGE_URL");
  const forgeUrlLabel = "host ─ RYPH_FORGE_URL → forge";
  if (!forgeUrl) add(forgeUrlLabel, "skip", "unset — forge surface dark");
  else if (forgeUrl === "noop") add(forgeUrlLabel, "ok", "noop — recording fake");
  else if (malformed(forgeUrl)) add(forgeUrlLabel, "bad", `${forgeUrl} — not a valid URL`);
  else if (!local(forgeUrl)) {
    add(forgeUrlLabel, "bad", `${forgeUrl} — points off-machine; forge is local`);
  } else if (v6First(forgeUrl)) {
    add(forgeUrlLabel, "bad", `${forgeUrl} — ${loopbackFix}`);
  } else if (port(forgeUrl) === forgePort) {
    add(forgeUrlLabel, "ok", `${forgeUrl} — forge's declared port`);
  } else add(forgeUrlLabel, "bad", `${forgeUrl} — forge listens on :${forgePort}`);

  const gateway = host.get("RYPH_GIT_GATEWAY_URL");
  const gatewayLabel = "runner ─ RYPH_GIT_GATEWAY_URL (host) → forge";
  if (!gateway) {
    add(gatewayLabel, "skip", "unset — runs clone directly");
  } else if (malformed(gateway)) {
    add(gatewayLabel, "bad", `${gateway} — not a valid URL`);
  } else if (port(gateway) !== forgePort) {
    add(gatewayLabel, "bad", `${gateway} — forge listens on :${forgePort}`);
  } else if (docker && local(gateway)) {
    add(
      gatewayLabel,
      "bad",
      `${gateway} — containers cannot dial the host loopback; ${hostFix}`,
    );
  } else add(gatewayLabel, "ok", `${gateway} — container view`);

  const forgeWired = (forgeUrl !== undefined && forgeUrl !== "noop") || gateway !== undefined;
  const hostToken = host.get("RYPH_FORGE_TOKEN");
  const forgeToken = forge.get("RYPH_FORGE_TOKEN");
  const tokenLabel = "host ⇄ forge · RYPH_FORGE_TOKEN";
  if (!forgeWired) add(tokenLabel, "skip", "no forge/gateway URL set");
  else if (!hostToken) add(tokenLabel, "bad", "unset on host but the forge is wired");
  else if (!forgeToken) add(tokenLabel, "bad", "unset on forge");
  else if (hostToken === forgeToken) add(tokenLabel, "ok", "same value on both sides");
  else add(tokenLabel, "bad", "host and forge declare different values");

  // The OPTIONAL second forge, Radicle. The bridge is not a dev-stack
  // unit — it needs a Radicle node beside it on a shared volume, so it is run from
  // `compose --profile radicle` or by hand — but the forge's half of the link IS a .env
  // setting here, and getting it half-right is silent: an unset token means every call the
  // adapter makes comes back 401 with no hint of which side is wrong.
  const radicleUrl = forge.get("RYPH_RADICLE_URL");
  const radicleToken = forge.get("RYPH_RADICLE_TOKEN");
  const radicleLabel = "forge ─ RYPH_RADICLE_URL → radicle bridge";
  if (!radicleUrl) add(radicleLabel, "skip", "unset — no Radicle provider");
  else if (malformed(radicleUrl)) add(radicleLabel, "bad", `${radicleUrl} — not a valid URL`);
  else if (!radicleToken) {
    add(radicleLabel, "bad", `${radicleUrl} — set, but RYPH_RADICLE_TOKEN is not; every call 401s`);
  } else if (port(radicleUrl) !== RADICLE_PORT) {
    add(radicleLabel, "ok", `${radicleUrl} — not the default :${RADICLE_PORT}, but deliberate`);
  } else add(radicleLabel, "ok", `${radicleUrl} — the bridge's declared port`);

  const proxyUrl = host.get("RYPH_MODEL_PROXY_URL");
  const proxyLabel = "runner ─ RYPH_MODEL_PROXY_URL (host) → model proxy";
  if (!proxyUrl) add(proxyLabel, "skip", "unset — model-policy runs fail");
  else if (malformed(proxyUrl)) add(proxyLabel, "bad", `${proxyUrl} — not a valid URL`);
  else if (port(proxyUrl) !== proxyPort) {
    add(proxyLabel, "bad", `${proxyUrl} — data plane listens on :${proxyPort}`);
  } else if (docker && local(proxyUrl)) {
    add(
      proxyLabel,
      "bad",
      `${proxyUrl} — containers cannot dial the host loopback; ${hostFix}`,
    );
  } else add(proxyLabel, "ok", `${proxyUrl} — container view`);

  // The MCP gateway's data plane, the same shape one credential class over. The host defaults
  // it to its own loopback listener, which is right for a hand-started runner and wrong for
  // every containerised one — so unset is only a skip when nothing is containerised.
  const mcpUrl = host.get("RYPH_MCP_GATEWAY_URL");
  const mcpBind = host.get("RYPH_MCP_GATEWAY_HOST") || "127.0.0.1";
  const mcpLabel = "runner ─ RYPH_MCP_GATEWAY_URL (host) → mcp gateway";
  if (!mcpUrl) {
    if (docker) {
      add(
        mcpLabel,
        "bad",
        `unset — defaults to 127.0.0.1:${mcpPort}, which containers cannot dial; ${hostFix}`,
      );
    } else add(mcpLabel, "skip", `unset — the host defaults to http://127.0.0.1:${mcpPort}`);
  } else if (malformed(mcpUrl)) add(mcpLabel, "bad", `${mcpUrl} — not a valid URL`);
  else if (port(mcpUrl) !== mcpPort) {
    add(mcpLabel, "bad", `${mcpUrl} — the gateway data plane listens on :${mcpPort}`);
  } else if (docker && local(mcpUrl)) {
    add(mcpLabel, "bad", `${mcpUrl} — containers cannot dial the host loopback; ${hostFix}`);
  } else if (docker && local(`http://${mcpBind}`)) {
    // Unlike its two siblings this listener binds loopback unless widened, so a container view
    // that resolves is not yet a container view that connects. Checked here rather than left to
    // a refused JSON-RPC call at run boot, which says nothing about which knob is wrong.
    add(
      mcpLabel,
      "bad",
      `${mcpUrl} — but RYPH_MCP_GATEWAY_HOST=${mcpBind} binds loopback; set it to 0.0.0.0`,
    );
  } else add(mcpLabel, "ok", `${mcpUrl} — container view`);

  const publicUrl = host.get("RYPH_PUBLIC_URL");
  const publicLabel = "runner ─ RYPH_PUBLIC_URL (host) → host";
  if (!docker) add(publicLabel, "skip", `provisioner=${provisioner}`);
  else if (!publicUrl) {
    add(publicLabel, "bad", "unset — containerized runners dial localhost and fail");
  } else if (malformed(publicUrl)) {
    add(publicLabel, "bad", `${publicUrl} — not a valid URL`);
  } else if (port(publicUrl) !== hostPort) {
    add(publicLabel, "bad", `${publicUrl} — host listens on :${hostPort}`);
  } else if (local(publicUrl)) {
    add(
      publicLabel,
      "bad",
      `${publicUrl} — containers cannot dial the host loopback; ${hostFix}`,
    );
  } else add(publicLabel, "ok", `${publicUrl} — container view`);

  const apiUrl = app.get("RYPH_API_URL");
  const apiLabel = "app ─ RYPH_API_URL → host";
  if (!apiUrl) {
    if (hostPort === 7411) {
      add(apiLabel, "ok", "unset — default http://127.0.0.1:7411 matches host");
    } else add(apiLabel, "bad", `unset — app defaults to :7411 but host runs on :${hostPort}`);
  } else if (malformed(apiUrl)) {
    add(apiLabel, "bad", `${apiUrl} — not a valid URL`);
  } else if (!local(apiUrl)) {
    add(apiLabel, "bad", `${apiUrl} — points off-machine; host is local`);
  } else if (v6First(apiUrl)) {
    add(apiLabel, "bad", `${apiUrl} — ${loopbackFix}`);
  } else if (port(apiUrl) === hostPort) {
    add(apiLabel, "ok", `${apiUrl} — host's declared port`);
  } else add(apiLabel, "bad", `${apiUrl} — host listens on :${hostPort}`);

  // The host counts x-client-ip only beside this secret, and from anyone when it has none, so a
  // run reaching it through host.docker.internal could pass for ::1. `./dev init` writes one.
  const hostSecret = host.get("RYPH_PROXY_SECRET");
  const appSecret = app.get("RYPH_PROXY_SECRET");
  const secretLabel = "app ⇄ host · RYPH_PROXY_SECRET";
  if (!hostSecret && !appSecret) {
    add(secretLabel, "bad", "unset — the host takes any caller's x-client-ip; ./dev init");
  } else if (!hostSecret) add(secretLabel, "bad", "unset on host; ./dev init");
  else if (!appSecret) add(secretLabel, "bad", "unset on app; ./dev init");
  else if (hostSecret === appSecret) add(secretLabel, "ok", "same value on both sides");
  else add(secretLabel, "bad", "host and app declare different values");

  const ghKey = forge.has("RYPH_GITHUB_PRIVATE_KEY") ||
    forge.has("RYPH_GITHUB_PRIVATE_KEY_PATH");
  const ghParts: [string, boolean][] = [
    ["app id", forge.has("RYPH_GITHUB_APP_ID")],
    ["private key", ghKey],
  ];
  // The OAuth client pair is optional, both or neither: without it nobody signs in through GitHub.
  const ghClient: [string, boolean][] = [
    ["client id", forge.has("RYPH_GITHUB_CLIENT_ID")],
    ["client secret", forge.has("RYPH_GITHUB_CLIENT_SECRET")],
  ];
  const ghSet = [...ghParts, ...ghClient].filter(([, present]) => present);
  const ghLabel = "RYPH_GITHUB_* (forge)";
  if (ghSet.length === 0) add(ghLabel, "skip", "GitHub App not configured");
  else if (ghParts.some(([, p]) => !p) || ghClient[0][1] !== ghClient[1][1]) {
    const partialClient = ghClient[0][1] !== ghClient[1][1];
    const missing = [...ghParts, ...(partialClient ? ghClient : [])]
      .filter(([, p]) => !p).map(([n]) => n).join(", ");
    add(ghLabel, "bad", `partial credentials — missing ${missing}; boot fails`);
  } else if (!ghClient[0][1]) add(ghLabel, "ok", "App set, no OAuth client — no GitHub sign-in");
  else add(ghLabel, "ok", "all four App credentials set");

  // Door ④ is all-or-nothing at boot: a secret without the mailroom's database, or without the
  // App to act back through, exits naming the missing half. The database alone is legal and
  // inert — the mailroom mounts, and no mailbox is rented until a secret arrives.
  const hookSecret = forge.has("RYPH_GITHUB_WEBHOOK_SECRET");
  const hookDb = forge.has("RYPH_FORGE_DB");
  const hookLabel = "RYPH_FORGE_DB + RYPH_GITHUB_WEBHOOK_SECRET (forge)";
  if (!hookSecret && !hookDb) add(hookLabel, "skip", "inbound webhooks not configured");
  else if (!hookDb) {
    add(hookLabel, "bad", "secret set without RYPH_FORGE_DB — boot fails");
  } else if (!hookSecret) {
    add(hookLabel, "skip", "database set, secret unset — mailroom mounts, no mailbox rented");
  } else if (ghParts.some(([, p]) => !p)) {
    add(hookLabel, "bad", "set, but the App above is incomplete — boot fails");
  } else add(hookLabel, "ok", "ingestion at POST /v1/hooks/github, HMAC verified");

  const appClientId = app.get("PUBLIC_GITHUB_CLIENT_ID");
  const forgeClientId = forge.get("RYPH_GITHUB_CLIENT_ID");
  const clientIdLabel = "app ⇄ forge · GITHUB_CLIENT_ID";
  if (!appClientId && !forgeClientId) add(clientIdLabel, "skip", "not configured");
  else if (appClientId === forgeClientId) {
    add(clientIdLabel, "ok", `${appClientId} — same App on both sides`);
  } else {
    add(
      clientIdLabel,
      "bad",
      `app has ${appClientId ?? "(unset)"} but forge has ${forgeClientId ?? "(unset)"}`,
    );
  }

  checks.push(...gitlabChecks(forge, app));

  const secretsKey = host.get("RYPH_SECRETS_KEY");
  const secretsLabel = "RYPH_SECRETS_KEY (host)";
  if (!secretsKey) {
    add(secretsLabel, "skip", "unset — model access, tool access and repo connect dark");
  } else if (/^[0-9a-f]{64}$/i.test(secretsKey)) add(secretsLabel, "ok", "64 hex chars");
  else add(secretsLabel, "bad", "must be 64 hex chars — openssl rand -hex 32");

  // Every provisioner that launches needs the image, and the host refuses to boot without it
  // (packages/host/src/main.ts) — under `manual` nothing is launched from here, so nothing is
  // needed. The one image replaced a per-harness set (RYPH_IMAGE_PI, …); a .env written before
  // that still carries the old names, which the host no longer reads, and the boot failure it
  // gets says nothing about the rename — so this does.
  const imageLabel = "RYPH_AGENT_IMAGE (host)";
  if (docker) {
    const image = host.get("RYPH_AGENT_IMAGE");
    if (image === undefined) {
      const stale = ["RYPH_IMAGE_PI", "RYPH_IMAGE_CLAUDE_CODE", "RYPH_IMAGE_ECHO"]
        .filter((k) => host.has(k));
      fatal(
        imageLabel,
        `provisioner=${provisioner} but no RYPH_AGENT_IMAGE set — boot fails` +
          (stale.length > 0 ? ` (${stale.join(", ")} is the old name for it)` : ""),
      );
    } else add(imageLabel, "ok", image);
  } else add(imageLabel, "skip", `provisioner=${provisioner} launches nothing`);

  // Environment builds. On, the control plane refuses to boot without the two images a build is
  // made of; the builder follows the provisioner, so on the local backend it is docker, which builds
  // with the host's docker and needs no registry.
  const envLabel = "RYPH_ENVIRONMENTS (host)";
  if (host.get("RYPH_ENVIRONMENTS") !== "on") {
    add(envLabel, "skip", "off — every run uses RYPH_AGENT_IMAGE");
  } else {
    const builder = host.get("RYPH_ENV_BUILDER") ?? provisioner;
    // Under docker the host defaults both to the agent image's siblings (host/src/images.ts).
    const missing = builder === "docker"
      ? []
      : ["RYPH_HARNESS_IMAGE", "RYPH_ENV_BASE_IMAGE"].filter((k) => !host.has(k));
    if (missing.length > 0) {
      fatal(envLabel, `on but ${missing.join(" and ")} unset — boot fails`);
    } else if (builder === "kubernetes" && !host.has("RYPH_ENV_REGISTRY")) {
      fatal(envLabel, "on with the kubernetes builder but no RYPH_ENV_REGISTRY — boot fails");
    } else if (
      builder === "kubernetes" && !host.has("RYPH_ENV_BUILD_RUNTIME_CLASS") &&
      !host.has("RYPH_K8S_RUNTIME_CLASS") && host.get("RYPH_ENV_BUILD_ALLOW_UNSANDBOXED") !== "on"
    ) {
      fatal(
        envLabel,
        "on with the kubernetes builder but no runtime class (RYPH_ENV_BUILD_RUNTIME_CLASS or " +
          "RYPH_K8S_RUNTIME_CLASS) — boot fails; RYPH_ENV_BUILD_ALLOW_UNSANDBOXED=on on a laptop " +
          "cluster",
      );
    } else if (builder !== "docker" && builder !== "kubernetes") {
      add(
        envLabel,
        "skip",
        `on, but builder=${builder} builds nothing — set RYPH_ENV_BUILDER=docker`,
      );
    } else {add(
        envLabel,
        "ok",
        `on — ${builder} builder, harness ${
          host.get("RYPH_HARNESS_IMAGE") ?? "the agent image's sibling"
        }`,
      );}
  }

  return checks;
}

/**
 * GitLab's links, as the forge reads them at boot (packages/forge's `readGitlabSettings`): one
 * token, spelled one way; a mode it knows, which in `user` takes none of the bot's doors; the OAuth
 * application whole or not at all; a webhook secret only beside the mailroom's database. Then the
 * app's half of sign-in, which must name the same application on the same instance.
 */
export function gitlabChecks(
  forge: Map<string, string>,
  app: Map<string, string>,
): WiringCheck[] {
  const checks: WiringCheck[] = [];
  const add = (label: string, status: WiringCheck["status"], note: string) =>
    checks.push({ label, status, note });
  const label = "RYPH_GITLAB_* (forge)";
  const set = [...forge.keys()].filter((k) => k.startsWith("RYPH_GITLAB_"));
  const mode = forge.get("RYPH_GITLAB_MODE") ?? "bot";
  const botOnly = [
    "RYPH_GITLAB_WEBHOOK_SECRET",
    "RYPH_GITLAB_CLIENT_ID",
    "RYPH_GITLAB_CLIENT_SECRET",
    "RYPH_GITLAB_GROUP",
  ].filter((k) => forge.has(k));
  const token = forge.has("RYPH_GITLAB_TOKEN");
  const command = forge.has("RYPH_GITLAB_TOKEN_COMMAND");
  const url = (forge.get("RYPH_GITLAB_URL") ?? "https://gitlab.com").replace(/\/+$/, "");
  let configured = false;
  if (set.length === 0) add(label, "skip", "GitLab not configured");
  else if (!token && !command) {
    add(label, "bad", "set without RYPH_GITLAB_TOKEN or RYPH_GITLAB_TOKEN_COMMAND — boot fails");
  } else if (token && command) {
    add(label, "bad", "both RYPH_GITLAB_TOKEN and RYPH_GITLAB_TOKEN_COMMAND — boot fails");
  } else if (mode !== "bot" && mode !== "user") {
    add(label, "bad", `RYPH_GITLAB_MODE=${mode} — bot or user; boot fails`);
  } else if (mode === "user" && botOnly.length > 0) {
    add(label, "bad", `user mode with ${botOnly.join(", ")} — boot fails`);
  } else if (forge.has("RYPH_GITLAB_CLIENT_ID") !== forge.has("RYPH_GITLAB_CLIENT_SECRET")) {
    add(label, "bad", "one of RYPH_GITLAB_CLIENT_ID / _SECRET without the other — boot fails");
  } else if (hostname(url) === null) {
    add(label, "bad", `RYPH_GITLAB_URL=${url} — not a URL; boot fails`);
  } else {
    configured = true;
    add(label, "ok", `${mode} mode at ${url}`);
  }

  // The mailroom is the same one GitHub's deliveries use, so the same database carries it.
  const hookSecret = forge.has("RYPH_GITLAB_WEBHOOK_SECRET");
  const hookLabel = "RYPH_FORGE_DB + RYPH_GITLAB_WEBHOOK_SECRET (forge)";
  if (!hookSecret) {
    if (configured && mode === "bot") {
      add(hookLabel, "skip", "no GitLab webhooks — no /ryph comments, merges polled slowly");
    }
  } else if (!forge.has("RYPH_FORGE_DB")) {
    add(hookLabel, "bad", "secret set without RYPH_FORGE_DB — boot fails");
  } else if (configured) {
    add(
      hookLabel,
      "ok",
      "ingestion at POST /v1/hooks/gitlab?project=<id>&generation=<n>, token per project and generation",
    );
  }

  const appClientId = app.get("PUBLIC_GITLAB_CLIENT_ID");
  const forgeClientId = forge.get("RYPH_GITLAB_CLIENT_ID");
  const clientIdLabel = "app ⇄ forge · GITLAB_CLIENT_ID";
  if (!appClientId && !forgeClientId) {
    if (configured) add(clientIdLabel, "skip", "no GitLab sign-in");
    return checks;
  }
  if (appClientId === forgeClientId) {
    add(clientIdLabel, "ok", `${appClientId} — same application on both sides`);
  } else {
    add(
      clientIdLabel,
      "bad",
      `app has ${appClientId ?? "(unset)"} but forge has ${forgeClientId ?? "(unset)"}`,
    );
  }
  // The browser is sent to the app's instance and the code redeemed at the forge's: two
  // instances, and every sign-in fails at the exchange.
  const appUrl = (app.get("PUBLIC_GITLAB_URL") ?? "https://gitlab.com").replace(/\/+$/, "");
  const urlLabel = "app ⇄ forge · GITLAB_URL";
  if (appUrl === url) add(urlLabel, "ok", `${url} on both sides`);
  else add(urlLabel, "bad", `app sends the browser to ${appUrl} but forge acts on ${url}`);
  return checks;
}

/** Reads a package's declared .env into a map; inline comments stripped, empty values dropped. */
export async function envOf(pkg: string): Promise<Map<string, string>> {
  const vars = new Map<string, string>();
  let text: string;
  try {
    text = await readFile(`${repoRoot}/packages/${pkg}/.env`, "utf8");
  } catch {
    return vars;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const value = m[2].split(/\s+#/)[0].trim().replace(/^["']|["']$/g, "");
    if (value !== "") vars.set(m[1], value);
  }
  return vars;
}

/**
 * The radicle bridge's port. Not in stack.ts's `units` because the bridge is not one — it needs
 * a `radicle-node` beside it sharing RAD_HOME, which is a compose profile's job, not tmux's.
 */
const RADICLE_PORT = 7470;

const int = (v: string | undefined): number | null => {
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) ? n : null;
};

function port(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port !== "") return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
