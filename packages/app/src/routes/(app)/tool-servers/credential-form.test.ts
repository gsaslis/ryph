import { describe, expect, it } from "vitest";
import { composeCredential, parseHeaderLines } from "./credential-form";

describe("parseHeaderLines", () => {
  it("reads one header per line, splitting on the first colon", () => {
    expect(parseHeaderLines("X-Api-Key: abc\n\nAuthorization: Basic a:b:c\n")).toEqual({
      ok: true,
      headers: { "X-Api-Key": "abc", Authorization: "Basic a:b:c" },
    });
  });

  it("names the line that is not a header", () => {
    expect(parseHeaderLines("X-Api-Key abc")).toEqual({
      ok: false,
      error: '"X-Api-Key abc" is not a "Name: value" header',
    });
    expect(parseHeaderLines(": abc")).toMatchObject({ ok: false });
    expect(parseHeaderLines("X-Api-Key:")).toEqual({
      ok: false,
      error: 'header "X-Api-Key" has no value',
    });
  });

  it("refuses an empty map", () => {
    expect(parseHeaderLines("\n  \n")).toEqual({ ok: false, error: "provide at least one header" });
  });
});

describe("composeCredential", () => {
  it("shapes each auth kind for the wire", () => {
    expect(composeCredential("none", "ignored", "ignored")).toEqual({
      ok: true,
      credential: { auth: "none" },
    });
    expect(composeCredential("bearer", "  lin_api_x  ", "")).toEqual({
      ok: true,
      credential: { auth: "bearer", secret: "lin_api_x" },
    });
    expect(composeCredential("headers", "", "X-Api-Key: k")).toEqual({
      ok: true,
      credential: { auth: "headers", headers: { "X-Api-Key": "k" } },
    });
  });

  it("asks for what is missing", () => {
    expect(composeCredential("bearer", "   ", "")).toEqual({
      ok: false,
      error: "Paste the bearer token",
    });
    expect(composeCredential("headers", "", "")).toMatchObject({ ok: false });
  });
});
