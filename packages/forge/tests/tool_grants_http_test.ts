// The forge ↔ orchestrator ledger wire, checked against the orchestrator's OWN schemas. Every other
// forge test fakes `ToolGrants` at the port, so a field renamed on one side of this wire and not
// the other passes them all — and live, every successful write then fails to settle (a 400 the
// forge only logs), its row stays `reserved`, and a run's `comment: "minimal"` is never honoured.
//
// Reaching into `../../orchestrator` is deliberate: this is a cross-package contract test, and a
// copy of the schema here would drift exactly the way the wire did.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { serve } from "@ryph/service";
import {
  ForgeToolActionCompleteSchema,
  ForgeToolActionReserveSchema,
} from "../../orchestrator/src/schema.ts";
import { httpToolGrants } from "../src/adapters/tool_grants/http.ts";
import type { ActionOutcome } from "../src/ports/tool_grants.ts";
import { silentDiagnostics } from "./util.ts";

const RUN = "r-0123456789";

/** An orchestrator stand-in that answers exactly as the real routes do: 400 on a body its schema
 * refuses. Records what it accepted. */
async function withOrchestrator(
  body: (grants: ReturnType<typeof httpToolGrants>, accepted: unknown[]) => Promise<void>,
) {
  const accepted: unknown[] = [];
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
    const json = await req.json();
    if (path === "/v1/forge/tool-actions") {
      const parsed = ForgeToolActionReserveSchema.safeParse(json);
      if (!parsed.success) return Response.json({ error: "bad reserve" }, { status: 400 });
      accepted.push(parsed.data);
      return Response.json({ actionId: "fa-0123456789" }, { status: 201 });
    }
    if (path.startsWith("/v1/forge/tool-actions/")) {
      const parsed = ForgeToolActionCompleteSchema.safeParse(json);
      if (!parsed.success) return Response.json({ error: "bad complete" }, { status: 400 });
      accepted.push(parsed.data);
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  });
  try {
    const grants = httpToolGrants({
      orchestratorUrl: `http://127.0.0.1:${server.addr.port}`,
      forgeToken: "t",
      diag: silentDiagnostics(),
    });
    await body(grants, accepted);
  } finally {
    await server.shutdown();
  }
}

test("a reserve is a body the orchestrator accepts", async () => {
  await withOrchestrator(async (grants, accepted) => {
    const outcome = await grants.reserve({
      runId: RUN,
      tool: "submit_review",
      connectedRepoId: "cr-0123456789",
      threadRef: "828",
    });
    assertEquals(outcome, { kind: "reserved", actionId: "fa-0123456789" });
    assertEquals(accepted.length, 1);
  });
});

test("every settle outcome is a body the orchestrator accepts", async () => {
  const outcomes: ActionOutcome[] = [
    { outcome: "done", url: "https://github.com/acme/api/pull/828", createdThreadRef: null },
    { outcome: "done", url: "https://github.com/acme/api/issues/77", createdThreadRef: "77" },
    // A Radicle deployment with no explorer has no web address for what was written.
    { outcome: "done", url: "", createdThreadRef: null },
    { outcome: "failed", detail: "GitHub answered 502" },
  ];
  await withOrchestrator(async (grants, accepted) => {
    for (const outcome of outcomes) {
      // Throws on anything but a 2xx — the live failure was exactly this throwing on a 400.
      await grants.complete("fa-0123456789", RUN, outcome);
    }
    assertEquals(accepted, outcomes.map((outcome) => ({ runId: RUN, ...outcome })));
  });
});
