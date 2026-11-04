# 📬 @ryph/webhooks

The mailroom: a library for receiving webhooks, mounted by every package that has some to receive.
It is not a service of its own. It verifies the sender, persists the request as it arrived,
answers `202`, and hands the request to the package that rented the mailbox, later, oldest first.
It never reads a payload. The design and every rule are in
[docs/architecture.md](docs/architecture.md).

## What it does

A **mailbox** is one URL, `POST /v1/hooks/<id>`, for one sender, with a rule for verifying it and
the function that handles what arrives. Four verify rules:

| Kind | What the sender proves | Used by |
| --- | --- | --- |
| `hmac-sha256` | `prefix + hex(HMAC-SHA256(secret, rawBody))` in a header; several signatures in one header pass if any matches | GitHub, Grafana, Sentry, PagerDuty |
| `secret-header` | `prefix + secret` verbatim in a header: a password, not a signature | Alertmanager, Grafana IRM, Opsgenie, Datadog, the Radicle bridge |
| `derived-secret-header` | a per-scope token derived from a master, so a leaked token forges nothing for another scope | GitLab |
| `standard-webhooks` | the Svix scheme: id, timestamp and body signed, five-minute replay window | incident.io |

A mailbox may cap its intake with a rate limit, answered `429` after verification so only the
secret's holder spends it. Delivery is per-mailbox FIFO with retries, so one sender's failing fire
never delays another's.

## Who rents mailboxes

- [`@ryph/automations`](../automations/README.md): one per automation with a webhook trigger.
- [`@ryph/forge`](../forge/README.md): GitHub App, GitLab and Radicle events.

```sh
bun run --filter '@ryph/webhooks' test
```
