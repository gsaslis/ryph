/**
 * An OpenAI-compatible model endpoint for the playground's custom provider. The proxy meters what
 * it answers, so every scripted turn leaves a real usage row; the content never matters, since
 * the transcript is the script's. Fast, unlike perf/mock_model.ts: seeding makes hundreds of calls.
 */

import { serve } from "@ryph/service";

function usage() {
  const prompt = 6_000 + Math.floor(Math.random() * 40_000);
  return {
    prompt_tokens: prompt,
    completion_tokens: 80 + Math.floor(Math.random() * 1_200),
    prompt_tokens_details: { cached_tokens: Math.floor(prompt * 0.75) },
  };
}

const chunk = (id: string, model: string, rest: Record<string, unknown>) =>
  `data: ${
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      ...rest,
    })
  }\n\n`;

export async function serveMockModel(port: number): Promise<{ stop(): Promise<void> }> {
  const server = await serve({ port, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    const body = (await req.json().catch(() => null)) ?? {};
    const model = typeof body.model === "string" ? body.model : "playground-large";
    const id = `chatcmpl-${crypto.randomUUID()}`;
    if (body.stream !== true) {
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
    const parts = [
      chunk(id, model, { choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }),
      chunk(id, model, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    ];
    if (body.stream_options?.include_usage === true) {
      parts.push(chunk(id, model, { choices: [], usage: usage() }));
    }
    parts.push("data: [DONE]\n\n");
    return new Response(parts.join(""), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  });
  return { stop: () => server.shutdown() };
}
