// An OpenAI-compatible model endpoint that thinks about nothing, for the perf harness.
//
// It answers `POST /v1/chat/completions` the way a real provider does from the proxy's point of
// view: a wait before the first byte, then a stream of chunks over a few seconds, then a usage
// block (streamed only when the caller asked with `stream_options.include_usage`, as the real
// API does). The token counts are plausible for an agent turn with a growing context, so the
// rows the proxy meters look like production rows. Nothing about the content matters.
//
// Latency comes from MOCK_TTFT_MS and MOCK_STREAM_MS, each jittered ±50%, so a burst of calls
// does not finish in lockstep.

import { createServer } from "node:http";

const port = Number(process.env.MOCK_PORT ?? 8080);
const ttftMs = Number(process.env.MOCK_TTFT_MS ?? 800);
const streamMs = Number(process.env.MOCK_STREAM_MS ?? 2000);

let served = 0;
let inFlight = 0;

const jitter = (ms: number) => Math.max(0, Math.round(ms * (0.5 + Math.random())));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function usage() {
  const prompt = 8_000 + Math.floor(Math.random() * 60_000);
  const cached = Math.floor(prompt * 0.8);
  return {
    prompt_tokens: prompt,
    completion_tokens: 50 + Math.floor(Math.random() * 1_500),
    prompt_tokens_details: { cached_tokens: cached },
  };
}

function chunk(id: string, model: string, delta: Record<string, unknown>, extra = {}) {
  return `data: ${
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
      ...extra,
    })
  }\n\n`;
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/healthz") return new Response("ok");
  if (url.pathname === "/stats") return Response.json({ served, inFlight });
  if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
    return new Response("not found", { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const model = typeof body.model === "string" ? body.model : "mock-1";
  const id = `chatcmpl-${crypto.randomUUID()}`;
  inFlight++;
  served++;

  if (body.stream !== true) {
    await sleep(jitter(ttftMs + streamMs));
    inFlight--;
    return Response.json({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      }],
      usage: usage(),
    });
  }

  const wantsUsage = body.stream_options?.include_usage === true;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await sleep(jitter(ttftMs));
        controller.enqueue(enc.encode(chunk(id, model, { role: "assistant", content: "" })));
        const pieces = 20;
        const each = jitter(streamMs) / pieces;
        for (let i = 0; i < pieces; i++) {
          await sleep(each);
          controller.enqueue(enc.encode(chunk(id, model, { content: "lorem ipsum dolor " })));
        }
        controller.enqueue(enc.encode(
          `data: ${
            JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })
          }\n\n`,
        ));
        if (wantsUsage) {
          controller.enqueue(enc.encode(
            `data: ${
              JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [],
                usage: usage(),
              })
            }\n\n`,
          ));
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      } catch {
        // The caller hung up; nothing to tell it.
      } finally {
        inFlight--;
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

// Its own small node:http adapter rather than @ryph/service's serve: the container mounts this one
// file and nothing of the workspace.
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
  const response = await handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.flushHeaders();
  if (response.body === null) return void res.end();
  const reader = response.body.getReader();
  res.on("close", () => void reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    res.end();
  }
}).listen(port, "0.0.0.0");
