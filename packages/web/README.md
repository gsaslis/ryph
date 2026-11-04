# @ryph/web 🌐

The public web, **read-only**, as two tools a run reaches through the gateway's `platform` server:
`web__search` and `web__fetch`. It is the one service that fetches an address an **agent** chose —
which is what makes it useful (a library's current API, an error message nobody here has seen, what
a standard actually says) and what makes it the most carefully bounded read in the platform.

It keeps nothing. No database, no schema, no migration set, no volume: one handler, two tools, and
a pair of rules about where a fetch may go.

## ⚙️ How it works

**`web__search`** takes a query, a `count` of 1–10 (5 by default) and an optional `freshness`
(`day`, `week`, `month`, `year`), and answers a numbered list: title, URL, snippet, and how old the
page is when the index knows. The backend is one method behind an interface
(`ports/search.ts`) — Brave's API is the first and today the only implementation, chosen by
`RYPH_WEB_SEARCH_PROVIDER` and keyed by `RYPH_WEB_SEARCH_KEY`. **Without a key the tool is not
listed at all**: `tools/list` answers `fetch` alone, one line at boot says why, and a model never
spends a turn discovering that search is dead. The key is spent on one host and appears in no
result, no error and no log line.

**`web__fetch`** takes a URL and an `offset`, and answers the page's title, its final URL after
redirects, its content type, its total length, and one slice of at most 50 KB from `offset` — with
the next offset spelled out when there is more. HTML becomes markdown: linkedom parses it,
[@mozilla/readability](https://github.com/mozilla/readability) extracts the main content the way
Firefox's reader mode does, and turndown (with the GFM plugin) writes it out — pipe tables, fenced
code blocks that keep their language class. A page readability declines falls back to the body with
`script`, `style`, `nav`, `header`, `footer`, `aside`, `noscript` and `iframe` removed, because
"no article" is not an answer an agent can act on. `text/plain`, `text/markdown` and
`application/json` pass through as they are (JSON pretty-printed); a PDF, an image or a binary is
refused in words that suggest what to look for instead. HTML is capped at **1 MB** before
anything parses it and everything else at **2 MB**, one **20 s** deadline covers the whole call
including redirects, and at most **5** hops are followed.

**What a page may cost is bounded, because the page is the agent's choice and not ours.** HTML is
read to **1 MB** before anything parses it (text, markdown and JSON to 2 MB — they are sliced, not
parsed), and a page cut there says so. The conversion runs in a **worker thread** with a
**five-second** budget and is terminated past it: measured at the 1 MB cap, link-dense soup costs
~1.1 s and ~400 MB resident, table soup ~0.6 s, and a deeply nested page 53 s — that last one
never finishes, which is the whole reason the budget has to be enforceable rather than polite
(nothing yields during a parse, so no request timeout would help). At most **two** conversions run
at once and the third is refused rather than queued. A page just converted is **cached** for two
minutes by the URL asked for, so paging through a long document with `offset` costs one fetch and
one conversion. Each refusal names its limit, so the agent can act on it.

**Everything either tool returns is framed as untrusted.** A page comes back inside a fence longer
than any backtick run inside it — so the content cannot close its own quote and continue in the
platform's voice — under one line saying it is third-party text to be read as data and never as
instructions. A result list carries the same line once. The technique is the runner's `fence`
(`packages/runner/src/helpers/layout.ts`), which quotes a repo's `AGENTS.md` for exactly the same
reason, and it is worth being honest about what it is: a label is not enforcement. It is the
difference between a model that has been told and one that has not.

## 🛡️ Where a fetch may go

`core/addresses.ts` is the whole of it, pure and unit-tested against a fixed address table:

- **http(s) only.** No `file:`, no `data:`, no anything else.
- **https only**, unless `RYPH_WEB_ALLOW_INSECURE=1`. A plain-http page is a page an on-path party
  writes, and what comes back is read by a model that acts on it.
- **no userinfo** in the URL.
- **every resolved address must be globally routable.** Loopback, `0.0.0.0/8`, RFC 1918, CGNAT
  (`100.64/10`), link-local (`169.254/16` — the cloud metadata address — and `fe80::/10`), unique
  local (`fc00::/7`), multicast, the documentation and benchmarking blocks, and everything outside
  IPv6 global unicast are refused, including a name that resolves to one of them and an
  IPv4-mapped IPv6 address that wraps one.
- **every redirect hop is judged again.** Redirects are followed by hand (`redirect: "manual"`)
  precisely so that a public host answering `302 http://169.254.169.254/` is refused at the hop and
  never dialled.

Ports are part of it: only the scheme's own (443, or 80 where insecure fetches are allowed). A
public host is still a host with sixty thousand other ports on it, and "read a page" is not
"reach the admin panel on :8080".

**The residual, stated plainly:** the runtime's `fetch` cannot be pinned to an address we already
resolved, so between the check and the connection a name can answer differently (DNS rebinding).
The window is one lookup wide and the attacker must already control a name the agent was induced
to fetch — and **what stands behind it depends on where this runs**:

- **On Kubernetes there is a second layer, and it is a real one.** The service's NetworkPolicy
  ([networkpolicies.yaml](../../deploy/helm/ryph/templates/networkpolicies.yaml) in the Helm chart) excepts
  every private range from its egress and opens port 443 alone, and its ingress admits the
  mcp-gateway and nobody else. A rebound name reaches nothing the policy does not already allow.
- **Under the single binary and under compose there is no second layer.** The process has an
  ordinary route to the machine's own network, and a rebound name would reach whatever that
  network reaches; compose also publishes the service on `127.0.0.1:7480` so `compose:smoke` can
  probe it, which means anything on that machine can reach it too (it still needs the gateway's
  token to call a tool). The controls there are the rules above, `RYPH_WEB_TOOLS=off`, and the
  per-agent tool policy — not a network boundary, and this document will not pretend otherwise.

## 🕳️ What it costs, honestly

A read tool that takes an arbitrary URL is a **write** channel: whatever an agent puts in a path or
a query string leaves the deployment, and so does a search query. Egress lockdown cannot close it,
because it is a sanctioned one. Three things bound it, and they are the ones this platform always
uses:

- **It is on the record, in two places that say different things.** The gateway's tool-call trail
  (`GET /v1/mcp-usage/:runId`) counts and times every call per run, but its rows hold no
  arguments — so this service logs each call at `INFO` with the run id, the URL fetched and the
  query searched for. Neither record replaces the other: the trail says a run made eleven web
  calls at 14:02, the log says which addresses they were.
- **It is a per-agent decision.** The row is an ordinary MCP server row: an agent's tool policy
  may narrow it to one tool, or opt out entirely with an **empty allowlist** for the web row
  (`{"serverId": "ms-platform-web", "allowedTools": []}` — the API takes it, the agent form does
  not offer it), in which case the gateway denies every tool on it and hides them all from
  `tools/list`. A deployment that wants no web access at all sets `RYPH_WEB_TOOLS=off` (or, in
  the networked deployment, leaves `RYPH_WEB_URL` unset), and then there is no row to name.
- **It cannot be turned inward.** This service decides where a fetch may go, so the channel is
  out of the deployment or nowhere. Later, an environment's egress bundles are the natural thing
  to constrain a fetch against — an agent whose bundles name `npm` and `github` has no business
  reading arbitrary hosts. That is not built. The full treatment is in the
  [threat model](../forge/docs/threat-model.md#-the-payoff-this-is-what-makes-egress-lockdown-possible).

## 🔌 Surfaces

| Surface                    | Auth                                | What                                                                     |
| -------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| `POST /v1/web-mcp`         | `RYPH_WEB_GATEWAY_TOKEN` + run id   | The MCP route: `search` (where a key is configured) and `fetch` — reached only via the gateway |
| `GET /healthz`, `/readyz`  | none                                | Liveness and readiness. Readiness CONVERTS a small page — the one thing this service does, end to end — memoised for 30s and on a converter of its own, so a busy replica still reads ready |

There is no user surface and no internal surface, because nothing here belongs to anybody. The run
id in `x-ryph-run-id` buys no scope either — the web is the same web for every run — it is carried
so the log line can name which run asked for what.

"Reached only via the gateway" is a statement about the CREDENTIAL, not about the network: the
data route wants a token only the gateway holds. On Kubernetes the network says it too (the
NetworkPolicy admits the mcp-gateway alone); under compose the service is published on
`127.0.0.1:7480` for `compose:smoke`, and under the single binary it is not a socket at all.

## 🏛️ Where it runs

Under the single process (`@ryph/host`, the `ryph` binary) `setup()` is called in-process and the
gateway's platform entry dials the handler through a `fetch` that opens no socket, with a token
minted at boot. Standalone (`src/main.ts`, `images/web/Dockerfile`) it listens on `:7480` and the
gateway dials `RYPH_WEB_URL` with `RYPH_WEB_GATEWAY_TOKEN`. The control plane is told the tools
exist with `RYPH_WEB_TOOLS=on` and checks the gateway really holds the row before it puts it in any
run's scope.

Every tool-capable agent's runs carry the row by default, the way memory's is carried; an agent's
tool policy may name it to narrow it to one of the two tools, or carry an empty allowlist to opt
out of both.

`RYPH_WEB_TOOLS=off` removes it for the whole deployment, binary included — there, "leave it
unwired" means this switch, because the gateway is the same process. What `off` does is worth
being exact about, because a platform row **cannot be archived**: a row an earlier boot seeded
stays in the database and still appears in the agent form. What changes is that no run is granted
it — not by default, and not through an agent's own tool policy, whose entry for the row is
dropped when the scope is frozen. The capability goes even where the row does not.

| Variable                                       | Effect                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `RYPH_WEB_TOOLS`                               | `off` takes the web tools away entirely — under the single binary nothing is mounted, no row is seeded, and no run is scoped to it; in the networked deployment it is what the control plane is told (default on)  |
| `RYPH_WEB_PORT`                                | The listener, standalone (default `7480`)                                                                   |
| `RYPH_WEB_GATEWAY_TOKEN`                       | The gateway's credential on the MCP route. Unset, every call refused                                        |
| `RYPH_WEB_SEARCH_PROVIDER`, `RYPH_WEB_SEARCH_KEY` | The search backend (`brave`, the default) and its key. No key: `web__search` is not offered at all       |
| `RYPH_WEB_ALLOW_INSECURE`                      | `1` permits plain `http://` pages. Default: https only                                                      |
| `RYPH_WEB_FETCH_TIMEOUT_MS`                    | The whole of one fetch, redirects included (default `20000`)                                                |

## ⚡ Commands

```sh
bun run ci   # type-check, architecture guard, tests (fmt and lint run from the root)
bun run test # the address rules range by range, the redirect walk and the caps over a fake
             # upstream, the HTML conversions, the framing, the tools, and the MCP route over
             # its own handler — no socket is opened by any of it
bun run dev  # the standalone service on :7480
```
