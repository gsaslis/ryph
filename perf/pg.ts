/**
 * The perf stack's Postgres as the host reaches it, with the password `bun run compose:init`
 * wrote into deploy/compose-networked/.env (the perf:* tasks load it with --env-file).
 */
export function pgBase(): string {
  const password = process.env.POSTGRES_PASSWORD;
  if (!password) {
    throw new Error(
      "POSTGRES_PASSWORD is unset: run `bun run compose:init`, or set PERF_PG_BASE / PERF_PG",
    );
  }
  return `postgres://ryph:${encodeURIComponent(password)}@127.0.0.1:5433/`;
}
