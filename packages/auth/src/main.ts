// The STANDALONE composition root — the proof that the service boundary is real.
//
// NEITHER deployment runs this. Auth is mounted in both: @ryph/host calls setup() for the
// single process, and @ryph/orchestrator does the same for the networked control plane, which
// is defined as orchestrator plus auth. Running this alongside one of them would put a second
// holder of the signing key on the same table, which is a race, not a topology.
//
// It stays because it is the extraction, already written: when auth outgrows being mounted (own
// scaling, own team, an SSO gateway), this file is the whole move — same core, same routes, own
// port and database. It would need what every other service here has first: health probes and a
// bounded drain from @ryph/service.

import { multiUserFromEnv, setup, setupTokenNotice } from "./setup.ts";
import { drizzleAuthStore } from "./adapters/store/drizzle.ts";
import { makeAuthDb } from "./adapters/store/db/db.ts";
import { serve } from "@ryph/service";
import { makeRouter } from "@ryph/shared/http";

export async function main(): Promise<void> {
  // Read before the database opens: a bad RYPH_MULTIUSER is a usage error, not a crash.
  let multiUser: boolean;
  try {
    multiUser = multiUserFromEnv((name) => process.env[name], true);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const port = Number(process.env.RYPH_AUTH_PORT ?? "7412");
  // A ryph database URL (see @ryph/db): pglite:<path>, pglite:memory:// or postgres://…
  const dbUrl = process.env.RYPH_DB ?? "pglite:./data/auth";
  const store = drizzleAuthStore(await makeAuthDb(dbUrl));

  // Multi-user (the default here) refuses to start without RYPH_PROXY_SECRET; setup says why.
  const { routes, setupToken } = await setup({
    store,
    now: () => new Date(),
    multiUser,
    proxySecret: process.env.RYPH_PROXY_SECRET || null,
  }).catch((err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
  // The shared wording: deploy/compose-networked/setup_token.ts finds the token by it. No app URL
  // is configured here, so the notice points at the /register page rather than a link.
  if (setupToken !== null) console.error(`ryph auth: ${setupTokenNotice(setupToken, null)}`);

  await serve({ port }, makeRouter(routes));
  console.error(`ryph auth listening on http://localhost:${port}`);
}

if (import.meta.main) {
  await main();
}
