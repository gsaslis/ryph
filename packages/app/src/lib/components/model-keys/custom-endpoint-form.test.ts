import { describe, expect, it } from "vitest";
import {
  baseUrlProblem,
  composeCreateBody,
  composeExtraHeaders,
  composeModels,
  composeUpdateBody,
  emptyModelRow,
  endpointFormFor,
  type EndpointFormState,
  endpointShape,
  endpointShapeChanged,
  newEndpointForm,
  slugProblem,
  withReasoning,
} from "./custom-endpoint-form";
import type { ProviderDetail } from "$lib/api/types";

const modelRow = (over: Partial<ReturnType<typeof emptyModelRow>> = {}) => ({
  ...emptyModelRow(),
  ...over,
});

const form = (over: Partial<EndpointFormState> = {}): EndpointFormState => ({
  ...newEndpointForm(),
  id: "groq",
  label: "Groq",
  baseUrl: "https://api.groq.com/openai/v1",
  models: [modelRow({ id: "llama-3.3-70b" })],
  ...over,
});

describe("slugProblem", () => {
  it("takes a lowercase slug", () => {
    expect(slugProblem("workers-ai")).toBeNull();
  });

  it("refuses shapes the harness argv cannot carry", () => {
    expect(slugProblem("Workers AI")).toMatch(/lowercase/);
    expect(slugProblem("-leading")).toMatch(/lowercase/);
    expect(slugProblem("")).toMatch(/slug/);
  });
});

describe("baseUrlProblem", () => {
  it("takes an https URL with a path — the path is the point", () => {
    expect(baseUrlProblem("https://api.cloudflare.com/client/v4/accounts/abc/ai/v1")).toBeNull();
  });

  it("refuses what the proxy would drop or leak", () => {
    expect(baseUrlProblem("https://x.test/v1?key=abc")).toMatch(/query string/);
    expect(baseUrlProblem("https://x.test/v1#frag")).toMatch(/fragment/);
    expect(baseUrlProblem("https://user:pw@x.test/v1")).toMatch(/credentials/);
    expect(baseUrlProblem("ftp://x.test/v1")).toMatch(/http/);
    expect(baseUrlProblem("api.groq.com")).toMatch(/not a URL/);
  });
});

describe("composeModels", () => {
  it("drops fields the admin left unset so the harness's own defaults apply, but says reasoning", () => {
    const composed = composeModels([modelRow({ id: "m1" })]);
    expect(composed).toEqual({ ok: true, models: [{ id: "m1", reasoning: false }] });
  });

  it("carries the declared numbers, flags and prices", () => {
    const composed = composeModels([
      modelRow({
        id: "m1",
        label: "Big",
        contextWindow: "128000",
        maxOutputTokens: "16384",
        reasoning: true,
        vision: true,
        inputPrice: "0.5",
        outputPrice: "1.5",
        cacheReadPrice: "0",
        cacheWritePrice: "0",
      }),
    ]);
    expect(composed).toEqual({
      ok: true,
      models: [{
        id: "m1",
        label: "Big",
        contextWindow: 128000,
        maxOutputTokens: 16384,
        reasoning: true,
        vision: true,
        price: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
      }],
    });
  });

  it("sends a reasoning model's levels in pi's order, and only off for one that does not reason", () => {
    expect(composeModels([
      modelRow({ id: "m1", reasoning: true, thinkingLevels: ["high", "off", "low"] }),
    ])).toEqual({
      ok: true,
      models: [{ id: "m1", reasoning: true, thinkingLevels: ["off", "low", "high"] }],
    });
    expect(composeModels([modelRow({ id: "m1", reasoning: true })])).toEqual({
      ok: true,
      models: [{ id: "m1", reasoning: true }],
    });
    expect(composeModels([modelRow({ id: "m1", thinkingLevels: ["off", "high"] })])).toEqual({
      ok: true,
      models: [{ id: "m1", reasoning: false, thinkingLevels: ["off"] }],
    });
  });

  it("ignores an untouched spare row but not a half-typed one", () => {
    expect(composeModels([modelRow({ id: "m1" }), modelRow()])).toEqual({
      ok: true,
      models: [{ id: "m1", reasoning: false }],
    });
    expect(composeModels([modelRow({ id: "m1" }), modelRow({ contextWindow: "1000" })]))
      .toEqual({ ok: false, error: "Every model needs an id" });
  });

  it("refuses a partly priced model rather than pricing runs wrongly", () => {
    expect(composeModels([modelRow({ id: "m1", inputPrice: "1", outputPrice: "2" })]))
      .toEqual({ ok: false, error: expect.stringContaining("all four prices or none") });
  });

  it("refuses duplicates, junk numbers and an empty declaration", () => {
    expect(composeModels([modelRow({ id: "m" }), modelRow({ id: "m" })]))
      .toEqual({ ok: false, error: '"m" is declared twice' });
    expect(composeModels([modelRow({ id: "m", contextWindow: "lots" })]))
      .toEqual({ ok: false, error: expect.stringContaining("whole number") });
    expect(composeModels([])).toEqual({
      ok: false,
      error: expect.stringContaining("at least one model"),
    });
  });
});

describe("composeExtraHeaders", () => {
  it("lowercases names and skips blank rows", () => {
    expect(composeExtraHeaders([{ name: "X-Tenant", value: "acme" }, { name: "", value: "" }]))
      .toEqual({ ok: true, headers: { "x-tenant": "acme" } });
  });

  it("refuses a half-filled or repeated row", () => {
    expect(composeExtraHeaders([{ name: "x", value: "" }]))
      .toEqual({ ok: false, error: 'Header "x" has no value' });
    expect(composeExtraHeaders([{ name: "x", value: "1" }, { name: "X", value: "2" }]))
      .toEqual({ ok: false, error: '"X" is set twice' });
  });

  // Legal RFC 9110 tokens that every object already answers to. Accumulated in an object
  // literal, `constructor` collides with nothing and `__proto__` is eaten by the setter.
  it("stores header names that are also Object.prototype members", () => {
    const composed = composeExtraHeaders([
      { name: "Constructor", value: "1" },
      { name: "toString", value: "2" },
      { name: "__proto__", value: "3" },
    ]);
    expect(composed).toMatchObject({ ok: true });
    if (!composed.ok) return;
    expect(Object.entries(composed.headers)).toEqual([
      ["constructor", "1"],
      ["tostring", "2"],
      ["__proto__", "3"],
    ]);
    expect(Object.getPrototypeOf(composed.headers)).toBe(Object.prototype);
  });

  it("still catches a real repeat of one of those names", () => {
    expect(composeExtraHeaders([{ name: "constructor", value: "1" }, {
      name: "Constructor",
      value: "2",
    }])).toEqual({ ok: false, error: '"Constructor" is set twice' });
  });
});

describe("composeCreateBody", () => {
  it("composes the registration, defaulting to a bearer authorization header", () => {
    const composed = composeCreateBody(form(), []);
    expect(composed).toEqual({
      ok: true,
      body: {
        id: "groq",
        label: "Groq",
        baseUrl: "https://api.groq.com/openai/v1",
        authHeader: "authorization",
        authScheme: "Bearer",
        extraHeaders: {},
        models: [{ id: "llama-3.3-70b", reasoning: false }],
      },
    });
  });

  it("sends a null scheme for an Azure-style bare-value header", () => {
    const composed = composeCreateBody(form({ authHeader: "api-key", authScheme: "" }), []);
    expect(composed).toMatchObject({ body: { authHeader: "api-key", authScheme: null } });
  });

  it("refuses a slug already registered before the operator retypes the models", () => {
    expect(composeCreateBody(form(), [{ id: "groq", builtin: false }]))
      .toEqual({ ok: false, error: '"groq" is already registered' });
  });

  it("names a built-in for what it is — the built-in would win the lookup", () => {
    expect(composeCreateBody(form({ id: "openai" }), [{ id: "openai", builtin: true }]))
      .toEqual({ ok: false, error: '"openai" is a built-in provider' });
  });

  it("does not mistake an inherited name for a static header shadowing the credential", () => {
    const composed = composeCreateBody(
      form({ authHeader: "toString", headers: [{ name: "x-org", value: "acme" }] }),
      [],
    );
    expect(composed).toMatchObject({ body: { authHeader: "tostring" } });
  });

  it("refuses a static header that shadows the credential header", () => {
    const composed = composeCreateBody(
      form({ headers: [{ name: "Authorization", value: "Bearer nope" }] }),
      [],
    );
    expect(composed).toEqual({
      ok: false,
      error: expect.stringContaining("carries the credential"),
    });
  });
});

describe("composeUpdateBody", () => {
  const provider: ProviderDetail = {
    id: "groq",
    label: "Groq",
    dialect: "openai-completions",
    builtin: false,
    baseUrl: "https://api.groq.com/openai/v1",
    authHeader: "api-key",
    authScheme: null,
    extraHeaders: { "x-org": "acme" },
    models: [{ id: "llama-3.3-70b", contextWindow: 128000 }],
    archivedAt: null,
  };

  it("loads an endpoint back into the form in full — the detail read returns the headers", () => {
    const loaded = endpointFormFor(provider);
    expect(loaded.authHeader).toBe("api-key");
    // A null scheme is the form's empty string: "the header carries the bare value".
    expect(loaded.authScheme).toBe("");
    expect(loaded.headers).toEqual([{ name: "x-org", value: "acme" }]);
    expect(loaded.models[0]).toMatchObject({ id: "llama-3.3-70b", contextWindow: "128000" });
  });

  it("sends everything the form holds, because the form holds what is stored", () => {
    expect(composeUpdateBody(endpointFormFor(provider))).toEqual({
      ok: true,
      body: {
        label: "Groq",
        baseUrl: "https://api.groq.com/openai/v1",
        authHeader: "api-key",
        authScheme: null,
        extraHeaders: { "x-org": "acme" },
        models: [{ id: "llama-3.3-70b", contextWindow: 128000, reasoning: false }],
      },
    });
  });

  it("loads a model declared with levels but no reasoning flag as reasoning, and keeps them", () => {
    const levelled: ProviderDetail = {
      ...provider,
      models: [
        { id: "thinks", thinkingLevels: ["off", "low", "high"] },
        { id: "plain", thinkingLevels: ["off"] },
        { id: "said-not", reasoning: false, thinkingLevels: ["off"] },
      ],
    };
    const loaded = endpointFormFor(levelled);
    expect(loaded.models.map((m) => m.reasoning)).toEqual([true, false, false]);
    expect(composeUpdateBody(loaded)).toMatchObject({
      body: {
        models: [
          { id: "thinks", reasoning: true, thinkingLevels: ["off", "low", "high"] },
          { id: "plain", reasoning: false, thinkingLevels: ["off"] },
          { id: "said-not", reasoning: false, thinkingLevels: ["off"] },
        ],
      },
    });
  });

  it("saves a model whose levels were left unsaid with none, not the ones pi gives it", () => {
    const unsaid: ProviderDetail = {
      ...provider,
      models: [{ id: "thinks", reasoning: true }, { id: "plain" }],
    };
    const loaded = endpointFormFor(unsaid);
    expect(loaded.models.map((m) => m.thinkingLevels)).toEqual([[], []]);
    const composed = composeUpdateBody(loaded);
    expect(composed.ok && composed.body.models).toEqual([
      { id: "thinks", reasoning: true },
      { id: "plain", reasoning: false },
    ]);
  });

  it("keeps every stored model field, compat included, through an edit of only the label", () => {
    const declared: ProviderDetail = {
      ...provider,
      models: [{
        id: "qwq",
        label: "QwQ",
        contextWindow: 131072,
        maxOutputTokens: 32768,
        reasoning: true,
        vision: true,
        thinkingLevels: ["off", "low", "medium", "high"],
        compat: { thinkingFormat: "qwen", supportsReasoningEffort: true },
        price: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.3 },
      }],
    };
    const composed = composeUpdateBody({ ...endpointFormFor(declared), label: "Qwen" });
    expect(composed).toMatchObject({ ok: true, body: { label: "Qwen" } });
    expect(composed.ok && composed.body.models).toEqual(declared.models);
  });

  it("carries an edit to the credential header, and an emptied header list clears the map", () => {
    const state = { ...endpointFormFor(provider), authScheme: "Bearer", headers: [] };
    expect(composeUpdateBody({ ...state, authHeader: "authorization" })).toMatchObject({
      body: { authHeader: "authorization", authScheme: "Bearer", extraHeaders: {} },
    });
  });
});

describe("withReasoning", () => {
  it("switches reasoning, and switched off drops the levels it no longer shows", () => {
    const row = modelRow({ id: "m1", reasoning: true, thinkingLevels: ["low", "high"] });
    expect(withReasoning(row, false)).toMatchObject({ reasoning: false, thinkingLevels: [] });
    expect(withReasoning(row, true)).toMatchObject({
      reasoning: true,
      thinkingLevels: ["low", "high"],
    });
    expect(row.reasoning).toBe(true); // the row itself is left alone
  });

  it("switched on, drops a lone off so the model is not pinned to never thinking", () => {
    const loaded = endpointFormFor({
      id: "groq",
      label: "Groq",
      dialect: "openai-completions",
      builtin: false,
      baseUrl: "https://api.groq.com/openai/v1",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {},
      models: [{ id: "m1", reasoning: false, thinkingLevels: ["off"] }],
      archivedAt: null,
    }).models[0];
    const ticked = withReasoning(loaded, true);
    expect(ticked).toMatchObject({ reasoning: true, thinkingLevels: [] });
    expect(composeModels([ticked])).toEqual({
      ok: true,
      models: [{ id: "m1", reasoning: true }],
    });
    // Off among others is a choice, and stays.
    const row = modelRow({ id: "m2", thinkingLevels: ["off", "high"] });
    expect(withReasoning(row, true).thinkingLevels).toEqual(["off", "high"]);
  });
});

describe("endpointShapeChanged", () => {
  const stored = {
    baseUrl: "https://api.groq.com/openai/v1",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: { "x-org": "acme", "x-team": "core" },
  };
  const form = (over: Partial<EndpointFormState> = {}): EndpointFormState => ({
    ...newEndpointForm(),
    baseUrl: stored.baseUrl,
    authHeader: "authorization",
    authScheme: "Bearer",
    headers: [{ name: "x-org", value: "acme" }, { name: "x-team", value: "core" }],
    ...over,
  });

  it("does not count the stored shape, whatever its case, order or padding", () => {
    expect(endpointShapeChanged(stored, form())).toBe(false);
    expect(endpointShapeChanged(
      stored,
      form({
        baseUrl: `  ${stored.baseUrl} `,
        authHeader: " Authorization",
        authScheme: " Bearer ",
        headers: [
          { name: "", value: "" },
          { name: "X-Team", value: " core" },
          { name: "X-ORG ", value: "acme  " },
        ],
      }),
    )).toBe(false);
    // A row stored by the API in its own case reads the same as the form's lower-cased one.
    expect(endpointShapeChanged(
      {
        ...stored,
        authHeader: "Authorization",
        extraHeaders: { "X-Team": "core", "X-Org": "acme" },
      },
      form(),
    )).toBe(false);
  });

  it("an empty scheme is no scheme", () => {
    expect(endpointShape({ ...stored, authScheme: null })).toBe(
      endpointShape({ ...stored, authScheme: "  " }),
    );
    expect(endpointShapeChanged({ ...stored, authScheme: null }, form({ authScheme: "" }))).toBe(
      false,
    );
  });

  it("sees a new address, credential header, scheme or static header", () => {
    expect(endpointShapeChanged(stored, form({ baseUrl: "https://api.groq.com/openai/v2" })))
      .toBe(true);
    expect(endpointShapeChanged(stored, form({ authHeader: "api-key" }))).toBe(true);
    expect(endpointShapeChanged(stored, form({ authScheme: "" }))).toBe(true);
    expect(endpointShapeChanged(stored, form({ authScheme: "bearer" }))).toBe(true);
    expect(endpointShapeChanged(stored, form({ headers: [{ name: "x-org", value: "acme" }] })))
      .toBe(true);
    expect(endpointShapeChanged(
      stored,
      form({ headers: [{ name: "x-org", value: "ACME" }, { name: "x-team", value: "core" }] }),
    )).toBe(true);
  });
});
