// Signing in to a single-user `ryph up` without a password: a one-time login link, opened in the
// browser.
//
// `up` opens one as it starts. `ryph login` asks the running control plane for a fresh one, for
// a session that expired or a browser that was closed. It proves it may ask with a secret `up`
// mints on every launch into a file only this user can read — the same boundary as the master
// key beside it, since whoever reads ~/.ryph already holds the database. The link itself is
// single-use, short-lived and stored only as a digest.

import { mkdir, readFile } from "node:fs/promises";
import { writeSecretFile } from "@ryph/service";
import { command } from "@ryph/process";
import { join } from "@std/path";
import { mintHexKey } from "./secrets_key.ts";
import { ryphHome } from "./config_file.ts";

/** Where `up` leaves the secret `ryph login` presents; null without a home to put it in. */
export function loginSecretPath(home: string | null = ryphHome()): string | null {
  return home === null ? null : join(home, "login.secret");
}

/** This launch's secret, held in memory until the launch has proven it is the one running. */
export function mintLoginSecret(): string {
  return mintHexKey();
}

/**
 * Writes this launch's secret owner-only, replacing the last launch's. `up` calls it only once
 * its listeners are bound: a second `up` started by mistake fails on the ports or the database
 * lock first, and must not leave the running instance's `ryph login` holding a secret it never
 * accepted.
 */
export async function writeLoginSecret(
  secret: string,
  path: string | null = loginSecretPath(),
): Promise<void> {
  if (path === null) return;
  await mkdir(join(path, ".."), { recursive: true });
  await writeSecretFile(path, `${secret}\n`);
}

export type LoginLinkResult =
  | { ok: true; link: string }
  | { ok: false; reason: string };

/**
 * A fresh login link from the control plane at `apiUrl`. Every failure is a sentence for the
 * person at the terminal: what is wrong and what to do.
 */
export async function requestLoginLink(
  apiUrl: string,
  path: string | null = loginSecretPath(),
  fetcher: typeof fetch = fetch,
): Promise<LoginLinkResult> {
  if (path === null) return { ok: false, reason: "no home directory, so no ~/.ryph to read" };
  let secret: string;
  try {
    secret = (await readFile(path, "utf8")).trim();
  } catch {
    return { ok: false, reason: `${path} is not there — is \`ryph up\` running?` };
  }
  let res: Response;
  try {
    res = await fetcher(`${apiUrl}/v1/auth/local/login-link`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
  } catch {
    return { ok: false, reason: `nothing answers at ${apiUrl} — is \`ryph up\` running?` };
  }
  const body = await res.json().catch(() => null);
  if (res.ok && typeof body?.link === "string") return { ok: true, link: body.link };
  const error = typeof body?.error === "string" ? body.error : null;
  // The route answers 401 for a secret it does not hold: the file is a launch older than the
  // one running, or another instance's.
  if (res.status === 401) {
    return {
      ok: false,
      reason: "the running ryph did not accept this machine's login secret. Restart `ryph up`.",
    };
  }
  // A 404 is one of two things. The route's own ("no owner who can sign in") says so in its
  // body; the router's bare "not found" means there is no such route — a control plane that
  // was not started by `ryph up` (`bun run up`, ./dev), which prints its link at boot instead.
  if (res.status === 404 && (error === null || error === "not found")) {
    return {
      ok: false,
      reason: `the control plane at ${apiUrl} has no \`ryph login\` — it was not started by ` +
        "`ryph up`. Use the login link it printed at boot, or restart it for a fresh one.",
    };
  }
  return { ok: false, reason: error ?? `the control plane answered ${res.status}` };
}

/** Opens a URL in the default browser, where this platform has a command for it. Started and
 * left to run, never waited on: `xdg-open` with no desktop can hold until the browser it fell
 * back to closes. Quiet either way: the link is printed beside it, so a browser that does not
 * open costs a copy and paste. True when the command started. */
export async function openInBrowser(url: string, os: string = process.platform): Promise<boolean> {
  const opener = os === "darwin" ? "open" : os === "linux" ? "xdg-open" : null;
  if (opener === null) return false;
  try {
    const child = await command(opener, {
      args: [url],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    child.unref();
    child.status.catch(() => {});
    return true;
  } catch {
    return false;
  }
}
