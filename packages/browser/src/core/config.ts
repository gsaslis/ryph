// The ONE-SHOT configuration. The sidecar boots knowing nothing: no token, no proxy. The runner,
// which holds every credential of the run, hands it on `POST /configure` the bearer its MCP client
// and live relay will present, the egress proxy's per-run Basic credentials (which the agent's own
// shell already has), and whether the run's model can see images — and from then on the sidecar
// is bound.
//
// First call wins and every later one is refused (409): the pod's network namespace is shared
// with the agent's shell and any service container, and a second configure that could swap the
// token would let any of them take the browser over from the runner. A body that does not parse
// does NOT spend the shot — a refusal changes nothing, so the runner may retry with a good one.

import { z } from "@zod/zod";

/** Always bypassed, whatever the runner sends: the agent's dev server is on localhost. */
export const ALWAYS_BYPASS = ["localhost", "127.0.0.1", "::1"] as const;

const ProxySchema = z.object({
  server: z.string().min(1).max(2048),
  username: z.string().max(1024).optional(),
  password: z.string().max(4096).optional(),
  bypass: z.string().max(16 * 1024).optional(),
});

export const ConfigureSchema = z.object({
  // A token short enough to guess is not a token: the runner mints 32 random bytes.
  token: z.string().min(16).max(1024),
  proxy: ProxySchema.nullable(),
  // Whether the run's model sees images. Absent means it does: the runner that predates the field
  // ran every model with screenshots.
  vision: z.boolean().optional(),
});

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
  /** Comma-separated, Chromium's `--proxy-bypass-list` grammar; always holds ALWAYS_BYPASS. */
  bypass: string;
}

export interface SidecarConfig {
  token: string;
  proxy: ProxyConfig | null;
  /** False when the run's model is text-only: no `screenshot` tool, no advice to take one. */
  vision: boolean;
}

export type ConfigureOutcome =
  | { ok: true; config: SidecarConfig }
  | { ok: false; error: string };

/** A `/configure` body, parsed. Never throws. */
export function parseConfigure(body: string): ConfigureOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, error: "body is not JSON" };
  }
  const parsed = ConfigureSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)
        .join("; "),
    };
  }
  const { token, proxy } = parsed.data;
  const vision = parsed.data.vision ?? true;
  if (proxy === null) return { ok: true, config: { token, proxy: null, vision } };
  return {
    ok: true,
    config: {
      token,
      vision,
      proxy: {
        server: proxy.server,
        ...(proxy.username === undefined ? {} : { username: proxy.username }),
        ...(proxy.password === undefined ? {} : { password: proxy.password }),
        bypass: mergeBypass(proxy.bypass),
      },
    },
  };
}

/**
 * The runner's NO_PROXY list (comma-separated, maybe with spaces) with the loopback names added
 * when it lacks them. Order kept, duplicates dropped.
 */
export function mergeBypass(given: string | undefined): string {
  const entries = (given ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const out: string[] = [];
  for (const entry of [...ALWAYS_BYPASS, ...entries]) {
    if (!out.includes(entry)) out.push(entry);
  }
  return out.join(",");
}

/** The latch itself: `claim` is true exactly once. Synchronous, so two racing calls cannot both win. */
export class OneShot<T> {
  #value: T | null = null;

  get value(): T | null {
    return this.#value;
  }

  claim(value: T): boolean {
    if (this.#value !== null) return false;
    this.#value = value;
    return true;
  }
}

/**
 * How Chromium's sandbox is treated, from `RYPH_BROWSER_SANDBOX` (the orchestrator sets it):
 *
 * - `auto` (unset): try the sandbox, fall back to `--no-sandbox` once with one log line. For a
 *   host nobody has told us about.
 * - `required`: the sandbox or no browser at all. A deployment confined by gVisor, where the
 *   sandbox works, must never quietly run a hostile page without it.
 * - `off`: straight to `--no-sandbox`, for a host known to be runc (docker), where the sandboxed
 *   attempt can only fail.
 */
export type SandboxMode = "auto" | "required" | "off";

export function parseSandboxMode(
  raw: string | undefined,
): { ok: true; mode: SandboxMode } | { ok: false; error: string } {
  if (raw === undefined || raw === "") return { ok: true, mode: "auto" };
  if (raw === "required" || raw === "off") return { ok: true, mode: raw };
  return {
    ok: false,
    error: `RYPH_BROWSER_SANDBOX must be "required" or "off" (or unset), got ${
      JSON.stringify(raw)
    }`,
  };
}
