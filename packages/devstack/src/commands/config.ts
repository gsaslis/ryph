import { envOf } from "../wiring.ts";
import { bold, dim, yellow } from "../ui.ts";

/**
 * Shows each unit's effective configuration, derived from its declared .env plus the services'
 * documented defaults — `ryph env` shows the raw declarations, this applies the resolution
 * rules (defaults, on/off switches) the services apply at boot.
 *
 * Invariants:
 * - Values are derived from files, not observed from processes: a unit restarted less recently
 *   than its .env was edited runs older values than shown here.
 * - The resolution rules mirror the services' documented defaults (.env.example, READMEs);
 *   secret values never appear — only whether they are set.
 */
export async function config(): Promise<number> {
  const host = await envOf("host");
  const forge = await envOf("forge");
  const app = await envOf("app");

  const row = (key: string, value: string) => console.log(`  ${dim(`${key}:`)} ${value}`);

  console.log(bold("host"));
  const hostPort = host.get("RYPH_PORT") ?? "7411";
  const provisioner = host.get("RYPH_PROVISIONER") ?? "manual";
  const db = host.get("RYPH_DB") ?? "ryph.db";
  row("port", hostPort);
  row("provisioner", provisioner);
  row("db", db);
  row(
    "history db",
    host.get("RYPH_HISTORY_DB") ?? (db === "memory" ? "memory" : "ryph-history.db"),
  );
  row("auth", host.get("RYPH_AUTH") === "off" ? yellow("OPEN — RYPH_AUTH=off") : "on");
  row(
    "model proxy",
    host.has("RYPH_SECRETS_KEY")
      ? `on — :${host.get("RYPH_MODEL_PROXY_PORT") ?? "7420"}`
      : yellow("off — no RYPH_SECRETS_KEY"),
  );
  // RYPH_MCP_KEY defaults to the secrets key, so either one switches tool access on.
  row(
    "mcp gateway",
    host.has("RYPH_MCP_KEY") || host.has("RYPH_SECRETS_KEY")
      ? `on — :${host.get("RYPH_MCP_GATEWAY_PORT") ?? "7430"}`
      : yellow("off — no RYPH_MCP_KEY"),
  );
  row("forge", host.get("RYPH_FORGE_URL") ?? yellow("off — no RYPH_FORGE_URL"));
  row("git gateway", host.get("RYPH_GIT_GATEWAY_URL") ?? "off");
  if (provisioner === "docker") {
    row("agent image", host.get("RYPH_AGENT_IMAGE") ?? yellow("none — boot fails"));
  }
  // The builder follows the provisioner unless RYPH_ENV_BUILDER names one; manual builds nothing.
  if (host.get("RYPH_ENVIRONMENTS") === "on") {
    const builder = host.get("RYPH_ENV_BUILDER") ??
      (["docker", "kubernetes"].includes(provisioner) ? provisioner : "manual");
    row("environments", `on — ${builder} builder`);
    // Under docker the host defaults both to the agent image's siblings (host/src/images.ts).
    const unset = builder === "docker" ? "the agent image's sibling" : yellow("none — boot fails");
    row("harness image", host.get("RYPH_HARNESS_IMAGE") ?? unset);
    row("base image", host.get("RYPH_ENV_BASE_IMAGE") ?? unset);
  } else {
    row("environments", "off — every run on the agent image");
  }

  console.log(bold("forge"));
  row("port", forge.get("RYPH_FORGE_PORT") ?? "7412");
  row("orchestrator", forge.get("RYPH_ORCHESTRATOR_URL") ?? yellow("unset — boot fails"));
  row("data root", forge.get("RYPH_FORGE_DATA") ?? "forge-data");
  row(
    "github app",
    forge.has("RYPH_GITHUB_APP_ID")
      ? `${forge.get("RYPH_GITHUB_APP_ID")} — configured`
      : "not configured",
  );
  // GitLab: the instance, the mode, and how the token is found — never the token itself.
  const gitlabMode = forge.get("RYPH_GITLAB_MODE") ?? "bot";
  row(
    "gitlab",
    forge.has("RYPH_GITLAB_TOKEN") || forge.has("RYPH_GITLAB_TOKEN_COMMAND")
      ? `${gitlabMode} at ${forge.get("RYPH_GITLAB_URL") ?? "https://gitlab.com"}${
        forge.has("RYPH_GITLAB_TOKEN_COMMAND") ? " — token from a command" : ""
      }${
        gitlabMode === "bot" && !forge.has("RYPH_GITLAB_WEBHOOK_SECRET")
          ? yellow(" — no webhooks")
          : ""
      }`
      : [...forge.keys()].some((k) => k.startsWith("RYPH_GITLAB_"))
      ? yellow("partial — no token; boot fails")
      : "not configured",
  );
  // The optional second forge. An address without a token is the one state worth calling out:
  // the adapter is registered and every call it makes comes back 401.
  row(
    "radicle",
    forge.has("RYPH_RADICLE_URL")
      ? `${forge.get("RYPH_RADICLE_URL")}${
        forge.has("RYPH_RADICLE_TOKEN") ? "" : yellow(" — no RYPH_RADICLE_TOKEN")
      }`
      : "not configured",
  );

  console.log(bold("app"));
  row("api", app.get("RYPH_API_URL") ?? "http://127.0.0.1:7411 (default)");
  row("github app slug", app.get("PUBLIC_GITHUB_APP_NAME") ?? "unset");
  row(
    "gitlab sign-in",
    app.has("PUBLIC_GITLAB_CLIENT_ID")
      ? `${app.get("PUBLIC_GITLAB_CLIENT_ID")} at ${
        app.get("PUBLIC_GITLAB_URL") ?? "https://gitlab.com"
      }`
      : "unset",
  );
  return 0;
}
