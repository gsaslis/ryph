// The credential half of the register and rotate dialogs: three auth kinds, and the one input that
// is not a single string — a header map — typed as lines the operator can read back.

import type { McpCredentialInput } from "$lib/api/mcp-servers";
import type { McpAuthKind } from "$lib/api/types";

/**
 * A header map from `Name: value` lines, one header per line; blank lines are skipped. The first
 * colon splits, so a value may itself contain colons (a URL, a `Bearer x:y` token). Returns the
 * line that failed, in the operator's words, rather than a partial map.
 */
export function parseHeaderLines(
  text: string,
): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  const headers: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return { ok: false, error: `"${line}" is not a "Name: value" header` };
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (value === "") return { ok: false, error: `header "${name}" has no value` };
    headers[name] = value;
  }
  if (Object.keys(headers).length === 0) return { ok: false, error: "provide at least one header" };
  return { ok: true, headers };
}

/**
 * The dialog's three fields as the API's credential, or the reason they are not one yet. `none`
 * needs nothing; `bearer` needs the secret; `headers` needs at least one parseable line.
 */
export function composeCredential(
  auth: McpAuthKind,
  secret: string,
  headerLines: string,
): { ok: true; credential: McpCredentialInput } | { ok: false; error: string } {
  switch (auth) {
    case "none":
      return { ok: true, credential: { auth: "none" } };
    case "bearer": {
      const trimmed = secret.trim();
      if (trimmed === "") return { ok: false, error: "Paste the bearer token" };
      return { ok: true, credential: { auth: "bearer", secret: trimmed } };
    }
    case "headers": {
      const parsed = parseHeaderLines(headerLines);
      if (!parsed.ok) return parsed;
      return { ok: true, credential: { auth: "headers", headers: parsed.headers } };
    }
  }
}

export const AUTH_KIND_LABEL: Record<McpAuthKind, string> = {
  none: "No credential (public server)",
  bearer: "Bearer token",
  headers: "Custom headers",
};
