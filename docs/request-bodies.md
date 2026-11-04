# HTTP body budgets

JSON schema validation happens **after** a body has been read. It is not a byte limit. A route that
buffers a request must enforce its byte budget before decoding/parsing or calling business logic,
regardless of whether the caller sends `Content-Length`.

New text/JSON readers use `readCapped(request, maxBytes)` from `@ryph/shared/http` (or `parseBody`,
which reads with it). It rejects an announced oversized body early, counts actual streamed bytes,
cancels overflow without waiting for producer cleanup, and releases its reader. `null` means
overflow; broken reads throw. An optional `AbortSignal` is the read's deadline (`parseBody`'s
`signal`): a body still arriving when it aborts is cancelled and answers 408. Routes retain their
authentication and response policy: 413 names the byte limit, malformed JSON is 400, and
authentication precedes reads where possible.

## Budgets

All units below are binary (KiB = 1024 bytes, MiB = 1024 KiB).

| Surface                                                 | Budget        | Source                                                                            |
| ------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------- |
| Orchestrator management JSON, including optional bodies | 1 MiB default | `MAX_JSON_BODY_BYTES` in `packages/shared/src/http.ts` (`parseBody`)              |
| Task creation and user response JSON                    | 8 MiB         | `packages/orchestrator/src/http/user/{task_start,responses}.ts`                   |
| Automation event delivery                               | 16 MiB        | `packages/orchestrator/src/http/automations_api.ts`                               |
| Agent creation/update                                   | 8 MiB         | `packages/orchestrator/src/http/user/agents.ts`                                   |
| Patch approval/retry                                    | 16 MiB        | `packages/orchestrator/src/http/user/patches.ts`                                  |
| Runner target claim, image-reference resolution         | 64 KiB        | `packages/orchestrator/src/http/runner_api.ts`                                    |
| Runner heartbeat                                        | 1 MiB         | same                                                                              |
| Runner checks, skills and stale-base reports            | 4 MiB         | same                                                                              |
| Runner setup-failure reports                            | 4 MiB         | same                                                                              |
| Runner stale-memory reports                             | 1 MiB         | same                                                                              |
| Runner patch submissions                                | 4 MiB         | same                                                                              |
| Runner results                                          | 8 MiB         | same                                                                              |
| Auth API and app auth forms/passkey assertions          | 256 KiB       | `packages/auth/src/http/routes.ts`, `packages/app/src/lib/server/request-body.ts` |
| Automations management                                  | 1 MiB         | `packages/automations/src/http/routes.ts` (`parseBody`'s default)                 |
| MCP management and internal credential requests         | 1 MiB         | `packages/mcp-gateway/src/http/{routes,internal}.ts`                              |
| Model-proxy management and internal credential requests | 1 MiB         | `packages/model-proxy/src/http/{routes,internal}.ts`                              |
| ChatGPT-plan sign-in requests                           | 64 KiB        | `packages/model-proxy/src/http/chatgpt_plan.ts`                                   |
| Forge internal JSON service requests                    | 16 MiB        | `packages/forge/src/http/service.ts`                                              |

The runner authenticates before parsing. Overflow emits `run.body_too_large` with the authenticated
`runId`, request path and byte limit, never body contents or credentials. Runner budgets are sized
to what a real runner sends (each constant's comment derives it), not to every list a schema could
hold: a run token may be in an untrusted fork PR's hands, and everything under a cap is buffered on
the control plane's one event loop. On top of the caps, each run may have at most 8 runner bodies
being read at once, holding at most 24 MiB of reserved caps between them (429 past either, the body
unread), and each body must arrive within 30 s (408). Routes with once-only or terminal-run refusals
answer them before reading. Management overrides preserve existing aggregate schema bounds,
including JSON escaping and UTF-8 expansion: for example, an automation event can carry a 2 MiB
webhook payload escaped inside a JSON string.

## Existing specialized readers

Do not turn a streaming protocol into a whole-body JSON read merely to use the shared helper. These
paths already enforce their own budgets:

- Memory: 3 MiB management; 1 MiB MCP/internal. Chat: 64 KiB management; 256 KiB MCP/internal.
- Webhook ingestion: registration-specific limit (2 MiB default), enforced on raw bytes **before**
  signature verification. Signature checks must continue to see the original bytes.
- Historian: 1 MiB batches; long-lived NDJSON uplinks bound each line, not the whole session.
- Model proxy: 64 MiB request bytes, with a tighter 24 MiB ChatGPT-plan request budget. Its
  specialized reader avoids decoding/copying large image-bearing requests unnecessarily.
- Runner image/artifact uploads, background intake, preview registration, forge/MCP/web/browser tool
  requests and Radicle multipart uploads read bytes with `readCappedBytes`/`readCappedText`
  (`@ryph/shared/http`), which refuse a Request's or Response's oversized Content-Length before
  reading and take a deadline, or have dedicated capped readers.
- Git forwarding and preview proxying stream rather than accumulate entire request bodies.

Ordinary model-proxy upstream JSON responses are passed through with backpressure. Usage metering
retains at most two 64-Ki-character JSON windows instead of the whole response; this is a bounded
memory policy, **not a total transfer-size limit**. Non-streaming ChatGPT-plan replies must be
assembled from SSE and enforce a 64 MiB upstream byte budget (the configured proxy request budget
when overridden); overflow cancels the upstream and answers 502. Plan error bodies have a separate 1
MiB cap.

## Verification and limits of the protection

Regression tests exercise exact-limit acceptance and one-byte-over refusal, absent/false declared
lengths, multibyte UTF-8, optional whitespace bodies, malformed/broken streams, cancellation, and
representative route side-effect tripwires. Runner tests also verify authentication-before-reading
and attributed overflow diagnostics.

These are per-request allocation bounds, not aggregate admission control. Parallel requests, slow
senders, parsing CPU, and deployment-specific ingress limits remain separate concerns. The shared
service listener uses `node:http`; do not treat a `Bun.serve` default or a stream high-water mark as
an application body limit. Development-only playground fixtures are not production listeners.
