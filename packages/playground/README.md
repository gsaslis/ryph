# 🛝 @ryph/playground

A whole ryph on one machine, seeded with a believable deployment, with the app's dev server in front
of it: for working on the UI without a cluster, a container runtime, or someone's real data.

```sh
bun run playground                       # seed if needed, serve the app on :5173, keep live runs going
bun run playground --preset full         # every story: all patch states, failures, cancelled/lost runs
bun run playground --with history=40     # more history
bun run playground --preset minimal      # an owner, a model, repos and agents; nothing else
bun run playground --preset empty        # no account yet: the sign-up flow
bun run playground list                  # every fixture and preset
bun run playground seed                  # seed and exit
bun run playground reset                 # delete its data
```

Sign in as `owner@ryph.local` (or `member@`, `operator@`, `viewer@`), password `playground-password`.
`--port-offset 10000` moves every port, to run it beside `./dev`.

The default `ui` preset keeps the supporting fixtures and both live runs, but plays only three
finished stories: an approved patch, a patch awaiting review and a no-change conversation. `full`
plays the entire catalogue. Both also include `platform-notices`: a dedicated **Platform notices —
every type (visual catalogue)** run with every patch/environment state, release and human finish,
payload-null checks, an unknown-payload fallback, and all runner-local notifications. It includes a
real, harmless pending hook patch for inspecting the approval action. Other notice outcomes are
explicitly synthetic (not claims about that patch). Original verbose text is retained. The seeder
prints `platform-notices: <run-id> — /tasks/<task-id>`; open that task or find the title in Tasks.
Use `--preset minimal --with platform-notices` for just this catalogue and its dependencies, or
`--without platform-notices` to omit it. Inbox examples are installed in the existing offline
backdating pass because the public API cannot impersonate the platform; runner-local examples use
the historian API. No environment/check infrastructure is launched.

`--with history=N` overrides either preset; small histories start with
those three deliberately chosen stories, then the rest of the catalogue, cycling for larger N.
Changing the seed selection reseeds the database; use `--name` to keep different playgrounds apart.

For UI work in an agent run, start it early with `ryph__background_run`, `service: true` and
`readyWhen: "RYPH_PLAYGROUND_READY"`, then keep investigating or editing while it boots. The stable
marker is printed only after seeding, live fixtures and HTTP readiness checks finish (including
Vite unless `--no-app`). It produces a one-time ready notification without stopping the service.
`seed`, `list` and `reset` do not emit it. Reuse the process throughout the task.

## What it is

Three processes, none of them a container, and two mocks served from this one:

- the `ryph` host from source (`packages/ryph`, `up --no-setup`): every service in one process on an
  embedded PGlite database, migrations applied at boot, the forge embedded, the `manual`
  provisioner, multi-user (the owner fixture claims it with the setup token the host prints);
- the app's Vite dev server, pointed at it;
- a mock OpenAI-compatible endpoint, served from this process and registered as a custom provider,
  so model calls are metered by the real proxy;
- mock Telegram, Zulip, Slack and Discord (`src/mock_chat.ts`), on one port (`7481`), which the
  host's chat service dials as the real ones: `RYPH_CHAT_TELEGRAM_API_URL`,
  `RYPH_CHAT_SLACK_API_URL` and `RYPH_CHAT_DISCORD_API_URL` point it there (Discord's Gateway
  WebSocket too, which the mock's `GET /gateway/bot` names), and the Zulip room's realm URL is the
  mock's. The `chat` fixture creates one room on each (`Ops (Telegram)`, linked to its group,
  `Acme Zulip`, `Acme Slack`, `Acme Discord`), each with private
  channels and one public one, and the Grafana automation opens each alert's response in Zulip's
  private `#incidents`. The page at the mock's root (printed as `chat` in the banner) shows every
  conversation and what the bot posted there, and lets you answer as Olivia or Max, with or
  without mentioning the bot.
- a fake GitLab (`src/mock_gitlab.ts`, `@ryph/fake-gitlab`) on `7482`, which the host's forge
  runs against in bot mode (`RYPH_GITLAB_*`), with GitLab sign-in through it. The `gitlab` fixture
  links Olivia and Max to their GitLab accounts, connects `acme/billing-api` and the nested
  `acme/platform/infra-live`, and plays stories whose patches become merge requests there: `!1` on
  billing-api gets a review and a `/ryph` follow-up, `!1` on infra-live is merged, and a `/ryph`
  on issue `#1` starts a task. `acme/platform/handbook` is left unconnected for the connect flow.
  The fake keeps its state in memory: after a restart ryph's side is all still there, but the
  merge requests and notes on GitLab are gone.

Its data lives under `data/playground/<name>/` (gitignored): the database, three local git repos
the repos fixture creates, logs (`logs/host.log`, `logs/app.log`), and what was said on the mock chat platforms
(`chat.json`). A second start with the same
fixtures reuses the database; `--fresh` reseeds.

## Fixtures

Each fixture creates its slice through the same HTTP API the app uses (`src/fixtures.ts`), so what
it makes is valid by construction and stays valid as the code changes. A fixture names the ones it
needs; asking for one brings those in. A `seed` fixture writes once into the database; a `live` one
runs on every start.

Runs are played by a scripted runner (`src/runner.ts`), which does on the wire what
`packages/runner` does: bootstrap with the token the manual provisioner prints, heartbeats,
transcript events to the historian, model calls through the proxy, a real clone through the forge's
git gateway, a real bundle upload for a patch, a result. Only the transcript is made up
(`src/stories.ts`), in the shapes pi's adapter emits, so the app renders it as it would a real
run's. Any run nobody scripted (a task started in the app, an automation's) is adopted and played by
a generic script that answers every message.

Seeding plays runs through the stack, so more history costs more startup time. A last pass (`src/backdate.ts`) stops the host and moves
each run into the past along one time map per run, stretched to the length its story says, so
history spreads over three weeks with believable durations.

## What it cannot show

- **Repos on GitHub or Radicle.** Connecting one needs the real service; every other repo here is
  local, or on the fake GitLab.
- **Running checks.** They only run in a pod or container a launcher starts; the manual
  provisioner has none. `RYPH_CHECKS` is on so the checks pages read, and the `gitlab` fixture
  writes a finished suite on each merge request (and its `ryph / <name>` commit statuses on the
  fake) while the host is stopped. "Run again" cannot start anything.
- **Environments, hosted MCP servers.** Each needs a builder or a container backend. The
  tool-server fixture's server is a stand-in that answers nothing.
- **Real chat platforms.** The mocks answer only what the transports call, keep no uploads across
  a restart, and know only the two people above.
