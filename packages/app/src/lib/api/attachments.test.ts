import { afterEach, describe, expect, it, vi } from "vitest";

// The refresh a 401 triggers, stubbed: the real one posts to /auth/refresh.
const refresh = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("$lib/utils/auth/auth", () => ({
  refreshSession: () => Promise.resolve(refresh.user),
}));

import {
  attachmentProblem,
  attachmentUrl,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  uploadAttachment,
  type UploadTransport,
} from "./attachments";
import { ApiError } from "./call";
// The control plane's source as text: importing it would pull in its workspace imports,
// which this package's bundler does not resolve.
import controlPlaneSource from "../../../../orchestrator/src/core/attachments.ts?raw";

// The composer's side of an image upload: the checks it makes before sending anything (the
// control plane makes them again, from the bytes), and how an answer, a refusal and an expired
// session come back.

afterEach(() => {
  refresh.user = null;
});

/** A transport answering the given sequence, recording what it was asked. */
function transport(...answers: { status: number; body: unknown }[]) {
  const calls: { path: string; type: string }[] = [];
  const send: UploadTransport = (path, body) => {
    calls.push({ path, type: body.type });
    return Promise.resolve(answers[Math.min(calls.length - 1, answers.length - 1)]);
  };
  return { send, calls };
}

const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });

/** A constant of the control plane's attachments core: a product of integer literals. */
function controlPlaneConstant(name: string): number {
  const match = controlPlaneSource.match(new RegExp(`export const ${name} = ([\\d\\s*]+);`));
  if (!match) throw new Error(`${name} is not a plain product in the control plane's source`);
  return match[1].split("*").reduce((product, factor) => product * Number(factor.trim()), 1);
}

describe("the restated caps", () => {
  it("match the control plane's", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(controlPlaneConstant("MAX_ATTACHMENT_BYTES"));
    expect(MAX_ATTACHMENTS).toBe(controlPlaneConstant("MAX_ATTACHMENTS"));
  });
});

describe("attachmentProblem", () => {
  it("takes the four image types under the cap", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(attachmentProblem({ name: "a", type, size: 10 }), type).toBeNull();
    }
    expect(attachmentProblem({ name: "a", type: "image/png", size: MAX_ATTACHMENT_BYTES }))
      .toBeNull();
  });

  it("refuses anything else, an empty file, and one over 5 MiB, naming the file", () => {
    expect(attachmentProblem({ name: "logo.svg", type: "image/svg+xml", size: 10 }))
      .toBe("logo.svg is not a PNG, JPEG, GIF or WebP image");
    expect(attachmentProblem({ name: "notes.txt", type: "", size: 10 })).toContain("notes.txt");
    expect(attachmentProblem({ name: "a.png", type: "image/png", size: 0 })).toBe("a.png is empty");
    expect(
      attachmentProblem({ name: "big.png", type: "image/png", size: MAX_ATTACHMENT_BYTES + 1 }),
    )
      .toBe("big.png is larger than 5 MiB");
  });

  it("names a pasted file, which comes with no name, as the image", () => {
    expect(attachmentProblem({ name: "", type: "image/tiff", size: 1 }))
      .toBe("The image is not a PNG, JPEG, GIF or WebP image");
  });
});

describe("uploadAttachment", () => {
  it("posts the raw file to the run and reads the stored attachment back", async () => {
    const t = transport({ status: 201, body: { id: "a-1", mime: "image/png", bytes: 4 } });
    await expect(uploadAttachment("run 1", png, {}, t.send))
      .resolves.toEqual({ id: "a-1", mime: "image/png", bytes: 4 });
    expect(t.calls).toEqual([{ path: "/api/v1/runs/run%201/attachments", type: "image/png" }]);
  });

  it("throws the control plane's own words for a refusal", async () => {
    const t = transport({ status: 415, body: { error: "not a PNG, JPEG, GIF or WebP image" } });
    const failed = await uploadAttachment("r-1", png, {}, t.send).catch((e) => e);
    expect(failed).toBeInstanceOf(ApiError);
    expect(failed.status).toBe(415);
    expect(failed.message).toBe("not a PNG, JPEG, GIF or WebP image");
  });

  it("says what failed when the answer was not JSON", async () => {
    const t = transport({ status: 502, body: null });
    await expect(uploadAttachment("r-1", png, {}, t.send)).rejects.toThrow("request failed (502)");
  });

  it("refreshes an expired session once and uploads again", async () => {
    refresh.user = { id: "u-1" };
    const t = transport(
      { status: 401, body: { error: "unauthorized" } },
      { status: 201, body: { id: "a-2", mime: "image/png", bytes: 4 } },
    );
    await expect(uploadAttachment("r-1", png, {}, t.send)).resolves.toMatchObject({ id: "a-2" });
    expect(t.calls).toHaveLength(2);
  });

  it("gives up on a 401 the refresh could not fix", async () => {
    const t = transport({ status: 401, body: { error: "unauthorized" } });
    await expect(uploadAttachment("r-1", png, {}, t.send)).rejects.toThrow("unauthorized");
    expect(t.calls).toHaveLength(1);
  });
});

describe("attachmentUrl", () => {
  it("reads through the app's proxy, each segment encoded", () => {
    expect(attachmentUrl("r-1", "a/1")).toBe("/api/v1/runs/r-1/attachments/a%2F1");
  });
});
