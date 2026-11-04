# 🤖 Supported harnesses

A harness is the pluggable coding agent behind the `Harness` port (`src/ports/harness.ts`):
the runner hands it a task and an isolated checkout, and it drives a coding-agent CLI to completion,
normalizing whatever that CLI emits into `TranscriptChunk`s and a final `HarnessOutcome`.
The port's invariants (checkout-only writes, coherent aborts, throw-only-for-breakage) are described
in the port itself; this file documents how each shipped adapter maps its CLI onto that contract.

A work item selects its harness by `kind`:

| kind   | adapter                        | what it is                                                                                                                                                     |
| ------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `echo` | `src/adapters/harness/echo.ts` | A reference implementation that fakes an agent — writes a notes file, narrates, notes the brief and the tools it was offered, ends the run through the loopback's `finish` like an agent does, and answers any message that reaches it first. Exercises the full run path without a CLI or a token spent. |
| `pi`   | `src/adapters/harness/pi.ts`   | [Pi](https://pi.dev), a real coding agent, driven over its RPC protocol.                                                                                       |

## 🥧 Pi (`kind: "pi"`)

[Pi](https://pi.dev) is an open-source coding agent: an LLM wired into a terminal loop with
file-editing and command-running tools. It is provider-agnostic (which LLM backend it talks to is
chosen per run) and customizable at both the user and the project level — config, extensions,
skills, prompt templates, themes. Humans normally drive it as an interactive TUI; it also offers
programmatic modes, and that is what this adapter speaks. The runner treats pi as a black box that
takes a prompt and works the checkout; the rest of this section is how that box is configured,
driven, and interpreted.

Pi is installed separately (npm `@earendil-works/pi-coding-agent`), in the harness layer at
`/opt/ryph/lib/pi` on its own Node, and spawned through the layer's wrapper by absolute path,
`/opt/ryph/bin/pi` — never looked up on `PATH`, which belongs to the repo's environment
([images/harness](../../../images/harness/Dockerfile)); `RUNNER_PI_BIN` points a checkout at
another. Provider credentials (e.g. `ANTHROPIC_API_KEY`) travel via the environment only —
never in the work item, never on argv.

### 🛰️ Routing through the model proxy

When an agent has a model policy, its runs never hold a real provider key: the runner's boot-time
credentials fetch populates the environment with a run-scoped virtual key plus the model-proxy
address — in the provider's conventional env vars for a built-in (`ANTHROPIC_API_KEY`,
`ANTHROPIC_BASE_URL`), and in the platform's own for an admin-registered custom endpoint
(`RYPH_MODEL_API_KEY`, `RYPH_MODEL_BASE_URL`, plus a `RYPH_MODEL_PROVIDER_CONFIG` blob naming the
slug, its dialect and every model it declares). pi, though, honors only a key var — it has **no
`ANTHROPIC_BASE_URL`**; a non-default endpoint goes through its config file. So the adapter
translates: when a base-URL env is present, it writes a throwaway `models.json` and points pi at
it via `PI_CODING_AGENT_DIR` (a temp dir, so a developer's real `~/.pi` is never touched).

What that file says depends on whether pi has ever heard of the provider. One rule spans both
cases, and it is pi's, not ours: a provider's `apiKey` is read as a shell command when it starts
with `!`, as an **environment variable when a variable of that name is set**, and otherwise as the
literal key (pi's `docs/models.md`, "Value Resolution" — checked against 0.67.6, while the image
pins `@earendil-works/pi-coding-agent@1.5.0`, so read it as indicative rather than as the pinned
build's contract). A bare name is therefore never a secret in a file, which is the whole reason the
adapter can write one at all.

**A built-in** (`anthropic`, `openai`) is overridden **by its own name**:

- pi merges the entry onto its own, so only the endpoint is swapped and the model catalog
  survives — no model needs enumerating.
- The override sets **no `apiKey`**, because for a provider pi knows there is nothing to say: it
  already resolves that provider's key from its own env convention, reading the virtual key out of
  `ANTHROPIC_API_KEY` itself. Naming the variable would be writing down what pi does anyway, and
  omitting it keeps the secret out of the file — the same environment-only rule the run already
  follows.
- The dialect is read off **which base-URL var is set** (`ANTHROPIC_BASE_URL` ⇒
  `anthropic-messages`, `OPENAI_BASE_URL` ⇒ `openai-responses`), so no provider→dialect table
  lives in the adapter to drift from the platform's own.
- OpenAI is driven over the **Responses API**. pi's own openai catalogue already says
  `openai-responses` for every model, and an override without `models` keeps each model's own
  `api` — so the entry's `api` is the record, not the switch. pi posts `<baseUrl>/responses` (the
  proxy's `/v1/responses`) with `store: false` and, when a thinking level is set,
  `include: ["reasoning.encrypted_content"]`, replaying the encrypted reasoning items on the next
  turn; the proxy forwards all of it verbatim and meters the terminal `response.completed` /
  `.incomplete` / `.failed` event.
- pi omits the fields a ChatGPT sign-in refuses (`max_output_tokens`, `temperature`,
  `prompt_cache_retention`) only when `baseUrl` is exactly `https://api.openai.com/v1` and the
  key is not an `sk-` one. A proxied run's `baseUrl` is the proxy, so pi always sends them; a
  ChatGPT plan key has them stripped at the proxy instead.
- pi posts to `<baseUrl>/v1/messages`, so `baseUrl` is the proxy root. The path is the one thing
  the proxy does not forward verbatim: it strips the provider's `clientBasePath` — empty for
  `anthropic`, `/v1` for `openai` and for every custom endpoint — and appends what is left to the
  upstream's own base URL, path included
  ([forwarding](../../model-proxy/docs/architecture.md)). For a built-in that lands exactly where
  the old verbatim rule did; for an endpoint whose real address is `…/accounts/X/ai/v1` it is the
  difference between working and posting at a domain root.

**A custom endpoint** — an OpenAI-compatible upstream an admin registered — gets a **complete**
entry instead, because pi has no catalogue to merge onto and no env convention for a name it has
never seen:

- `baseUrl` is `RYPH_MODEL_BASE_URL` (the proxy's `/v1`; the upstream's own base URL is the
  proxy's business and never reaches the run), `api` is the blob's dialect, and `models` is the
  admin's declared list translated into pi's shape — `label` → `name`, `maxOutputTokens` →
  `maxTokens`, `price` → `cost` (USD per million either way), `vision: true` →
  `input: ["text", "image"]`, and `compat` verbatim. A field the admin left unset is **omitted**,
  so pi's own default applies rather than a zero invented a layer away.
- `apiKey` **is** present here, as a reference to the env var: `$RYPH_MODEL_API_KEY`. There is
  no convention to fall back on, so unless the file names the variable nothing resolves the key
  at all. It must carry the `$`: pi reads a bare string as the key itself and expands only
  `$NAME` or `${NAME}`. The invariant holds: no secret in the config file, none in argv.
- That key var is brand-scoped, so the child-env scrub (`runChildEnv`) takes it out of every
  child. The adapter reads it back and puts it into **pi's spawn env alone** — the same move the
  MCP token gets, and one notch tighter than a built-in's `ANTHROPIC_API_KEY`, which a repo's
  setup steps do hold.
- Anything broken in the blob — unparseable JSON, a dialect pi does not speak, no declared models,
  a slug that is not the one argv names — **refuses the run before pi spawns**, naming the
  variable. The quiet alternative is the worst outcome available: pi would keep a built-in
  endpoint, the run would install its dependencies fine, and it would die at its first model call
  with `fetch failed`.

The `api` dialect names (`anthropic-messages`, `openai-responses`, `openai-completions`) are pi's
own vocabulary, and the platform spells its dialects the same way on purpose, so the value is
written straight through. Absent any base-URL env (direct key delivery, or an agent with no model access), no
`models.json` is written and pi stays on its built-in endpoints.

### 🧩 Tools through the MCP gateway

pi has no MCP client; MCP reaches it through **extensions**, which the adapter switches off
wholesale (`--no-extensions`) because the checkout is untrusted. When the run has tools — the
agent has a tool policy, so the boot-time credentials fetch answered an `mcp` half and the
composition root handed the harness `tools: { servers, tokenEnv }` — the adapter loads exactly
one extension back in: the ryph-owned [`@ryph/pi-mcp`](../../pi-mcp/README.md), by explicit
path (`-e /opt/ryph/pi-mcp/index.ts`, where the harness layer bakes it; `opts.mcpExtension`
relocates it for a checkout). `-e` is not trust-gated, which is exactly why that path is the
image's and never the checkout's — and it is not acknowledged either, so the extension prints a
`ryph pi-mcp: ready — …` line once its tools are registered and the adapter warns
(`pi.mcp_extension.silent`) when a run it gave tools to never printed one. That is also why pi is
pinned in the image: a pi that stopped honouring `-e` alongside `--no-extensions` would start
normally and run with no tools at all.

Every run, tools or not, also loads the ryph **images extension** — `images.ts`, the file beside
the MCP one (`/opt/ryph/pi-mcp/images.ts`, relocated with it). Images stay in pi's history once in
— inline ones, and every image the agent reads or a tool returns — and every later request
carries them all, which past 32 MB or 100 images is a request the provider refuses, again on every
retry. The extension hooks pi's `context` event (before each model call, on a copy of the
conversation used for that call alone) and keeps the newest images within 16 MiB of base64 and
20 images, putting a short line in place of each older one that says how to see it again. That
line falls only on block boundaries, so it moves rarely and the provider's prompt cache survives
most requests. It prints `ryph pi-images: ready — …` once loaded, and the adapter warns
(`pi.images_extension.silent`) when a run never printed it. The adapter's own rule is only per
prompt: a message's images go inline when pi is idle and they fit that budget together, each
counted at what pi's resize can make of it (`resizedChars`: its own base64 when pi sends it as it
is, pi's 4.5 MiB ceiling when pi would re-encode it or its header gave no dimensions); otherwise
they go as files to open with the read tool.

The extension reads one file the adapter writes into the same throwaway config dir as
`models.json`: `mcp.json`, one entry per server in scope, dialing the gateway's per-run URL with
the token as an **env reference** — `"Authorization": "Bearer ${MCP_GATEWAY_TOKEN}"`. The same
move as `models.json`'s key handling — omitted for a built-in, a bare env var name for a custom
endpoint: the file holds no secret, and neither does argv, a log line, or an error message. The
token itself travels one step tighter than the model key. The composition root parks it in the
runner's environment under a brand-scoped name
(`RYPH_MCP_TOKEN`), which the scrub removes from every child — so a repo's `setup.yml` steps
never see it — and the adapter alone reads it back and adds it to **pi's spawn env only**, as
`MCP_GATEWAY_TOKEN`. A run with tools whose parked token is missing is refused before anything
spawns, naming the variable. A server URL carrying userinfo is refused at ingest. A plaintext
`http` one is accepted without remark: every deployment points runs at an in-cluster or in-network
gateway, where the network policy, not TLS, protects the hop.

The containment that buys, stated exactly: **repo-authored setup steps and the runner's own
children never hold the token** — the scrub keeps it out of `setup.yml` steps, and the runner's
git subprocesses take a built environment, so not even a checkout-planted git hook reads it.
**The agent does hold it**, because it is pi's environment and pi passes that to every subprocess
its shell tool spawns; prompt injection can read it and send it on. Accepted, not overlooked: an
exfiltrated virtual token is run-scoped, allowlist-bounded, metered, and revoked when the run
concludes ([the gateway's README](../../mcp-gateway/README.md)).

Inside pi, each server's tools appear as `<slug>__<tool>` (`linear__create_issue`), so two
servers exposing the same name cannot shadow each other; the gateway sees the tool's own name.
A name that would not be provider-safe (a refused character, or over 64 characters) is rewritten
with a hash of the slug and the tool's own name, so no listed tool is dropped and none collide;
a name a server lists twice is fatal, never a tool quietly missing from the model's view.
What the model can see and call is whatever the gateway's filtered `tools/list` answered — the
allowlist is enforced there, not here. A harness without an MCP client (`echo`) ignores `tools`,
but for the one call it makes to the loopback's `finish`.
A future harness translates the same input into its own config (Claude Code: `--mcp-config` with
`${VAR}` headers; Codex: `bearer_token_env_var`); the gateway never learns which harness is dialing.

### 📦 Harness spec shape

The work item's `harness` field (`HarnessSpec` in `src/core/types.ts`):

```json
{
  "kind": "pi",
  "provider": "anthropic",
  "model": "claude-sonnet-5",
  "thinking": "high"
}
```

Beyond `kind`, a pi harness spec carries three optional fields, each a single-line string forwarded
verbatim as the matching pi flag; an omitted field falls back to pi's own default. A value starting
with `-` is refused at ingest — it rides pi's argv, where a leading dash reads as a flag:

- `provider` (`--provider`) — the LLM backend pi talks to (`anthropic`, `openai`, …).
- `model` (`--model`) — the model to use within that provider.
- `thinking` (`--thinking`) — how much reasoning effort the model spends before acting.

Bad values (an unknown model, a bogus thinking level) are pi's to refuse, which surfaces as a run
error, not an agent failure.

### 📡 RPC mode, not JSON mode

In its programmatic modes, pi reports everything it does as a JSONL event stream on stdout —
one JSON object per line, each describing a step of the run (the agent started, a message
finished, a tool ran, the agent settled). There are two such modes, differing in how the prompt
goes in: JSON mode (`pi --mode json "<prompt>"`) takes it on the command line and runs to
completion with no further input channel; RPC (`pi --mode rpc`) reads JSONL commands on stdin.
The adapter drives **RPC mode**, for one decisive reason and two lesser ones:

- **Coherent aborts.** The port requires "on signal abort, stop as soon as coherent".
  In JSON mode the only abort lever is killing the process — pi could die mid-edit and the
  final summary-bearing event is lost. RPC has a first-class `{"type":"abort"}` command:
  pi finishes its current action, emits the aborted final message, then settles.
  The adapter kills the process only if pi hasn't settled ~15s after the abort command.
- The prompt travels over stdin, so instructions near the schema's 100k-char ceiling
  never risk OS argv limits.
- The final assistant message (the run summary) survives an interruption.

The RPC surface used is deliberately minimal: one task `prompt`, any number of message prompts,
at most one `abort`, and a read loop that keeps reading past `agent_settled` — pi's "fully done,
nothing more is coming" event — through `io.conversation`: every settle is reported to the core, and every message from the run's inbox goes up as one more
`prompt` with `streamingBehavior: "steer"`. That one command carries pi's own two semantics — a
steer while pi is working (delivered after the current tool call, before the next model call),
an ordinary new turn once it has settled — which is why it is used rather than the bare `steer`
and `follow_up` commands: sent to an idle pi those only queue, until a prompt nobody would send.
Steers queued while a tool runs are handed over together once it returns: the adapter writes
`steeringMode: "all"` into `settings.json` (below), because pi's default, one-at-a-time, delivers
them one per assistant turn — which live read as the rest never having arrived.
The read loop then ends when the core says the run is over (`done`, at a settle): stdin closes,
pi exits. An abort that finds pi settled closes stdin too, since no turn is left for it to end.
The harness's summary is the last message's text, or the one before it when the last has none;
the agent's own summary, given through its outcome tools, wins over it. Session commands stay
unused.

### 🚀 Invocation

Pi is spawned with `cwd = checkoutDir`, inheriting the runner's environment, with fixed flags:

```
pi --mode rpc --no-session -na \
   --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline \
   [--skill <skills dir>/<origin>/<name>/SKILL.md …] \
   -e /opt/ryph/pi-mcp/images.ts [-e /opt/ryph/pi-mcp/index.ts] \
   [--provider … --model … --thinking …] \
   --append-system-prompt <config dir>/appendix.md
```

- `--no-session` — pi normally records each conversation as a resumable session in the user's
  profile. The checkout is throwaway, so nothing is recorded and nothing leaks between runs.
- **No `--tools`**, deliberately — the built-ins are chosen in `settings.json` instead (below).
- `--skill <path>` — one per skill the run holds, naming the `SKILL.md` the core wrote
  ([skills](#-skills), below). It loads under `--no-skills`, which drops discovery only.
- `-e <path>` — ryph's own extensions, the only ones that load (above): the images one always,
  the MCP one only when the run has tools. It is compatible with `--no-extensions`, which governs
  discovery, not explicit paths.
- `-na` (do not trust project-local config) plus the `--no-*` flags — extensions (plugins),
  skills (reusable instruction packs), prompt templates and themes are pi's customization
  surfaces, normally loaded from user- and project-level config. The checkout repo is untrusted
  third-party code, so none of that loads: the repo's own pi config never runs, and nothing
  machine-specific leaks in, so runs behave identically on any box. Skills the platform gives
  the run arrive as explicit `--skill` paths instead; nothing is discovered, not a checkout's
  `.agents/skills` and not `~/.pi/agent/skills`. (pi's `-a` is the opposite
  switch — "trust this project's config" — not an approval flag; tool calls in RPC mode never
  wait on a human, so nothing needs pre-approving.)
- `--no-context-files` — pi's own loading of `AGENTS.md` (the conventional Markdown file with
  repo-specific guidance for coding agents) is **off**. pi would read one from its working
  directory, which is the checkout root: no repository lives there, but any setup step can
  write a file there, and pi would splice it into the system prompt unquoted, beside the
  platform's own block. The clones' real context files still reach the agent — the runner
  reads each one (as a regular file, never through a symlink, and never past its cap) and
  quotes it inside the layout block, where a file cannot speak in the platform's voice.
- `--offline` — pi makes no network calls of its own. In RPC mode the only one was a refresh of
  its model catalogue from pi.dev, which a run never needs: its models are pi's bundled ones or
  the custom entry in `models.json`. Provider calls, extensions and `--skill` files are
  unaffected. It also stops pi downloading `rg` and `fd` from github.com when the base lacks
  them, so pi's `grep` and `find` tools need both on the base's `PATH` (the universal image has
  them; `check-base.sh` warns when a base does not).

### 🧩 Skills

A skill ([Agent Skills](https://agentskills.io/specification)) is a directory with a `SKILL.md`
(YAML frontmatter naming it and saying when to read it, then a Markdown body) and whatever
references, scripts and assets it carries. pi lists every skill it was given by name,
description and location in a `<skills>` section of its system prompt, and the model reads the
body with its `read` tool when a task matches; the body never rides the prompt. The skills a run
gets, and where they come from, are the control plane's decision
([the orchestrator's skills doc](../../orchestrator/docs/skills.md)); the runner's part is
delivery, and it is the same for every harness:

1. The spec lists the skills the run was frozen with, each by name, description, source and
   content digest. The section is read apart from the rest of the spec: its limits are restated
   from the control plane, and a runner in an older environment image can meet a newer one, so a
   section this runner refuses costs the run its skills (reported as drops), never the run. While
   the clone runs, the core fetches every bundle
   (`GET /v1/runs/:id/skills/:digest`, four at a time, `ports/skills.ts`) and checks it in memory:
   the files must hash to the frozen digest, every path must be a plain relative one, and the
   frontmatter must name the frozen name and description (`helpers/skills.ts`). A bundle that
   cannot be fetched or does not check out is dropped; a run never fails for a skill.
2. When the spec allows the working repos' own skills (`workingRepos`), the core reads each
   clone's `.agents/skills/<name>/SKILL.md` and `.claude/skills/<name>/SKILL.md` after the
   clone and before any setup step runs
   (`helpers/repo_skills.ts`). It reads **git objects at the clone's base commit**
   (`ls-tree` for the listing, one binary-safe `cat-file --batch` per repo for the content,
   replace refs ignored), never the worktree, so a setup step cannot add or rewrite a skill, a
   sibling's setup cannot plant one in a fresh clone, and a gitignored file is never one. An
   adopted checkout trusts the image build that made its objects, as it trusts the build's
   outputs. The listing is bounded too: git is stopped past 5 MiB of it, and that repo is read no
   further. Each skill is judged by
   the control plane's rules (restated in `helpers/skills.ts` `prepareRepoSkill`), symlinks and
   submodules are skipped, and the bounds hold before a byte is read: 32 skill directories per
   repo shared by both directories, 64 files and 512 KiB per skill, 8 MiB across every repo.
   Precedence is fixed: a name the control plane froze wins, then the repos in the run's order;
   within each repo, candidates are in name order, with `.agents/skills` winning equal names.
   Both copies count toward the directory cap. A preferred directory or link reserves its name
   even if invalid: no fallback to the `.claude` copy and no merging of files. The
   budget the run was frozen with admits the rest. A loser is dropped and reported, never
   silently shadowed; a `ryph-` name is dropped as reserved. A repo skill that is the frozen org
   copy byte for byte (the run checked out the org skills repo itself) is said once per repo. An
   org skill the agent turned off was never frozen, so in such a clone it loads as an ordinary
   repo skill when working-repo skills are on.
   Repo content is untrusted: anyone who can commit to a repo the run checks out can instruct its
   agent this way, the standing that repo's `AGENTS.md` already has, and the switch for it is
   the agent's and the deployment's.
3. After setup, immediately before the harness starts, the core writes the skills to a fresh
   temporary directory of its own, outside every clone, each under its origin:
   `<dir>/catalogue/<name>/`, `<dir>/org/<name>/` or `<dir>/repo/<checkout path>/<name>/`. The
   location pi lists is that path, so the agent can tell a repo's own skill from one the platform
   froze, as it can tell a repo's `AGENTS.md` by the heading it is quoted under. The directory is
   removed when the harness returns. Each skill is written apart: one that fails on disk is
   removed and dropped as `unavailable`, and the rest load. Written only then, because setup steps are repo-authored commands running as
   the same user: a directory that existed while they ran could have been rewritten by any of
   them, the very description the control plane counted against the listing cap included. That
   is not a seal. The runner does not kill what a step leaves running, so a daemon a step started
   can still race the write or the harness start. That needs a repo deliberately leaving such a
   daemon behind, and the gap is accepted.
4. `SKILL.md` is written **normalized**: the frontmatter re-emitted from the checked fields, each
   a JSON string (a valid YAML double-quoted scalar), then the body as it was written. pi parses
   YAML with a different library than the platform, and two parsers can disagree about
   adversarial input; a frontmatter with one reading cannot.
5. The repo skills loaded and whatever was dropped are reported once
   (`POST /v1/runs/:id/skills/report`, best-effort, one-way, at most 100 drops), and land in the
   run's trail as `skills.repo` and `skills.dropped` events. A skill directory whose name is no
   skill name cannot be named there, so it is only logged.

Claude Code's `.claude/agents/*.md` definitions are not automatically loaded as subagent presets:
Ryph cannot faithfully map their model, tool and permission semantics. Use skills for reusable
instructions and explicit tasks with `ryph__subagent_start`'s `explore` or `work` mode for delegation.

The harness gets the list as `HarnessInput.skills` (`name`, `description`, `source`, `dir`, and a repo skill's checkout `path`).
pi maps each entry to `--skill <dir>/SKILL.md` — the file and not the directory, so nothing
inside a skill can hide its `SKILL.md` behind an ignore file or add a second skill — and keeps
`--no-skills`, which in pi 1.0.0 drops the discovered paths and keeps the CLI's. pi resolves
collisions itself by keeping the first, but the runner never hands it two skills of one name. Nothing goes into pi's throwaway config dir: the skills directory belongs to the core, so
a Claude Code or Codex adapter would link or copy the same directories into its own config home.

**The one line ryph adds.** When the run holds at least one skill from ryph's own catalogue, the
appendix gains a sentence after the machine and environment blocks: before creating or changing
anything under `.ryph/`, read the skill that documents it, naming the ones the run holds. A
listed skill often goes unread when a task does not mention its topic in the skill's words, and
a guess at a `.ryph/` file costs a failed build or a check that never runs. The environment-setup
task's instruction names its skill as well, and says what to do when the run does not hold it.
Skills from other sources get no line: pi's own preamble covers them. The echo harness ignores
skills.

### 🧰 Which built-in tools pi starts with

pi ships eight built-in tools and enables four: `read`, `bash`, `edit`, `write`. The missing
`grep`, `find` and `ls` are not a small loss — the model pays for each of them in `bash` calls,
one subprocess per search, returning whatever the command printed, unbounded and unrendered, where
the built-ins take a pattern, bound their own results and come back in a shape the model reads. So
the adapter enables every built-in this platform can use: `read`, `bash`, `edit`, `write`, `grep`,
`find`, `ls` (`powershell` is the eighth and stays off — the run is Linux). pi 0.85 is a
**prerequisite** for that, not the reason: below it those three searched the *process's* working
directory rather than the agent's, which on a multi-repo checkout is the wrong tree.

**It is done in a file, not on argv, and the difference is not cosmetic.** `--tools` is a strict
allowlist over **every** tool the session has, not a selection of built-ins: pi 0.85.1 turns it
into `allowedToolNames` (`dist/core/sdk.js`) and `_refreshToolRegistry` filters the extension's
registered tools through that same predicate (`dist/core/agent-session.js`). Passing the seven
built-in names on argv would therefore have deleted every `memory__*`, `forge__*` and `ryph__*`
tool the run holds — silently, with the extension still printing its ready line and nothing in the
run's trace to show for it.

`defaultTools` is the selection. The adapter writes `{"defaultTools": [...], "steeringMode": "all"}`
into `settings.json`
in the same throwaway config dir as `models.json` and `mcp.json`: that dir is `PI_CODING_AGENT_DIR`,
which is pi's **global** settings scope, and the global scope is loaded whatever the project's
trust is — so `-na` does not touch it, and none of the `--no-*` flags speaks to tools at all. The
setting names the built-ins active at startup and leaves extension and SDK tools alone, which the
session then activates in full. `-na` is load-bearing the other way round, and this is one more
thing it buys: a **project** `defaultTools` replaces the global array, so a checkout carrying its
own `.pi/settings.json` could otherwise hand its run a one-tool agent. Untrusted, its settings are
dropped whole.

This is a second reason [the pin](../../../images/harness/Dockerfile) must move deliberately, and
it fails the same quiet way the first one does: a pi that turned `defaultTools` into an allowlist,
or stopped reading it from the global scope, would start normally and run with fewer tools than it
was given — `grep` and friends missing, or every MCP tool gone — with nothing failing to say so.

### 🗺️ How the port maps

| port concept                       | pi mechanism                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `systemPrompt`                     | `--append-system-prompt <file>` — appended, never replaced, so pi's own tool-use wiring survives. The value is the path of `appendix.md` in the run's throwaway config dir, which pi reads as the file's contents; the appendix (injected context, layout, the machine block, environment prose, the memory instruction) never rides argv, so no OS limit on one argv string applies |
| `machine`                          | one block of the appendix, after the layout and before any repo's environment prose ([the machine block](#-the-machine-block))                                       |
| `skills`                           | one `--skill <dir>/SKILL.md` per entry, beside `--no-skills`, and the appendix's line about ryph's own `.ryph/` skills when the run holds one ([skills](#-skills))     |
| `canPublishArtifacts`              | the appendix's artifact paragraph: when to publish one with `ryph__publish_artifact`, to get one back with `ryph__fetch_artifact`, that images go in only as tool image refs, that every member can open it, and to read `ryph-artifact-design` first only when the run holds that skill |
| `spec.title` / `spec.instructions` | the body of the RPC `prompt` command, as a `# title` heading plus instructions                                                      |
| `brief` (injected)                 | appended to the prompt BODY after the instructions, verbatim — it arrives already rendered under its own heading: it is what this run was told, not who the agent is |
| `onTranscript`                     | normalized from the event stream (below)                                                                                            |
| `diagnostics`                      | the adapter's mechanical story: the spawn argv (`pi.spawn`, debug) and the two kill fallbacks — an ignored abort (`pi.abort.killed`) and a lingering exit (`pi.shutdown.killed`), both warn |
| `summary`                          | the text of the last assistant message (the core prefers a summary the outcome tools gave, [the self-reported outcome](#-the-self-reported-outcome)) |
| `interrupted`                      | true only when an abort cut the run short while it was in flight; a signal that fires after pi has already finished leaves it false |

### 🏷 The machine block

The agent starts on a machine nobody described to it, and an agent that is told nothing assumes:
it shells out for a search tool it already has, tries `docker`, installs a toolchain the image
carries, or asks a question in a run where nobody is listening. So the core composes one block —
`helpers/machine.ts`, the platform's voice, on **every** run — and the adapter puts it in the
appendix straight after the checkout layout, ahead of anything a repo committed about the machine
it thought it would get.

It says only what the runner can establish where it is standing. Nothing in it is inferred from
which image a run seems to be on:

- **The environment image**, when the control plane resolved one: which image, how old, which
  branch it was built from, and one table row per repository saying whether its checkout came warm
  out of the image or was cloned cold.
  A run with no resolved environment (a CLI run, or environments off) is told nothing about the
  image, because nothing here can establish it.
- **A setup that did not finish**, one paragraph per repo whose `setup.yml` stopped at a failing
  step or was invalid (the run goes on without the rest of its steps;
  [environment setup](environment-setup.md)): the step, its exit code, how many steps were skipped
  and whether its changes to the tree were discarded — or that the file was invalid and why — that
  the environment may be incomplete and the agent may need to finish setting it up itself, and the
  end of the step's output. That output is repo-authored, cleaned of terminal escapes, so it is
  quoted in a fence nothing inside it can close (`helpers/layout.ts` `fence`) and capped at 2,000
  characters. A subagent's block says the same.
- **The toolchains** the build recorded, each as it reported its own version — from the run's
  **spec** (`RunEnvironment.toolchains`, what `ryph-bake` recorded and the control plane
  validated), never from the image's own copy at `/opt/ryph-env/toolchains.json`. That path is
  chowned to the run user, so a setup step could rewrite it between the build and this sentence,
  and a run that has the file carries the same record in its spec anyway. A version is still
  something a build produced by running repo-authored toolchains, so every entry is rendered as
  inline code with its backticks and control characters stripped, clipped, and the record capped
  at 32 entries.
- **A probe of everyday tools on `PATH`** — `rg`, `fd`, `jq`, `just`, `shellcheck`, `mise`, `rustup`, `cargo`, `node`, `pnpm`, `yarn`, `deno`, `bun`, `python3`, `uv`, `go`, `gh`, `docker`, `podman`
  — taken once, before pi spawns, and reported both ways round: what is there, and what is not.
  The probe is a **`PATH` lookup and nothing else** (one `stat` per candidate, no subprocess per
  tool). "Executable" means executable **for the uid the run is** — owner bit, else group, else
  other; on a platform with no uids it falls back to the `other` bit alone and under-reports rather than promising a binary the run cannot
  execute. When no container runtime is among the tools — the normal case, and the one agents keep
  assuming away — the block says so and points at `.ryph/services.yml` instead. When `mise` is
  there it says that its shims run the version a repository pins (`.nvmrc`, `.tool-versions`,
  `.python-version`, `.go-version`, `mise.toml`), and when `rustup` is, that `rust-toolchain.toml`
  is honoured on the first `cargo` call — what the probe establishes, and not a word about whether
  a missing version installs itself, which is the image's configuration and invisible from here.
- **The standing facts of a run**: whether anyone can answer — the run is told what its finish
  instruction already tells it (messages arrive; ask only when an answer is what it is blocked on,
  and otherwise decide, proceed and state its assumptions) so the two cannot contradict each other; that the checkout and its clones are the
  working area and **what is committed there is the only thing that leaves the machine**, while
  installs and caches land outside it wherever their tools put them, by design; and that work is
  verified the way the repository verifies it — its tests, its linter, its typecheck — before
  finishing or submitting a patch. The one conditional fact is the network: outbound access is
  described only when the run actually has an egress proxy (`runChildEnv`'s three variables), so a
  deployment without one is not told about a boundary it does not have.

The block is bounded by construction (fixed prose, a fixed tool list, a capped record, one row per
repo) and counts toward `APPENDIX_MAX_BYTES` like every other part. A harness with no use for it
ignores it, as `echo` does.

### 📜 Event → `TranscriptChunk`

Pi reports its output twice over: a stream of `message_update` deltas while the model is typing
(many per second), then a single event when a block is complete. The adapter narrates only the
completed blocks and ignores the deltas — narrating per-token deltas would turn one assistant
message into hundreds of best-effort narrator hops, pure noise for no gain.

Each chunk carries two views of the same event: `raw` holds the parsed pi event verbatim, so the
archived transcript loses nothing; `text` is the human-readable rendering for narration, clipped
to ~2k chars.

One event can yield zero, one, or several chunks. The fan-out case is a completed assistant
message (`message_end`): its content is a list of blocks — internal reasoning (`thinking`),
prose (`text`), tool invocations (`toolCall`) — and each block becomes its own chunk:

| pi event                                                                                          | chunk                                                                                |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `session`, `agent_start`, `compaction_*`, `auto_retry_*`                                          | `system`                                                                             |
| `message_end` carrying an assistant message                                                       | one chunk per content block: a `thinking` block → `thinking`, a `text` block → `assistant`, a `toolCall` block → nothing (see below) |
| `tool_execution_start`                                                                            | `tool_use` (tool name + clipped args)                                                |
| `tool_execution_end`                                                                              | `tool_result` (clipped result, `[error]`-prefixed when failed)                       |
| everything else (`turn_*`, deltas, toolResult messages, `response`, `agent_end`, `agent_settled`) | not narrated                                                                         |

`toolCall` blocks and toolResult `message_end`s are skipped because the `tool_execution_*` pair
already narrates the same information. `compaction_*` and `auto_retry_*` are pi housekeeping —
compressing a conversation that outgrew the model's context window, retrying a failed provider
call — narrated as `system` chunks so a pause in the run explains itself.

### Context-window telemetry

The Pi adapter asks `get_session_stats` at `agent_start`, `turn_end`, and after compaction.
Only `contextUsage` is forwarded, as a small synthetic `system` / `context_usage` snapshot:
`status`, `tokens`, `contextWindow`, and `percent`. These are current-context estimates, not
cumulative billed tokens. Compaction invalidates outstanding requests and emits `compacting`,
then `recalculating` until Pi supplies fresh usage. Missing or rejected stats are `unavailable`;
telemetry never blocks a prompt or settle and cannot fail the run.

The app retains the newest snapshot by history sequence, independently of transcript page eviction,
and shows it in the docked composer's context ring/popover (never the initial task prompt). These snapshots neither appear in the
transcript nor change whether the agent is working. Old runs without snapshots show unavailable.
A reload hydrates from the loaded history window; if it contains no snapshot, the indicator stays
unavailable until a live update arrives rather than inventing usage from billing totals.

### 🧠 Memory

Memory reaches pi the way every other tool does: the platform's `memory` MCP server sits in the
run's scope, the ryph extension registers its tools as `memory__search`, `memory__get`,
`memory__doc`, `memory__propose`, `memory__confirm` and `memory__refute`, and the gateway meters
and scopes every call. The adapter's only part is the prompt. The **brief** — what previous runs
and people recorded, composed and frozen by the orchestrator, plus the "may be outdated" section
the core appends when its staleness check found changed evidence — goes into the prompt body after
the task — it is what this run was told, not who the agent is; and when the run
actually holds the memory server, the appendix gains one paragraph saying what the tools are
for. A run without the server gets no such ask. Nothing is parsed out of the final message: the
run's outcome comes through its tools (next section).

### 🎯 The self-reported outcome

A message ending is not the run ending, so the agent says how its run went through the loopback
tools, never in a message: `ryph__finish` with `outcome` (`success`, `no-changes` or `failed`) to
report and end at once, and `ryph__report_outcome` to report without ending: before the agent
stops to wait (on checks, a subagent, an answer, feedback or a wake-up), and in an interactive run
— one a person follows on its page — at the end of every turn. A later report's outcome replaces an earlier
one's; a summary or status comment it leaves out keeps the earlier one's, except that a final
outcome never inherits a summary said while the work was `in-progress` (that described a moment,
not the end; the agent's last message stands in). So a run the idle clock
ends still has the outcome the agent last gave. The outcome is required on both: a call without
one, or with a value outside the ones the tool takes, is answered in words and records nothing.
So is a `report_outcome` after the agent's own `finish`: the run already ends at its settle, and
a second `finish`, not a report, is how the agent changes the outcome or summary it ended on.

A report's `summary` is optional: omit it when the run record needs no update, rather than
rewriting it at every handoff. When supplied, it replaces the whole summary; it is not appended.
This does not skip the per-handoff report of `outcome` and `awaitingUserTurn`.

`report_outcome` also takes `awaitingUserTurn`: true when handing the conversation back to the
person, including ordinary conversational handoff, optional feedback, or a needed answer or
decision. It shows **Your turn** while idle. Leave it false when waiting on checks, builds,
subagents or timers. It defaults to false and clears when the agent resumes; internally this
still uses the `waiting-for-user` idle state. It does not change the outcome.

Every outcome is judged against the deliverable the person asked for, never the latest step or
turn:

- `in-progress` — required work or verification remains: the agent is waiting on checks, a
  subagent or an answer it needs, or is still fixing a failed check. Only `report_outcome` takes
  it; `finish` refuses it, answering that work in progress is not finished, and records nothing.
- `success` — the deliverable is complete and the verification it needed is done. Optional
  feedback may still follow; the run stays open for it.
- `no-changes` — the request is fully answered or done, and needed no code changes.
- `failed` — the agent concluded it cannot deliver.

A run the idle clock ends while the agent's last report is `in-progress` ended unfinished: it is
a `failure` whose reason says the work was still in progress, its branches still shipped, and its
patches wait for a person's approval like any failure's. The tool's answer to an `in-progress`
report says so. While the outcome is `in-progress` the run page offers no Finish, only Cancel: a
person's finish concludes on the agent's outcome, and this one says the work is not done. Live, an agent
that could not do its task once wrote a `<result>failed</result>`-style tag into its message
instead (an in-band protocol runs used to be asked for), never called `finish`, and sat out its
idle clock — which is why there is only the one way, and the appendix asks for nothing else.

**The status comment.** A run started from an issue or change request keeps a status comment in
that thread, which repeats the summary when the run ends. A run holding the platform's forge tools
may already have posted what it did there — a review, a comment — so it may ask for the status
comment to only point at the run: `comment: "minimal"` on the outcome tools. The forge also says
it at the moment it is true — a write that lands on the run's own thread is answered with one
line asking for the comment to be "minimal" ([the forge](../../forge/README.md)). A run without
forge tools is not told about the status comment at all.

The core carries the say on the `Result` as `statusComment`. It changes only what the comment
shows — the summary is always written in full and kept as the run's record, and a pull request
body always carries it.

What the declaration does to the run's `Result` — a `success` or `no-changes` with no
branch is a success (the empty branch list says no code changed; the two differ only in what the
agent chose to say), a declared failure still ships its commits, a last report of `in-progress`
is a failure that still ships them, and no declaration at all with nothing shipped is a failure —
is the core's decision, in
[every possible `Result`](architecture.md#-every-possible-result).

### 🛑 When a run ends

A run holds its pod and keeps its thread's status comment open until it ends, and
one thread maps to one live run — so a later `/ryph` there lands in the idle run's inbox instead
of starting fresh. Ending costs only warm context: a follow-up starts a new run with the whole
thread in front of it. The appendix's finish paragraph (every run with a loopback)
therefore gives the agent two concrete tests rather than a judgement call — **end** with
`ryph__finish` as soon as what was asked for is delivered and complete in itself (a review, an
answer, a triage comment, a finding that no change is needed) **or** as soon as it knows it cannot
do the task and has said why, finishing as `failed`; **stay open** only while waiting on something
that continues that work (review feedback on a patch just shipped, an answer needed to proceed).
Handing the task to a person is not such a wait, and the paragraph says so: the live agent above
had asked someone with more access to take over and read that as a reason to stay open. It also
says outright that ending a message is not ending the run. The `finish` tool's own description says the same in one sentence, so the rule is at the
point of use too. It replaces "the work is done and nothing more is expected", which was no test at
all: live, the same `/ryph <agent> review this` ended right after posting its review once and sat
out its idle clock the next time. An answer that offers to do more (options to pick from, a plan
to approve, an offer to make the change) counts as a question awaiting its reply, so it stays open.

An interactive run (`WorkItem.interactive`: one a person started on the run page) gets its own
paragraph and its own `finish` description: answering is not finishing, so the agent ends its
turn after an answer, a review, recommendations or a plan, and calls `ryph__finish` only when the
person says they are done or it cannot do the task. The rule above read that conversation as a
string of deliverables: live, "any recommendations to speed this up?" got its recommendations and
a finish before the person could say "do it". There no follow-up run inherits the thread, and the
idle clock bounds what a quiet run costs; such a run is on the attended clock from the start (the
runner's and `clampIdleDeadline`'s), without being marked attended.

An unattended run (`WorkItem.unattended`: an automation's fire with no response, which nobody
joins) has no review to wait for, so its paragraph drops that reason and tells it to finish once
its change is submitted; the run still holds for checks it asked for. Live, such a run idled on its
pod after opening a pull request and kept that thread busy for the next `/ryph`.

### ⚖️ Errors vs outcomes

Pi's final message carries a `stopReason` — its own account of why the agent stopped:
finished normally, aborted, ran out of room, or broke. The adapter reads it to draw the line
the port contract demands: throw only for mechanical breakage, return everything else.

It throws for: spawn failure (pi not installed), a rejected RPC command, a non-JSON stdout line
(strict JSONL is pi's contract — fail fast rather than skip and hope), the process exiting
before `agent_settled`, or `stopReason: "error"` (provider/machinery breakage).
Everything else is a normal `HarnessOutcome`: the agent saying it couldn't do the task,
`stopReason: "length"` (the model hit its output limit mid-run), or an abort —
the core's commit check, together with the declared outcome, decides what the run delivered.

Two refinements guard those throws. During an **intentional abort** none of them fire:
teardown noise (a partial stdout line, a nacked command, a broken stdin pipe) is logged and the run
still returns `{ interrupted: true }`, as the port contract demands. And a **wedged child** —
one whose stdout ended without settling while the process lingers — is killed after a short grace,
so the premature-exit throw reports a code and stderr instead of awaiting an exit that never comes.

### 🧪 Testing

`tests/pi_harness_test.ts` runs the adapter against `tests/fixtures/fake_pi.ts`,
a dependency-free script speaking the same RPC protocol with canned scenarios
(happy path, abort round-trip, abort teardown noise, provider error, garbage output, early exit,
a failed tool, stderr spam). The wedged-child case is the one exception: a script child can't close
its OS-level stdout while staying alive, so that test drives an inline `sh` child instead.
The event shapes are docs-derived; if pi's protocol drifts, re-check the fake against a live
`pi --mode rpc` transcript. An opt-in e2e against the real binary runs with `PI_E2E=1`
(requires pi installed and an API key; `PI_E2E_BIN=pi`
for one on `PATH` instead of `/opt/ryph/bin/pi`).
