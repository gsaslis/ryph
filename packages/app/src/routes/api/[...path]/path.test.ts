import { describe, expect, it } from "vitest";
import {
  forwardedResponseHeaders,
  isAppRoutePath,
  isForwardablePath,
  isHistoryReadPath,
} from "./path";

// The proxy picks a service by matching the path, and `new URL()` then resolves that same path.
// Anything the two could read differently is refused before either of them gets a say.

describe("isForwardablePath", () => {
  it("forwards an ordinary API path", () => {
    expect(isForwardablePath("v1/tasks")).toBe(true);
    expect(isForwardablePath("v1/model-usage/runs/r-1")).toBe(true);
    expect(isForwardablePath("v1/runs/r-1/events/stream")).toBe(true);
  });

  it("refuses anything outside v1", () => {
    expect(isForwardablePath("internal/keys")).toBe(false);
    expect(isForwardablePath("")).toBe(false);
    expect(isForwardablePath("v2/tasks")).toBe(false);
  });

  it("refuses relative segments, which the URL parser collapses after the service is chosen", () => {
    // Routed as the model-proxy's (it matches the usage pattern), resolved as another path.
    expect(isForwardablePath("v1/model-usage/../../v1/provider-keys")).toBe(false);
    expect(isForwardablePath("v1/./tasks")).toBe(false);
    expect(isForwardablePath("v1/tasks/..")).toBe(false);
    // A dot INSIDE a segment is an ordinary character and stays allowed.
    expect(isForwardablePath("v1/tasks/t.1")).toBe(true);
  });

  it("refuses encoded separators, which the URL parser does NOT decode", () => {
    expect(isForwardablePath("v1/mcp-usage/a%2fb")).toBe(false);
    expect(isForwardablePath("v1/mcp-usage/a%2Fb")).toBe(false);
    expect(isForwardablePath("v1/tasks%5Cx")).toBe(false);
    expect(isForwardablePath("v1/tasks\\x")).toBe(false);
  });
});

describe("forwardedResponseHeaders", () => {
  it("keeps a raw log inert: nosniff and the sandbox policy reach the browser", () => {
    const out = forwardedResponseHeaders(
      new Headers({
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "cache-control": "no-store",
        "set-cookie": "upstream=1",
      }),
    );
    expect(out.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(out.get("x-content-type-options")).toBe("nosniff");
    expect(out.get("content-security-policy")).toBe("sandbox");
    expect(out.get("cache-control")).toBe("no-store");
    expect(out.get("set-cookie")).toBeNull();
  });

  it("serves a run's image as the control plane named it: inert, private, inline", () => {
    const out = forwardedResponseHeaders(
      new Headers({
        "content-type": "image/png",
        "content-length": "1234",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "content-disposition": 'inline; filename="a-1.png"',
        "cache-control": "private, no-cache",
      }),
    );
    expect(out.get("content-type")).toBe("image/png");
    expect(out.get("x-content-type-options")).toBe("nosniff");
    expect(out.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(out.get("content-disposition")).toBe('inline; filename="a-1.png"');
    expect(out.get("cache-control")).toBe("private, no-cache");
  });

  it("answers JSON when the upstream named no type, and adds nothing it did not send", () => {
    const out = forwardedResponseHeaders(new Headers());
    expect([...out.keys()]).toEqual(["content-type"]);
    expect(out.get("content-type")).toBe("application/json");
  });
});

describe("isHistoryReadPath", () => {
  it("sends a run's transcript reads and its live browser stream to the historian", () => {
    expect(isHistoryReadPath("v1/runs/r-1/events")).toBe(true);
    expect(isHistoryReadPath("v1/runs/r-1/events/stream")).toBe(true);
    expect(isHistoryReadPath("v1/runs/r-1/live/stream")).toBe(true);
    expect(isHistoryReadPath("v1/runs/r-1/live/commands/stream")).toBe(true);
  });

  it("sends a run's subagent listing to the historian", () => {
    expect(isHistoryReadPath("v1/runs/r-1/lanes")).toBe(true);
    expect(isHistoryReadPath("v1/runs/r-1/lanes/stream")).toBe(true);
    expect(isHistoryReadPath("v1/runs/r-1/lanes/stream/x")).toBe(false);
    expect(isHistoryReadPath("v1/runs/r-1/lanes/sa-1")).toBe(false);
    expect(isHistoryReadPath("v1/runs/r-1/lanes/")).toBe(false);
    expect(isHistoryReadPath("v1/runs/lanes")).toBe(false);
  });

  it("leaves everything else on the control plane", () => {
    expect(isHistoryReadPath("v1/runs/r-1/live")).toBe(false);
    expect(isHistoryReadPath("v1/runs/r-1")).toBe(false);
    expect(isHistoryReadPath("v1/runs/r-1/live/stream/x")).toBe(false);
    expect(isHistoryReadPath("v1/runs/r-1/live/commands")).toBe(false);
    expect(isHistoryReadPath("v1/runs/r-1/background")).toBe(false);
  });
});

describe("isAppRoutePath", () => {
  it("keeps artifact content and installation settings to the app's own routes", () => {
    expect(isAppRoutePath("v1/artifacts/a-1/versions/2/content")).toBe(true);
    expect(isAppRoutePath("v1/connected-repos/cr-1/installation-settings")).toBe(true);
    expect(isAppRoutePath("v1/connected-repos/cr-1/installation-settings/")).toBe(true);
  });

  it("forwards everything beside them", () => {
    expect(isAppRoutePath("v1/artifacts/a-1/versions/2")).toBe(false);
    expect(isAppRoutePath("v1/connected-repos/cr-1")).toBe(false);
    expect(isAppRoutePath("v1/connected-repos/cr-1/radicle")).toBe(false);
  });
});
