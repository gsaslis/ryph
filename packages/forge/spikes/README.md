# 🧪 Spikes

Throwaway code from phase 0, kept because it is **proven** and because the arguments in
[`docs/git-gateway.md`](../docs/git-gateway.md) rest on it. Every measured number in that document
came out of these two files. This is not shipping code and is not wired into the workspace.

| File                    | What it is                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upload_pack_direct.ts` | **The basis `src/helpers/http_backend.ts` was built from** (phase 1 — which added the request-body cap below). Spawns `git upload-pack --stateless-rpc` directly; ~115 lines |
| `upload_pack_cgi.ts`    | The rejected variant — `git http-backend` as CGI; ~194 lines. Kept so the comparison is checkable rather than asserted                                                       |

Both were run against real git and both worked: protocol v2, chunked bodies, gzip, incremental
fetch, `--depth=1`, `--filter`. Direct won because it makes read-only **structural** —
`receive-pack` has no route at all, rather than being switched off by a config flag that has to stay
correct.

## ⚠️ Before copying `upload_pack_direct.ts` into `src/`

It carries a `TODO(required)` and it is not decoration:

> **The direct variant has no request-body cap.** `git http-backend` buffers the request and
> hard-caps it at 10 MiB for free; spawning `upload-pack` directly **forfeits that**. Measured: the
> same 30 MB request http-backend refused, `upload-pack --stateless-rpc` swallowed whole and
> answered with a 200 MB pack. A cap must be added, and it must reject **while streaming** —
> buffer-then-check _is_ the DoS.

The other traps these files already handle, and which are easy to un-handle by accident:

- **`GIT_PROTOCOL` must be passed through** (sanitized, off the `Git-Protocol` header). Dropping it
  silently downgrades every client to v0 — measured at a **1,564,124 B advertisement instead of 138
  B**, with no error and no failing test.
- **Request bodies are gzipped** when git uses `Content-Length`. The direct variant inflates them.
- **stdin must be pumped concurrently with draining stdout**, or large responses deadlock. And
  `pipeTo`'s rejection must be caught, or an early upload-pack death takes the process down.

See [`docs/git-gateway.md`](../docs/git-gateway.md#-gotchas-paid-for-in-blood) for the full list.

## Running them

```sh
GIT_ROOT=/path/to/dir/of/bare/repos \
  bun --no-env-file packages/forge/spikes/upload_pack_direct.ts
# then: git clone http://127.0.0.1:8176/repo.git
```
