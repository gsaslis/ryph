# The MCP catalogue

One JSON file per entry, named for its id, validated at load by `src/core/catalogue.ts`. A new entry
is a file and a review. Two kinds:

- **`hosted`** — an image the gateway runs on the tools network (Grafana). The review is of the
  image: digest-pinned, headers-only, and how it authenticates its callers.
- **`remote`** — a preset for a vendor's own MCP endpoint. The review is of the URL: the host is
  reviewed text or a reviewed `choice` (a region), anything an operator types reaches the URL only
  past an anchored `pattern` and percent-encoding, and the resulting URL still meets the upstream
  rule every remote URL meets. The vendor's static key rides in a sealed header, exactly like a
  hand-registered remote server's.

`defaultOff` names the tools an agent's policy should leave unticked unless someone means it. The
agent form starts a newly added server with everything else ticked and marks these. It is advice:
the allowlist an admin saves is what the data plane enforces. Names come from each vendor's docs or
source as of 2026-10, so a vendor rename shows up as a write tool that is ticked by default — check
the server's tool list after a probe.

## Entries

| Entry            | Endpoint                                              | Credential                                         | Read-only control                                                                     | Off by default                                                                                           |
| ---------------- | ----------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Grafana (hosted) | `grafana/mcp-grafana`, digest-pinned                  | service-account token                              | `--disable-write` toggle, on by default                                               | —                                                                                                        |
| Linear           | `mcp.linear.app/mcp`, or `/mcp/readonly`              | API key, `Bearer`                                  | the read-only endpoint, on by default; or a key with only Read                        | issue, comment, project and label writes                                                                 |
| Atlassian        | `mcp.atlassian.com/v2/mcp?tools=all`                  | service-account API key, `Bearer`                  | none on the endpoint; the key's scopes                                                | every Jira, Confluence, JSM and Bitbucket write, and the `executeWrite`/`executeDestructive` dispatchers |
| Sentry           | `mcp.sentry.dev/mcp/<org>[/<project>]`                | user auth token, `Sentry-Bearer`                   | none on the endpoint; a token with read scopes                                        | issue updates, project/team/DSN changes, alert and monitor create/update/delete, Seer analysis           |
| Datadog          | `mcp.<site>/v1/mcp[?toolsets=…]`                      | personal or service-account access token, `Bearer` | none on the endpoint; the token's permissions, or the org's "MCP Write Access" switch | notebook, monitor, dashboard and case writes; `execute_code`; the remote shell action                    |
| PagerDuty        | `mcp.pagerduty.com/mcp` or `mcp.eu.pagerduty.com/mcp` | user API token, `Token token=`                     | none on the endpoint                                                                  | every incident, service, team, user, schedule, escalation, orchestration, status-page and webhook write  |
| Stripe           | `mcp.stripe.com`                                      | Agent API key, `Bearer`                            | the key's restrictions                                                                | `stripe_api_write` and the Treasury money-movement tools                                                 |
| Supabase         | `mcp.supabase.com/mcp?project_ref=…`                  | personal access token, `Bearer`                    | `read_only=true`, on by default                                                       | `execute_sql`, migrations, project/branch lifecycle, edge-function deploys and secrets, storage config   |

Notes a reviewer should weigh:

- **Atlassian**: `tools=all` is deliberate. Without it the v2 server answers with a
  `discover`/`execute` pair that dispatches to every other tool, and an allowlist of two names would
  allow everything. API-token access is off until an org admin enables it. A personal API token
  needs `Basic base64(email:token)`, which a single pasted secret cannot express, so the entry asks
  for a service-account key.
- **Sentry**: `Authorization: Bearer` on the remote is reserved for its own OAuth tokens. A static
  token rides as `Sentry-Bearer`. The remote serves sentry.io only; self-hosted Sentry is stdio-only
  and out of reach until stdio bridging exists.
- **Datadog**: the default toolset is `core`; every extra toolset widens what `defaultOff` has to
  cover, and the tool names in it are classified from their names, not from Datadog's own
  annotations.
- **PagerDuty**: the EU host answers but is not in PagerDuty's own docs yet.
- **Stripe**: from 2026-10-31 the endpoint refuses full secret keys and restricted keys without the
  Agent tag. `stripe_api_write` covers every POST, PATCH, PUT and DELETE in the API.
- **Supabase**: `project_ref` is required so account-wide tools (`create_project`, …) are never in
  reach by accident; `read_only` runs SQL as a read-only Postgres user, the strongest control any of
  these vendors offers.

## Not here yet

- **Notion**, **Figma**: their hosted servers take OAuth only (Figma also allowlists clients). They
  need the gateway to broker OAuth.
- **Postgres**: the reference server is archived, stdio-only, and takes its credential in argv —
  none of which the catalogue allows.
- **GitHub**: the forge tools are the governed path for GitHub; a PAT preset would be a second, less
  governed one.
