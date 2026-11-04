// Both live feeds held open past Bun's fetch idle timeout, which the test shortens for this
// process (`BUN_CONFIG_HTTP_IDLE_TIMEOUT`, read once at startup, so it takes a process of its
// own). The historian stand-in answers only once a body ends, as the real one does; the sidecar
// stand-in sends its snapshot and then nothing, as a quiet browser does. The commands uplink sends
// a line every half second, since bytes going up do not count as activity to that timeout.
// Prints what each side saw, as JSON, after `HOLD_MS`.

import { serve } from "@ryph/service";
import { startCommandsUplink } from "../../src/adapters/background/uplink.ts";
import { startLiveRelay } from "../../src/adapters/browser/relay.ts";
import type { Diagnostics } from "../../src/ports/diagnostics.ts";

const HOLD_MS = Number(process.env.HOLD_MS ?? "10000");

const sessions: Record<string, number> = {};
const historian = await serve(
  { port: 0, hostname: "127.0.0.1", onListen: () => {} },
  async (req) => {
    const path = new URL(req.url).pathname;
    sessions[path] = (sessions[path] ?? 0) + 1;
    try {
      const reader = req.body!.getReader();
      while (!(await reader.read()).done) {
        // read to the end, answering only then
      }
    } catch {
      // the uplink was cut
    }
    return new Response(null, { status: 200 });
  },
);
const sidecar = await serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"snapshot"}\n'));
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
});

const events: string[] = [];
const diag: Diagnostics = {
  debug: (event) => void events.push(event),
  warn: (event) => void events.push(event),
};
const base = `http://127.0.0.1:${historian.addr.port}`;
const uplink = startCommandsUplink({ url: `${base}/commands`, runToken: "t", diag });
uplink.open(() => []);
const ticker = setInterval(
  () => uplink.send({ type: "output", at: new Date().toISOString(), id: "bg-1", text: "tick" }),
  500,
);
startLiveRelay({
  source: { url: `http://127.0.0.1:${sidecar.addr.port}/live`, token: "s" },
  sink: { url: `${base}/browser`, runToken: "t" },
  diag,
});

await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
clearInterval(ticker);
console.log(JSON.stringify({ sessions, events }));
process.exit(0);
