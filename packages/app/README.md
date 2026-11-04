# @ryph/app

The **web UI** for the ryph orchestrator: create and edit agents, assign tasks, watch runs.
SvelteKit (Svelte 5, runes) + Tailwind v4 + shadcn-svelte.

## ⚙️ How it works

The app is a thin **BFF** (backend-for-frontend) in front of the orchestrator. The browser never
holds a token and never calls the orchestrator directly — instead the app server holds the session
in two **httpOnly** cookies and does two jobs:

- **Owns the session.** Login, refresh, and logout are same-origin endpoints (`/auth/*`) that proxy
  to the orchestrator's [@ryph/auth](../auth/README.md) API and set/clear the cookies. Client-side
  JS never sees an access or refresh token.
- **Proxies the API.** Every data call goes to the same-origin `/api/v1/*` route, which forwards to
  the orchestrator and attaches the bearer token from the cookies. No CORS, no exposed tokens. Four
  route families can be sent to a standalone service instead — transcript reads to the historian
  (`RYPH_HISTORY_URL`), provider-key management to the model-proxy's control listener
  (`RYPH_MODEL_PROXY_CONTROL_URL`), MCP-server management and a run's tool-call trail to the
  mcp-gateway's control listener (`RYPH_MCP_GATEWAY_CONTROL_URL`), the memory manager to the memory
  service (`RYPH_MEMORY_URL`); each defaults to the orchestrator origin, which is right for the
  single-process host.

The whole session model — cookies, the SSR refresh, the on-401 retry, and the concurrent-refresh
dedup — is [auth-flow.md](docs/auth-flow.md).

## 🚀 Running

Requires a running [orchestrator](../orchestrator/README.md) (defaults to `http://127.0.0.1:7411`,
set `RYPH_API_URL` — see [`.env.example`](.env.example)). Behind a reverse proxy, set
`ADDRESS_HEADER` (and `XFF_DEPTH`) so the caller's address reaches the control plane: the anonymous
rate limits on sign-in flows are keyed on it.

```sh
bun run dev    # dev server
bun run build  # production build
bun run check  # svelte-check
```

A single-user host (the default) makes its owner at boot and prints a sign-in link. On a fresh
multi-user control plane, visit `/register` and enter the setup token from its log (see
[bootstrap](../auth/docs/token-flows.md#-bootstrap-the-first-user)). The app needs
`RYPH_PROXY_SECRET`, the control plane's value; a built server will not start without it, and
`vite dev` only warns.

### Against a deployment

A UI change is best judged against real agents, runs and history, and a laptop has none. Because
this app is a BFF, the dev server can sit in front of a deployment's services instead of a local
stack — from the repo root:

```sh
./dev remote --context <kube context>
```

It reads the deployment's own `app` Deployment for the services it talks to, port-forwards each to
loopback, and starts `vite dev` pointed at them; `--namespace <ns>` picks a release installed under
another namespace prefix, `--port` another Vite port, and `--no-app` prints the env and holds the
forwards open for a dev server you start yourself. Nothing is written to `.env`, and nothing is
deployed or exposed to make it work — a port-forward tunnels through the API server to the pod's own
loopback, so the gate is the RBAC on your credentials. See
[the dev stack's README](../devstack/README.md#against-a-deployment).

**It is the real deployment.** The data is live and so are the side effects: a task created in that
tab launches a pod in the cluster, and an agent edited there is edited for everyone.

Two flows cannot follow you to `localhost`, both because they are bound to the deployment's hostname
and not to this server: a **passkey** (the control plane checks the origin against the app URL it
was given, so sign in with the password instead) and an **OAuth round trip** — the provider sends
the browser back to its registered callback, which is the deployment's, so the round trip finishes
there rather than here.

## 🗺️ Routes

- `(app)/` — the authed shell (sidebar): `agents/`, `tasks/`, `patches/`, `repos/`, `model-keys/`
  (provider keys, sealed at the model-proxy), `tool-servers/` (remote MCP servers, sealed at the
  mcp-gateway, with a probe that lists each server's tools), `memory/` (what agents remember: browse
  and search the canon, write a memory by hand, work the inbox; `memory/[id]` is one memory's
  record), `settings/` (password, passkeys, linked accounts, sessions), and `admin/` for admins
  only: `users/`, `invites/`, `authentication/` (the registration gates).
- `(flows)/` — full-screen, deep-linkable flow routes (no modals): `login/`, `register/`,
  `invite/[token]/`, `forgot-password/`, `reset-password/[token]/`, `verify-email/[token]/`,
  `[provider]/callback/` (where a forge's OAuth round trip returns), `agents/create/`,
  `agents/[id]/edit/`, `tasks/create/`.
- `api/[...path]/` — the same-origin orchestrator proxy.
- `auth/` — the session endpoints: `login`, `register`, `refresh`, `logout`,
  `oauth/[provider]/start`, `passkey/login/{options,verify}`, `invite/[token]/accept`,
  `verify/[token]`.

## 📚 Docs

| Doc                               | What it covers                                                                |
| --------------------------------- | ----------------------------------------------------------------------------- |
| [auth-flow.md](docs/auth-flow.md) | the BFF session model — cookies, the SSR refresh, the proxy, and on-401 retry |

## 🧱 Scaffolding

Created with:

```sh
bunx sv@0.16.3 create --template minimal --types ts --add tailwindcss="plugins:typography" --install bun app
```
