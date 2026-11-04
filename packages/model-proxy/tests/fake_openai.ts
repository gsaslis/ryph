// A fake of OpenAI's account endpoints for the ChatGPT plan tests: a token endpoint that issues
// and rotates tokens, a revocation endpoint, a JWKS from a key pair generated per fake, and the
// model list — served to the REAL adapter through a stub fetch, so ID token verification runs
// for real and no test ever reaches OpenAI.

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { openAiAccounts } from "../src/adapters/openai/accounts.ts";
import {
  OPENAI_ISSUER,
  OPENAI_JWKS_URL,
  OPENAI_REVOKE_URL,
  OPENAI_TOKEN_URL,
} from "../src/core/chatgpt_plan.ts";
import type { PlanKeys } from "../src/core/plan_keys.ts";
import type { OpenAiAccounts } from "../src/ports/openai_accounts.ts";

export const CLIENT_ID = "oaiapp_test";
export const SUBJECT = "user-sub-1";
export const EMAIL = "person@example.com";
export const MODELS_BODY = {
  models: [
    {
      slug: "gpt-6.1-sol",
      display_name: "GPT-6.1 Sol",
      visibility: "list",
      context_window: 400000,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      input_modalities: ["text", "image"],
    },
    { slug: "gpt-6.1-mini", display_name: "GPT-6.1 mini", visibility: "list" },
    { slug: "internal-only", display_name: "hidden", visibility: "hide" },
  ],
};

export interface FakeOpenAi {
  accounts: OpenAiAccounts;
  /** Every call, in order: `token:authorization_code`, `token:refresh_token`, `revoke`, `jwks`,
   * `models`. */
  calls: string[];
  /** The form bodies the token and revocation endpoints got. */
  forms: URLSearchParams[];
  /** Codes the token endpoint accepts, each with the nonce its ID token must echo. */
  issueCode(code: string, nonce: string): void;
  /** The refresh token currently valid; rotated on every refresh. */
  refreshToken(): string;
  /** Set to make the next refreshes fail: an OAuth code, or `network`, or `5xx`. */
  failRefresh: string | null;
  /** How a coded refresh failure is answered: the OAuth `{"error": code}` at 400 (`oauth`),
   * `{"error":{"code": code}}` at 401 (`nested_401`), `{"code": code}` at 400 (`top_level`), or a
   * 401 that names no code at all (`bare_401`). */
  failRefreshShape: "oauth" | "nested_401" | "top_level" | "bare_401";
  /** How long the token endpoint takes to answer a refresh. */
  refreshDelayMs: number;
  /** Set to make the revocation endpoint answer 503. */
  failRevoke: boolean;
  /** Overrides for the next code exchange's answer. */
  exchange: {
    scope?: string;
    audience?: string;
    nonce?: string;
    subject?: string;
    signWithOtherKey?: boolean;
  };
  /** The access tokens the fake has issued, oldest first. */
  accessTokens: string[];
  /** When set, access tokens are JWTs whose `exp` is this many seconds after issue. */
  accessJwtTtlS: number | null;
  /** Merged into every token response (`undefined` drops a field). */
  grantExtra: Record<string, unknown>;
}

export async function makeFakeOpenAi(opts: { now?: () => Date } = {}): Promise<FakeOpenAi> {
  const now = opts.now ?? (() => new Date());
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

  const codes = new Map<string, string>();
  let currentRefresh = "rt-0";
  let serial = 0;

  const fake: FakeOpenAi = {
    accounts: null as unknown as OpenAiAccounts,
    calls: [],
    forms: [],
    issueCode(code, nonce) {
      codes.set(code, nonce);
    },
    refreshToken: () => currentRefresh,
    failRefresh: null,
    failRefreshShape: "oauth",
    refreshDelayMs: 0,
    failRevoke: false,
    exchange: {},
    accessTokens: [],
    accessJwtTtlS: null,
    grantExtra: {},
  };

  const idToken = async (nonce: string) => {
    const x = fake.exchange;
    return await new SignJWT({
      nonce: x.nonce ?? nonce,
      email: EMAIL,
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(OPENAI_ISSUER)
      .setAudience(x.audience ?? CLIENT_ID)
      .setSubject(x.subject ?? SUBJECT)
      .setIssuedAt(Math.floor(now().getTime() / 1000))
      .setExpirationTime(Math.floor(now().getTime() / 1000) + 3600)
      .sign(x.signWithOtherKey ? other.privateKey : privateKey);
  };

  const grant = async (extra: Record<string, unknown> = {}) => {
    serial += 1;
    const access = fake.accessJwtTtlS === null ? `at-${serial}` : await new SignJWT({ n: serial })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt(Math.floor(now().getTime() / 1000))
      .setExpirationTime(Math.floor(now().getTime() / 1000) + fake.accessJwtTtlS)
      .sign(privateKey);
    currentRefresh = `rt-${serial}`;
    fake.accessTokens.push(access);
    return Response.json({
      access_token: access,
      refresh_token: currentRefresh,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
      ...fake.grantExtra,
      ...extra,
    });
  };

  const stub = async (input: URL | Request | string, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request
      ? new Request(input, init)
      : new Request(String(input), init);
    const url = req.url;
    if (url === OPENAI_JWKS_URL) {
      fake.calls.push("jwks");
      return Response.json({ keys: [jwk] });
    }
    if (url === "https://api.openai.com/v1/models") {
      fake.calls.push("models");
      const auth = req.headers.get("authorization") ?? "";
      if (!fake.accessTokens.includes(auth.replace("Bearer ", ""))) {
        return new Response("{}", { status: 401 });
      }
      return Response.json(MODELS_BODY);
    }
    const form = new URLSearchParams(await req.text());
    fake.forms.push(form);
    if (url === OPENAI_REVOKE_URL) {
      fake.calls.push("revoke");
      return new Response(null, { status: fake.failRevoke ? 503 : 200 });
    }
    if (url === OPENAI_TOKEN_URL) {
      const type = form.get("grant_type");
      fake.calls.push(`token:${type}`);
      if (type === "authorization_code") {
        const code = form.get("code") ?? "";
        const nonce = codes.get(code);
        if (nonce === undefined) return Response.json({ error: "invalid_grant" }, { status: 400 });
        codes.delete(code);
        const res = await grant({
          id_token: await idToken(nonce),
          ...(fake.exchange.scope === undefined ? {} : { scope: fake.exchange.scope }),
        });
        return res;
      }
      if (type === "refresh_token") {
        // Judged on arrival, as a server would: a sign-in that lands while this one is slow
        // does not make it a reuse.
        const reused = form.get("refresh_token") !== currentRefresh;
        if (fake.refreshDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, fake.refreshDelayMs));
        }
        if (fake.failRefresh === "network") throw new TypeError("connection refused");
        if (fake.failRefresh === "5xx") return new Response("busy", { status: 503 });
        if (fake.failRefresh !== null) {
          const code = fake.failRefresh;
          switch (fake.failRefreshShape) {
            case "oauth":
              return Response.json({ error: code }, { status: 400 });
            case "nested_401":
              return Response.json({
                error: {
                  message: "Your refresh token has already been used",
                  type: "invalid_request_error",
                  code,
                },
              }, { status: 401 });
            case "top_level":
              return Response.json({ code }, { status: 400 });
            case "bare_401":
              return Response.json({ detail: "Unauthorized" }, { status: 401 });
          }
        }
        if (reused) return Response.json({ error: "refresh_token_reused" }, { status: 400 });
        return await grant();
      }
    }
    return new Response("not found", { status: 404 });
  };

  fake.accounts = openAiAccounts({ fetch: stub as typeof fetch, now });
  return fake;
}

/** A plan key made the only way one is: a sign-in, finished against the fake. */
export async function signInPlanKey(
  plan: PlanKeys,
  fake: FakeOpenAi,
  start: { label?: string } = {},
): Promise<string> {
  const started = await plan.startSignIn(start);
  if (!started.ok) throw new Error(started.error);
  const authorize = new URL(started.authorizeUrl);
  const code = `code-${crypto.randomUUID()}`;
  fake.issueCode(code, authorize.searchParams.get("nonce")!);
  const done = await plan.completeSignIn(
    new URLSearchParams({
      code,
      state: authorize.searchParams.get("state")!,
      client_id: CLIENT_ID,
    }),
  );
  if (!done.ok) throw new Error(done.error);
  return done.keyId;
}
