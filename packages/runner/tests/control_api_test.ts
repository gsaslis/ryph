// The inbound control API: the runner's one driving adapter. Its contract is narrow — an
// authenticated POST /cancel trips a wired signal, and NOTHING else does. These tests pin that: the
// auth matrix, the routing, and that the one side effect is a single abort of the same kind of
// AbortController main.ts hands run() as its cancelSignal.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { startControlApi } from "../src/adapters/control/http.ts";
import { makeRunControl } from "../src/main.ts";
import type { RunControl } from "../src/ports/run_control.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";

const TOKEN = "control-token-abc";

function makeApi(control: RunControl) {
  return startControlApi(control, {
    token: TOKEN,
    port: 0, // OS-assigned free port
    hostname: "127.0.0.1",
    diag: noopDiagnostics(),
  });
}

test("control api: an authenticated POST /cancel aborts the wired signal (202)", async () => {
  const cancel = new AbortController();
  let calls = 0;
  const api = await makeApi({
    requestCancel: () => {
      calls++;
      cancel.abort();
    },
  });
  try {
    const res = await fetch(`${api.url}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await res.body?.cancel();
    assertEquals(res.status, 202);
    assertEquals(calls, 1);
    assert(cancel.signal.aborted, "the wired cancel signal must be tripped");
  } finally {
    await api.shutdown();
  }
});

test("control api: a missing or wrong token is refused and fires nothing (401)", async () => {
  let calls = 0;
  const api = await makeApi({ requestCancel: () => calls++ });
  try {
    const missing = await fetch(`${api.url}/cancel`, { method: "POST" });
    await missing.body?.cancel();
    assertEquals(missing.status, 401);

    const wrong = await fetch(`${api.url}/cancel`, {
      method: "POST",
      headers: { authorization: "Bearer not-the-token" },
    });
    await wrong.body?.cancel();
    assertEquals(wrong.status, 401);

    // An unauthenticated caller learns nothing: a wrong path or method is still 401, never the
    // 404/405 that would reveal which routes exist — auth is decided before routing.
    const wrongPath = await fetch(`${api.url}/anything`, { method: "POST" });
    await wrongPath.body?.cancel();
    assertEquals(wrongPath.status, 401);

    const wrongMethod = await fetch(`${api.url}/cancel`, { method: "GET" });
    await wrongMethod.body?.cancel();
    assertEquals(wrongMethod.status, 401);

    assertEquals(calls, 0, "an unauthenticated caller must change nothing");
  } finally {
    await api.shutdown();
  }
});

test("control wiring: requestCancel aborts the very controller main hands run() as cancelSignal", () => {
  // main() builds the RunControl over `cancelController` and passes `cancelController.signal` to
  // run() as its cancelSignal. This pins that link — the piece a composition root otherwise leaves
  // untested: a POST /cancel must abort the same controller the core is watching, or a real cancel
  // is a no-op.
  const cancelController = new AbortController();
  const control = makeRunControl(cancelController, noopDiagnostics(), "wi-test-0001");
  assert(!cancelController.signal.aborted);
  control.requestCancel();
  assert(cancelController.signal.aborted, "requestCancel must abort the run's cancel controller");
  control.requestCancel(); // idempotent: asking twice is asking once
  assert(cancelController.signal.aborted);
});

test("control api: only POST /cancel is a cancel; other routes are inert", async () => {
  let calls = 0;
  const api = await makeApi({ requestCancel: () => calls++ });
  try {
    // right path, wrong method
    const get = await fetch(`${api.url}/cancel`, {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await get.body?.cancel();
    assertEquals(get.status, 405);

    // wrong path, even authenticated
    const other = await fetch(`${api.url}/anything`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await other.body?.cancel();
    assertEquals(other.status, 404);

    assertEquals(calls, 0);
  } finally {
    await api.shutdown();
  }
});

test("control api: shutdown stops listening", async () => {
  const api = await makeApi({ requestCancel: () => {} });
  const url = `${api.url}/cancel`;
  await api.shutdown();
  // The port is closed: a follow-up request can no longer connect.
  await assertRejects(() =>
    fetch(url, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })
  );
});
