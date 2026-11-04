// `ryph setup`'s GitLab question: which instance, whose account, and how ryph gets its token.
// Split out of setup.ts, which asks it beside GitHub and Radicle under "Repositories".
//
// The binary offers GitLab's user mode alone, as it offers GitHub's: ryph acts as you, with your
// glab login or a pasted personal access token, and merges are polled because nothing reaches a
// laptop's webhooks. Bot mode — a GitLab account of ryph's own — is not offered: connecting a
// project and every write in it need the person's GitLab identity linked, which takes GitLab
// sign-in (an OAuth application) and webhooks this question never sets up. An operator who
// configures all of that by hand (`ryph up --help`) keeps it here.
//
// The settings the forge reads (packages/forge/src/main.ts `readGitlabSettings`):
// RYPH_GITLAB_URL, RYPH_GITLAB_MODE, RYPH_GITLAB_TOKEN | RYPH_GITLAB_TOKEN_COMMAND (exactly one),
// and in bot mode alone RYPH_GITLAB_WEBHOOK_SECRET, RYPH_GITLAB_CLIENT_ID/_SECRET and
// RYPH_GITLAB_GROUP — each of which fails a user-mode boot, so switching to user mode clears
// them, after a confirmation that names them.

import type { Prompter } from "./prompt.ts";
import type { SetupContext } from "./setup.ts";

/** gitlab.com, the instance offered when none is configured. */
export const GITLAB_DOT_COM = "https://gitlab.com";

/** The scopes ryph's token needs, for the forge's boot check and the link that pre-ticks them. */
export const GITLAB_SCOPES = ["api", "read_repository", "write_repository"];

/** The settings only a bot-mode GitLab takes: a user-mode forge refuses to start beside any. */
export const GITLAB_BOT_KEYS = [
  "RYPH_GITLAB_WEBHOOK_SECRET",
  "RYPH_GITLAB_CLIENT_ID",
  "RYPH_GITLAB_CLIENT_SECRET",
  "RYPH_GITLAB_GROUP",
];

/**
 * An instance URL as the forge takes it — an http(s) origin plus any path prefix, no trailing
 * slash — or null for anything else: credentials, a query or a fragment are refused, as
 * `gitlabUrlOf` refuses them at boot. A bare host is read as https.
 */
export function gitlabInstanceUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Where a person creates the token, with ryph's name and scopes filled in. GitLab 17.0+ (the
 * minimum) serves personal access tokens under /-/user_settings. */
export function personalAccessTokenUrl(instance: string): string {
  return `${instance}/-/user_settings/personal_access_tokens?name=ryph&scopes=${
    GITLAB_SCOPES.join(",")
  }`;
}

/**
 * The commands that print glab's token for the instance at `instance` (`gitlabInstanceUrl`'s
 * form), in the order they are tried. glab's own git credential helper, asked for the
 * instance's host, with its `password=` line kept: for an OAuth login (`glab auth login` through
 * the browser, whose access token lives two hours) it renews an expired token with the refresh
 * token and saves the rotated pair, as every glab command does; for a personal access token it
 * prints that token. `glab config get token` would not do: it reads the stored access token as
 * it is, so an OAuth login dies two hours in and the forge's retry after a 401 reads the same
 * dead token again. Read from glab's source (internal/commands/auth/login/helper.go, present in
 * 1.123.0), which has no `glab auth token`. A host glab has no login for prints nothing. The
 * scheme and host are checked to `http`/`https` and a hostname (and port) before they reach a
 * shell.
 */
export function glabTokenCommands(instance: string): string[] {
  let url: URL;
  try {
    url = new URL(instance);
  } catch {
    return [];
  }
  const scheme = url.protocol.slice(0, -1);
  if (scheme !== "https" && scheme !== "http") return [];
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(url.host)) return [];
  return [
    `printf 'protocol=${scheme}\\nhost=${url.host}\\n\\n' | glab auth git-credential get ` +
    "| sed -n 's/^password=//p'",
  ];
}

/**
 * The glab command that prints a token for the instance here, or null when none does: no glab
 * on PATH, or no login for that host. `probe` runs one command, bounded (setup.ts
 * `githubCliSignedIn`, which is not GitHub's alone: it runs any command the forge would run,
 * through the same shell).
 */
export async function glabTokenCommand(
  instance: string,
  probe: (command: string) => Promise<boolean>,
): Promise<string | null> {
  for (const command of glabTokenCommands(instance)) {
    if (await probe(command)) return command;
  }
  return null;
}

type GitlabChoice = "keep" | "user" | "skip" | "off";

/**
 * How ryph acts on GitLab. True when GitLab is configured afterwards.
 *
 * As you, on the instance you name, through glab's login when it has one for that host (nothing
 * stored: the forge runs the command at boot and again when GitLab turns the token away) or a
 * pasted token. Merges are polled; no webhooks. A bot configured by hand can be kept.
 *
 * The two token settings are exclusive — the forge refuses to start with both — so each answer
 * clears the other. Switching to user mode (or off) removes the bot-only settings, after a
 * confirmation that names them and defaults to no: the secrets are not written down elsewhere.
 */
export async function askGitlab(
  io: Prompter,
  ctx: SetupContext,
  config: Map<string, string | null>,
  notes: string[],
): Promise<boolean> {
  const currentCommand = ctx.current.get("RYPH_GITLAB_TOKEN_COMMAND") ?? null;
  const currentToken = ctx.current.get("RYPH_GITLAB_TOKEN") ?? null;
  const currentUrl = ctx.current.get("RYPH_GITLAB_URL") ?? null;
  const currentMode = ctx.current.get("RYPH_GITLAB_MODE") === "user" ? "user" : "bot";
  const configured = currentCommand !== null || currentToken !== null;
  const botSet = GITLAB_BOT_KEYS.filter((key) => ctx.current.has(key));

  io.say();
  io.say(
    "Ryph works on GitLab — gitlab.com or your own instance — as you: it opens merge " +
      "requests and comments under your name.",
  );
  const where = gitlabInstanceUrl(currentUrl ?? GITLAB_DOT_COM) ?? currentUrl ?? GITLAB_DOT_COM;
  const choices: { label: string; hint: string; value: GitlabChoice }[] = [
    ...(configured
      ? [{
        label: "keep the current GitLab login",
        hint: `${currentMode === "user" ? "as you" : "as a bot"} on ${where} · ${
          currentCommand ?? "a pasted token"
        }`,
        value: "keep" as const,
      }]
      : []),
    {
      label: "act as you",
      hint: "your glab login or a token of yours; merges are polled, no webhooks",
      value: "user",
    },
    configured || botSet.length > 0
      ? { label: "turn GitLab off", hint: "remove the GitLab settings", value: "off" }
      : { label: "skip", hint: "set it up later", value: "skip" },
  ];
  const choice = await io.select("GitLab", choices, configured ? 0 : choices.length - 1, {
    id: "gitlab",
  });

  if (choice === "keep") return true;
  if (choice === "skip") return false;

  // Bot-only settings go with user mode and with off, asked first, by name, and Enter is no.
  const dropsBot = (choice === "user" || choice === "off") && botSet.length > 0;
  if (dropsBot) {
    const remove = await io.confirm(
      `This removes the GitLab bot settings (${botSet.join(", ")}): ryph acting as you on ` +
        "GitLab takes no webhooks, sign-in or group. Remove them?",
      false,
      { id: "remove-gitlab-bot" },
    );
    if (!remove) {
      notes.push("kept the GitLab bot settings: nothing about GitLab was changed.");
      return configured;
    }
  }
  const dropBot = () => {
    if (!dropsBot) return;
    for (const key of botSet) config.set(key, null);
    notes.push(
      `removed the GitLab bot settings (${botSet.join(", ")}): ryph acting as you on GitLab ` +
        "takes no webhooks, sign-in or group.",
    );
  };
  if (choice === "off") {
    dropBot();
    for (
      const key of [
        "RYPH_GITLAB_URL",
        "RYPH_GITLAB_MODE",
        "RYPH_GITLAB_TOKEN",
        "RYPH_GITLAB_TOKEN_COMMAND",
      ]
    ) {
      config.set(key, null);
    }
    return false;
  }

  const answer = await io.ask("GitLab instance URL", {
    id: "gitlab-url",
    default: where,
    validate: (value) =>
      gitlabInstanceUrl(value) === null
        ? "an http(s) URL with no user, query or fragment, such as https://gitlab.example.com"
        : null,
  });
  const instance = gitlabInstanceUrl(answer)!;
  const host = new URL(instance).host;

  let command: string | null = null;
  const glab = ctx.gitlabCli ? await ctx.gitlabCli(instance) : null;
  if (glab === null) {
    io.say(
      `To use your glab login, sign in with \`glab auth login --hostname ${host}\` and run ` +
        "`ryph setup` again.",
    );
  } else {
    const how = await io.select(
      "GitLab token",
      [
        {
          label: "use your glab login",
          hint: "nothing is stored; ryph asks `glab` for the token, which glab keeps renewed",
          value: "cli" as const,
        },
        { label: "paste a token", hint: "a personal access token of yours", value: "paste" },
      ],
      0,
      { id: "gitlab-login" },
    );
    if (how === "cli") command = glab;
  }

  let token: string | null = null;
  if (command === null) {
    io.say("Create a token at:");
    io.say(`  ${personalAccessTokenUrl(instance)}`);
    io.say(`with the scopes ${GITLAB_SCOPES.join(", ")}.`);
    token = (await io.secret("token (not echoed)", { id: "gitlab-token" })).trim();
    if (!token) {
      notes.push(
        configured
          ? "no token entered — the GitLab settings were not changed."
          : "no token entered — GitLab stays unreachable.",
      );
      return configured;
    }
  }

  dropBot();
  config.set("RYPH_GITLAB_URL", instance === GITLAB_DOT_COM ? null : instance);
  config.set("RYPH_GITLAB_MODE", choice);
  config.set("RYPH_GITLAB_TOKEN_COMMAND", command);
  config.set("RYPH_GITLAB_TOKEN", token);

  // A pushed merge request branch runs the project's pipeline, an agent's edit to it included:
  // GitLab's version of GitHub's workflow caveat, said where the token is chosen.
  io.say(
    "A branch ryph pushes runs the project's .gitlab-ci.yml, including an agent's change to it, " +
      "with the project's unprotected CI/CD variables. Protect the variables a merge request " +
      "should not see.",
  );
  io.say("Connect projects in the web UI, under Repos → Connect repository → GitLab.");
  return true;
}
