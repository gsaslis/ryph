import { describe, expect, it } from "vitest";
import { MAX_AUTH_BODY_BYTES, readAuthBody } from "./request-body";

function request(size: number, declared?: string): Request {
  const body = new TextEncoder().encode("{}" + " ".repeat(size - 2));
  return new Request(
    "http://localhost/auth/login",
    {
      method: "POST",
      headers: declared === undefined ? {} : { "content-length": declared },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" },
  );
}

describe("auth request bodies", () => {
  it("accepts the exact byte limit", async () => {
    expect(await readAuthBody(request(MAX_AUTH_BODY_BYTES))).toEqual({});
  });

  it.each([undefined, "1", String(MAX_AUTH_BODY_BYTES + 1)])(
    "rejects one extra byte with declared length %s",
    async (declared) => {
      await expect(readAuthBody(request(MAX_AUTH_BODY_BYTES + 1, declared))).rejects.toMatchObject({
        status: 413,
        body: { message: `request body exceeds ${MAX_AUTH_BODY_BYTES} byte limit` },
      });
    },
  );

  it("leaves broken streams to the route's validation", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("disconnected"));
      },
    });
    const req = new Request(
      "http://localhost",
      {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    expect(await readAuthBody(req)).toBeNull();
  });

  it("leaves malformed JSON to the route's validation", async () => {
    expect(await readAuthBody(new Request("http://localhost", { method: "POST", body: "{" })))
      .toBeNull();
  });
});
