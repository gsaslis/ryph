// The boot refusal for secrets everyone knows.
//
// compose.yaml and the local Kubernetes overlay once shipped fixed placeholder credentials, and
// the repository is public, so each of those strings is a credential anyone can present. A
// service that boots holding one is guarded by nothing: on a flat compose network any container
// can use it to call an internal route, connect to Postgres, or forge an egress claim.
//
// So every service checks its whole environment at boot and exits if any value contains one.
// Substring, not equality, because the Postgres password reaches services inside a database URL.
// RYPH_ALLOW_DEV_SECRETS=1 lets a laptop-only deployment boot anyway (the local k8s overlay sets
// it); nothing else should.

import { hostileEnvironment } from "@ryph/shared/env";

/** Every placeholder secret that was ever committed to this repository. Never remove one. */
export const PUBLIC_DEV_SECRETS: readonly string[] = [
  "dev-forge-token",
  "dev-history-token",
  "dev-model-proxy-token",
  "dev-automations-token",
  "dev-mcp-gateway-token",
  "dev-memory-token",
  "dev-memory-gateway-token",
  "dev-platform-token",
  "dev-chat-token",
  "dev-chat-gateway-token",
  "dev-web-gateway-token",
  "dev-forge-gateway-token",
  "dev-radicle-token",
  "dev-proxy-secret",
  "dev-previews-token",
  // The docker launcher's two (RYPH_LAUNCHER_TOKEN, RYPH_LAUNCHER_TOOLS_TOKEN), listed before any
  // file could commit them: the run token launches containers on a machine's docker socket.
  "dev-launcher-token",
  "dev-launcher-tools-token",
  "dev-postgres-password",
  "ryph-dev-access-key",
  "ryph-dev-secret-key",
  "deadbeef".repeat(8),
  "cafebabe".repeat(8),
  "cafed00d".repeat(8),
  "0badf00d".repeat(8),
  "feedface".repeat(8),
  "dev-previews-token-0000000000000000",
];

/** The flag that lets a laptop-only deployment boot with them anyway. */
export const ALLOW_DEV_SECRETS = "RYPH_ALLOW_DEV_SECRETS";

/** Names of the variables whose value contains a public placeholder, sorted. */
export function findPublicDevSecrets(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([name, value]) =>
      name !== ALLOW_DEV_SECRETS && PUBLIC_DEV_SECRETS.some((s) => value.includes(s))
    )
    .map(([name]) => name)
    .sort();
}

export type DevSecretsVerdict =
  | { kind: "clean" }
  | { kind: "allowed"; names: string[] }
  | { kind: "refused"; names: string[] };

/** Pure decision, for tests: what boot should do with this environment. */
export function judgeDevSecrets(env: Record<string, string>): DevSecretsVerdict {
  const names = findPublicDevSecrets(env);
  if (names.length === 0) return { kind: "clean" };
  return env[ALLOW_DEV_SECRETS] === "1" ? { kind: "allowed", names } : { kind: "refused", names };
}

/**
 * Exits the process (code 2) under an environment @ryph/shared/env refuses: one that changes what
 * Bun does around the service (a preload, a debugger, every request's headers on stderr) or turns
 * TLS verification off. No override: a private CA goes through `caFetch`, never through turning
 * verification off.
 */
export function refuseHostileEnvironment(service: string): void {
  const hostile = hostileEnvironment(process.env);
  if (hostile === null) return;
  console.error(`error: ${service}: ${hostile.message}`);
  process.exit(2);
}

/**
 * Exits the process (code 2) when the environment holds a public placeholder secret and
 * RYPH_ALLOW_DEV_SECRETS is not 1, or is one `refuseHostileEnvironment` refuses. Call it first
 * thing in a service's main().
 */
export function refusePublicDevSecrets(service: string): void {
  refuseHostileEnvironment(service);
  // process.env's values are always strings; its type allows undefined for a missing key.
  const verdict = judgeDevSecrets(process.env as Record<string, string>);
  if (verdict.kind === "clean") return;
  const names = verdict.names.join(", ");
  if (verdict.kind === "allowed") {
    console.warn(
      `${service}: public dev secrets in ${names}; booting because ${ALLOW_DEV_SECRETS}=1`,
    );
    return;
  }
  console.error(
    `error: ${service}: public dev secret in ${names}. ` +
      `Generate real values (bun run compose:init writes them for compose), or set ` +
      `${ALLOW_DEV_SECRETS}=1 on a laptop-only deployment.`,
  );
  process.exit(2);
}
