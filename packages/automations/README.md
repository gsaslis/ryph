# ⚡ @ryph/automations

An outside signal, wired to an agent run. A person creates an **automation** — a fixed recipe: an
agent, a repo or workspace, instructions — and picks what fires it: a webhook URL they paste into
Grafana, PagerDuty, Sentry or anything that can POST to one, or a cron schedule. When it fires,
the recipe runs: the orchestrator starts a task exactly as if the owner had asked for it, with the
event attached as context. With a **response** policy, fires about the same thing share one run and
one conversation. The path of a fire, the queue and the deployment are in
[docs/architecture.md](docs/architecture.md).

## What it owns

| Table | What |
| --- | --- |
| `automations` | one row per recipe: owner, name, `enabled`, `trigger`, `agentId`, `target`, `instructions`, `response` |
| fires | one row per fire with its outcome: `started`, `joined`, `resolved`, `ignored`, `refused`, `rate-limited` |
| webhooks | the mailroom's own table, brought by [`@ryph/webhooks`](../webhooks/README.md), mounted here |

Every run an automation starts belongs to its owner (`requestedByUserId`), with `origin:
"automation"`. Two things are fixed on purpose. **The recipe is fixed**: every fire runs the same
instructions against the same agent and target, and the payload is appended as fenced, untrusted
data, never interpolated, so a leaked webhook secret means "my recipe runs again" and nothing else.
**Targets are connected repos or workspaces only**, so the orchestrator's live permission check has
something to check against.

## Triggers

A **webhook** trigger is `POST /v1/hooks/<automationId>` on this service — on the binary and
compose, the control plane's port; behind a Helm ingress, beside the app. Every request proves
itself against the trigger's secret, by one of the mailroom's kinds: `hmac-sha256` over the raw
body (GitHub-style; Grafana, Sentry, PagerDuty), `secret-header` (a password in a header, for
senders that cannot sign: Alertmanager, Grafana IRM, Datadog, Opsgenie), or `standard-webhooks`
(Svix; incident.io). A secret is **minted** and shown once, or **pasted** from a vendor that mints
its own; it is replaced by rotation, never re-displayed. A rate limit, one fire a minute unless the
owner raises it, is checked after verification, so only the secret's holder spends it.

A webhook trigger also names a **format**: how a fire's body is read into a **signal** —
`status` (`firing`, `resolved`, `update` or `unknown`), a `key` naming the alert group, incident or
issue, and a `title`. The presets are `grafana`, `alertmanager`, `grafana-irm`, `pagerduty`,
`sentry`, `incident-io`, `datadog` and `opsgenie`; `custom` takes the owner's own mapping of paths
and values; `raw` reads nothing. Reading never refuses a fire; it changes what the fire means. The
preset list, each one's default verification and whether its secret is minted or pasted are
exported as data (`FORMAT_PRESETS`, `src/core/formats.ts`); the app's picker and its per-vendor
connect steps read the same entries (`packages/app/src/lib/automations/presets.ts`).

A **schedule** trigger is a five-field cron expression and an IANA timezone, at least five minutes
apart, never caught up when missed. It enters the same queue as a webhook fire.

## Responses

Without a `response` policy, every fire starts a run — except an `update`, which is dropped as
`ignored`, because "acknowledged" must never start one. With a policy, a fire **opens** a response
or **joins** the open one as a message in its run's inbox, by the policy's **correlation**:
`fire` (never joins), `automation` (one open response for the automation), or `key` (one per
`signal.key`; refused on a schedule). A `resolved` fire with nothing open is dropped as `resolved`.

The policy also binds the run to a conversation: a `chatroomId`, and on Zulip, Slack or Discord a
`channelId` naming a **private** channel the bot is in, where each response opens its own topic or
thread. A Telegram group is one conversation, so `channelId` is null there and correlation is
`automation`. The idle clocks (`idleMs`, `attendedIdleMs`) say how long the run waits with nothing
said to it, before and after a person has spoken. The response, its run and its closing are the
orchestrator's; this service carries the policy and validates it.

## Running

| Variable | What |
| --- | --- |
| `RYPH_AUTOMATIONS_PORT` | the listener (`7414` in compose) |
| `RYPH_AUTOMATIONS_DB` | a ryph database URL; `ryph_automations` in the networked deployment |
| `RYPH_AUTOMATIONS_TOKEN` | the service token toward the orchestrator's events door |
| `RYPH_AUTH_URL` | the JWKS user bearers verify against |
| `RYPH_CHAT_URL` | the chat service, asked about rooms and channels when a policy is saved |

Under the single-process `ryph` binary none of this is set: the host mounts the routes and the
mailroom in-process. The user-facing surface is the **Triggers** page in the app and the
`automations` / `automations_manage` tools of [`ryph mcp`](../ryph/README.md#a-deployment-as-mcp-tools).

```sh
bun run --filter '@ryph/automations' test
bun run --filter '@ryph/automations' db:generate </dev/null   # after a schema change
```
