# Setting up ryph with a coding agent

This file is written for a coding agent: Claude Code, Codex, Cursor or any other that can run shell
commands on the person's machine. If you are that agent, the person has asked you to set ryph up for
them. Read all of it before the first command.

If you are the person: tell your agent "read
https://raw.githubusercontent.com/ryph-hq/ryph/main/docs/guides/setup-with-an-agent.md and set me
up", then stay nearby. Two steps need a browser and your hands; the agent will say when.

## What you are setting up

ryph is a self-hosted platform that runs coding agents in containers: a task, an alert or a chat
mention starts a run, the run works a repository, and its work lands as a pull request. You are
installing the single `ryph` binary on this machine, answering its setup questions without a
terminal wizard, starting it, and handing the person the two steps only they can do. You end with a
deployment that has run one task, and with your own MCP connection to it so you can keep going with
[the incident-response checklist](incident-response.md#fit-it-into-your-operational-context) if they
want that.

Nothing here needs a checkout of the ryph repository. Every path is absolute; every URL is public.

## What you must never do

- **Never write a model provider key anywhere.** Not into `~/.ryph/config.env`, not into a tool
  call, not into chat. There is no API for it; the person pastes it in the browser, where it stays
  session-only. If they offer you one, decline and point them at the step below.
- **Never run `ryph setup` without `--yes`.** Without it, setup is an interactive wizard that fails
  with no terminal. The flags cover everything it would ask.
- **Never pass `--key paste` or `--key-value` with a key you made up.** `--key mint` on a fresh
  install; `--key keep` after that. Replacing a stored key makes every provider key sealed under the
  old one unreadable.
- **Never choose `--egress direct` unless the person said "direct" in this session.** The default is
  `allowlisted`; `confined` is stronger and is offered where the engine can do it.
- **Never put a forge token on a command line.** Pipe it:
  `printf '%s' "$TOKEN" | ryph setup --yes
  --github-token - …`, or use `--github cli` when
  `gh auth status` succeeds.
- **Never ask for, accept or use an API token that holds `patches:review` or `egress:manage`.**
  Approving a patch publishes it to the forge; that stays the person's act. If `whoami` shows
  either, stop and ask them to revoke that token and mint another.
- **Never edit `~/.ryph/config.env` by hand.** `ryph setup --yes` writes it and `ryph config` reads
  it. Never touch a key in it ending in `_KEY`, `_TOKEN` or `_SECRET`.
- **Never print a secret back more than once.** The master key path and the login link are shown to
  the person once each.
- **Never run `ryph restore`, `sudo`, or `curl … | sh` without the person's explicit yes**, said in
  this session.

Every command below is safe to run again. `ryph setup --yes` keeps an existing master key by default
and rewrites only the settings its flags name.

## The steps

Each step says who acts, what to do, what tells you it worked, and when to stop and ask.

### 1. Preconditions (you)

```sh
uname -sm
docker version --format '{{.Server.Version}}'
command -v git && command -v curl
command -v gh && gh auth status        # optional; enables --github cli
echo "$PATH" | tr ':' '\n' | grep -c "$HOME/.local/bin"
```

Worked when: macOS or Linux on arm64 or x86_64, and docker prints a server version. Docker 28 or
later allows confined runs; Podman cannot confine. Alpine and other musl systems are refused.

Stop and ask if docker is missing or the daemon does not answer: the person installs Docker Desktop
(macOS) or Docker Engine 28 or later (Linux) and starts it. Setup refuses to run until docker
answers, and on a native Linux engine ryph must be started after docker. Do not install docker
yourself.

### 2. Install (you, after an explicit yes)

```sh
curl -fsSL https://ryph.ai/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"   # if the installer said the directory is not on PATH
ryph version
```

Worked when: the installer prints "Ryph is installed" and `ryph version` prints a version (`0.1.0`,
or `sha-…` for an edge build). The installer checks a signed checksum and aborts on a mismatch; that
is not yours to work around.

### 3. Ask the setup questions (you ask, they answer)

One message, four questions:

1. **Internet for runs**: `allowlisted` (default; setup steps may install from the allowlist, and a
   run's own code is not hard-bounded), `confined` (no internet except through ryph's egress proxy;
   needs docker 28), or `direct`. Recommend `allowlisted`, offer `confined`.
2. **Where the code is**: a directory on this machine (`--repo-root <dir>`), GitHub as them
   (`--github cli` with a `gh` login, or a fine-grained token with Contents, Pull requests and
   Issues read/write, Metadata read, and **no** Workflows permission), GitLab (`--gitlab-url` and
   `--gitlab-login cli` or a pasted token), Radicle (`--radicle on`, only if `rad self` answers), or
   skip for now (`--repos skip`).
3. **A browser for agents**: yes (default) or `--browser-image off` to save disk.
4. **One user** (default) or several. Several means `RYPH_MULTIUSER=on` and mail questions; leave
   that for the person to decide later unless they ask.

### 4. Run setup without the wizard (you)

Compose one command from the answers. Examples:

```sh
# local repos, GitHub through the gh login, allowlisted egress
ryph setup --yes --egress allowlisted --repo-root ~/Code --github cli

# a GitHub token, from stdin, no local repos
printf '%s' "$GITHUB_TOKEN" | ryph setup --yes --egress allowlisted --repos skip --github-token -

# GitLab through glab
ryph setup --yes --egress allowlisted --gitlab-url https://git.example.com --gitlab-login cli
```

`ryph setup --help` lists every flag. A flag for a question setup did not need to ask prints a line
saying it did nothing; that is fine. On a released binary the agent image is pinned and not asked
about.

Worked when: exit code 0, and `ryph config` shows `RYPH_PROVISIONER=docker`, `RYPH_EGRESS`, and the
repository settings you chose, each with the layer that decided it ("settings file").

Stop and ask on exit code 1: nothing was written, and the message names the cause (no docker, a `gh`
login that is not there, confinement the engine cannot do). Fix the cause with the person. Never
retry with `--egress direct` to make it pass.

### 5. Start it (you)

```sh
ryph up --no-input 2> "$HOME/.ryph/up.log" &
sleep 8
cat "$HOME/.ryph/up.log"
```

The status block goes to stderr. Worked when it shows:

- `agent runner` as `docker · quay.io/ryph/ryph-agent:sha-…`
- `model access` and `tool access` as URLs, not `off — no RYPH_SECRETS_KEY`
- `repositories` as something other than `none configured`
- `web UI` as `http://localhost:3000` (or the port `RYPH_APP_PORT` names)

and `curl -fsS -o /dev/null http://localhost:3000/login` succeeds. On a first launch the block also
says it minted the master key at `~/.ryph/secrets.key` and to back it up: tell the person that,
once.

Stop and ask if `up` exits at once: a provisioner refusal means step 4 did not land (run it again);
a port in use means choosing `RYPH_APP_PORT` or `RYPH_PORT` with the person. For a server that
should keep running, draft a systemd unit with `ExecStart=… ryph up --no-input`,
`After=docker.service` and `Environment=RYPH_HOME=…`, and let the person install it.

### 6. Images (you, read-only)

ryph downloads its six images in the background, the agent image first; it is several gigabytes.

```sh
docker image ls 'quay.io/ryph/*'
```

Tell the person a first run waits until the agent image is present. Do not pull them yourself.

### 7. Sign in, model key, first agent, API token (the person)

```sh
ryph login --no-open
```

prints a single-use sign-in link on stdout. Give it to the person with this list:

1. Open the link. The welcome flow has five steps: **Model** (paste a provider key, or connect a
   ChatGPT plan), **Agent** (keep the suggested name, Ada), **Background model** (the one memory
   uses), **Repository** (connect one), **Ready**.
2. On the account page, under API tokens, mint a token named `setup-agent` holding exactly:
   `tasks:create tasks:read tasks:steer agents:read agents:write repos:read repos:connect
   repos:manage workspaces:read workspaces:manage automations:manage chat:read chat:write
   chat:manage tools:read tools:manage memory:read memory:manage skills:read skills:manage`.
   Not `patches:review`, not `egress:manage`, not `resources:manage`.
3. Paste the token to you, or write these two lines into `~/.ryph/config.env` themselves:
   `RYPH_URL=http://localhost:3000` and `RYPH_TOKEN=ryph_pat_…`.

Wait. There is nothing for you to do until they are done.

### 8. Connect yourself to the deployment (you)

```sh
claude mcp add ryph -e RYPH_URL=http://localhost:3000 -e RYPH_TOKEN=ryph_pat_… -- ryph mcp
# or, with both in ~/.ryph/config.env:
claude mcp add ryph -- ryph mcp
```

Other clients: a stdio MCP server whose command is `ryph` with the argument `mcp`, and the same two
environment variables. Then call `whoami`.

Worked when: `whoami` names the deployment, says the token speaks for the person, and lists the
tools the token reaches. Stop if `patches:review` is among its capabilities. Then
`deployment {action: "images"}` reports every image present, `agents {action: "list"}` shows Ada,
and `repos {action: "list"}` shows the connected repository and its submission policy.

### 9. One task, end to end (you)

```
task_start {agentId: <Ada>, repoId: <repo>, title: "Smoke test",
            instructions: "Say hello, list the top-level files, and finish. Change nothing."}
run_wait   {taskId: <id>, until: "settled"}
```

Worked when: the run ends `succeeded` and `run_transcript` shows the agent's hello. A first run on a
repo also builds that repo's environment image; `environments {action: "list"}` shows it.

Stop and ask if the run is lost or fails: `run_activity` says why. The usual causes are an agent
image still downloading, a docker VM that went to sleep, or an allowlisted host a setup step needed.

### 10. Report (you)

Tell the person, in a short list: where the settings live (`~/.ryph/config.env`) and how to read
them (`ryph config`); that `~/.ryph/secrets.key` needs a backup; which API token exists and what it
holds; that `ryph backup <file>` works only while ryph is stopped; and that the next step, if they
want alerts handled, is the
[incident-response checklist](incident-response.md#fit-it-into-your-operational-context). Ask them
to revoke `setup-agent` when they no longer want you connected.

<!-- The status block's lines are quoted from packages/ryph/src/main.ts (describeDeployment);
     re-check them there when they change. The flags are packages/ryph/src/setup.ts (SETUP_FLAGS),
     the welcome steps packages/app/src/routes/(flows)/welcome/welcome.ts, and the capability
     names packages/auth/src/core/capabilities.ts. -->
