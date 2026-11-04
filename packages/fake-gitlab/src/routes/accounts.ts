// Who is who: `/version`, `/user`, `/users`, `/personal_access_tokens/self`, group membership,
// and the OAuth application flow (`/oauth/authorize`, auto-approving the configured user, and
// `/oauth/token` with PKCE), as Doorkeeper on GitLab answers them.

import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "../errors.ts";
import { foldParams, int, json, notFound, paginate, type Router, str, tokenOf } from "../http.ts";
import type { Instance } from "../instance.ts";
import { signedIn } from "./common.ts";

export function accountRoutes(r: Router) {
  r.add("GET", "/version", (ctx) => {
    signedIn(ctx);
    return json({ version: ctx.gl.version, revision: ctx.gl.revision, kas: { enabled: false } });
  }, "user");

  r.add("GET", "/metadata", (ctx) => {
    signedIn(ctx);
    return json({ version: ctx.gl.version, revision: ctx.gl.revision, enterprise: false });
  }, "user");

  r.add("GET", "/user", (ctx) => json(ctx.gl.present.currentUser(signedIn(ctx))), "user");

  r.add("GET", "/user/emails", (ctx) => {
    const u = signedIn(ctx);
    return json([{ id: u.id, email: u.email, confirmed_at: u.createdAt }]);
  }, "user");

  r.add("GET", "/users", (ctx) => {
    const username = str(ctx.input.username);
    const all = [...ctx.gl.world.users.values()];
    const hits = username === null
      ? all
      : all.filter((u) => u.username.toLowerCase() === username.toLowerCase());
    return paginate(ctx, hits, (u) => ctx.gl.present.user(u));
  }, "user");

  r.add("GET", "/users/:user_id", (ctx) => {
    const id = int(ctx.params.user_id);
    const u = id === null ? null : ctx.gl.world.users.get(id);
    if (!u) return notFound("User");
    return json({ ...ctx.gl.present.user(u), bot: u.bot, created_at: u.createdAt });
  }, "user");

  // An OAuth token gets GitLab 17.11's 400 here.
  r.add("GET", "/personal_access_tokens/self", (ctx) => {
    signedIn(ctx);
    if (!ctx.token || ctx.token.kind !== "personal") {
      return json({
        message:
          "400 Bad request - This endpoint requires token type to be a personal access token",
      }, 400);
    }
    return json(ctx.gl.present.token(ctx.token));
  });

  r.add("GET", "/groups/:id", (ctx) => {
    const g = ctx.gl.world.groupByPath(ctx.params.id!) ??
      ctx.gl.world.groups.get(Number(ctx.params.id)) ?? null;
    if (!g || !ctx.gl.world.canSeeGroup(ctx.user, g)) return notFound("Group");
    return json(ctx.gl.present.group(g));
  });

  r.add("GET", "/groups/:id/members/all/:user_id", (ctx) => {
    const g = ctx.gl.world.groupByPath(ctx.params.id!) ??
      ctx.gl.world.groups.get(Number(ctx.params.id)) ?? null;
    if (!g || !ctx.gl.world.canSeeGroup(ctx.user, g)) return notFound("Group");
    const u = ctx.gl.world.users.get(Number(ctx.params.user_id));
    const held = u ? ctx.gl.world.memberRecord(u, { kind: "group", group: g }) : null;
    if (!u || held === null) return notFound("Member");
    return json(ctx.gl.present.member(u, held.level, held.state));
  });
}

const INVALID_GRANT = {
  error: "invalid_grant",
  error_description:
    "The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.",
};
const INVALID_CLIENT = {
  error: "invalid_client",
  error_description:
    "Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method.",
};

/** `GET /oauth/authorize` and `POST /oauth/token`; null for any other path. */
export async function oauth(
  gl: Instance,
  req: Request,
  path: string,
  url: URL,
): Promise<Response | null> {
  if (path === "/oauth/authorize" && req.method === "GET") return authorize(gl, url);
  if (path === "/oauth/token" && req.method === "POST") return await token(gl, req, url);
  if (path === "/oauth/userinfo" && req.method === "GET") {
    const who = gl.authenticate(tokenOf(req) ?? "");
    if (!who) return json({ error: "invalid_token" }, 401);
    return json({
      sub: String(who.user.id),
      nickname: who.user.username,
      name: who.user.name,
      email: who.user.email,
    });
  }
  return null;
}

/** Signs the configured user in and approves at once: the fake's browser has already said yes. */
function authorize(gl: Instance, url: URL): Response {
  const q = url.searchParams;
  const app = gl.world.oauthApps.find((a) => a.clientId === q.get("client_id"));
  if (!app) {
    return new Response("Client authentication failed due to unknown client.", { status: 401 });
  }
  const redirectUri = q.get("redirect_uri") ?? "";
  if (!redirectUri || (app.redirectUris.length > 0 && !app.redirectUris.includes(redirectUri))) {
    return new Response("The redirect uri included is not valid.", { status: 400 });
  }
  const back = new URL(redirectUri);
  const state = q.get("state");
  if (state !== null) back.searchParams.set("state", state);
  const scopes = (q.get("scope") ?? app.scopes.join(" ")).split(/[\s+]+/).filter(Boolean);
  if (q.get("response_type") !== "code") {
    back.searchParams.set("error", "unsupported_response_type");
    return Response.redirect(back.toString(), 302);
  }
  if (scopes.some((s) => !app.scopes.includes(s))) {
    back.searchParams.set("error", "invalid_scope");
    return Response.redirect(back.toString(), 302);
  }
  const userId = gl.world.oauthUserId;
  if (userId === null) {
    return new Response("You need to sign in or sign up before continuing.", { status: 401 });
  }
  const method = q.get("code_challenge_method");
  const challenge = q.get("code_challenge");
  if (challenge !== null && method !== null && method !== "S256" && method !== "plain") {
    back.searchParams.set("error", "invalid_request");
    return Response.redirect(back.toString(), 302);
  }
  const code = randomBytes(32).toString("hex");
  gl.world.oauthGrants.set(code, {
    code,
    clientId: app.clientId,
    redirectUri,
    userId,
    scopes,
    codeChallenge: challenge,
    codeChallengeMethod: challenge === null ? null : method ?? "plain",
    expiresAtMs: gl.world.now().getTime() + 600_000,
  });
  back.searchParams.set("code", code);
  return Response.redirect(back.toString(), 302);
}

async function token(gl: Instance, req: Request, url: URL): Promise<Response> {
  const type = req.headers.get("content-type") ?? "";
  const text = await req.text();
  const body = type.includes("application/json")
    ? (JSON.parse(text || "{}") as Record<string, unknown>)
    : foldParams(new URLSearchParams(text).entries());
  const p = { ...foldParams(url.searchParams.entries()), ...body };
  let clientId = str(p.client_id);
  let clientSecret = str(p.client_secret);
  const basic = /^Basic\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (basic) {
    const [id, secret] = atob(basic[1]!).split(":");
    clientId = decodeURIComponent(id ?? "");
    clientSecret = decodeURIComponent(secret ?? "");
  }
  const app = gl.world.oauthApps.find((a) => a.clientId === clientId);
  if (!app || app.clientSecret !== clientSecret) return json(INVALID_CLIENT, 401);
  if (str(p.grant_type) !== "authorization_code") {
    return json({
      error: "unsupported_grant_type",
      error_description:
        "The authorization grant type is not supported by the authorization server.",
    }, 400);
  }
  const code = str(p.code) ?? "";
  const grant = gl.world.oauthGrants.get(code);
  // A code is single-use: a second exchange finds nothing.
  gl.world.oauthGrants.delete(code);
  if (
    !grant || grant.clientId !== app.clientId || grant.expiresAtMs < gl.world.now().getTime() ||
    grant.redirectUri !== str(p.redirect_uri)
  ) return json(INVALID_GRANT, 400);
  if (grant.codeChallenge !== null) {
    const verifier = str(p.code_verifier);
    if (!verifier) {
      return json({
        error: "invalid_request",
        error_description: "Missing required parameter: code_verifier.",
      }, 400);
    }
    const derived = grant.codeChallengeMethod === "S256"
      ? createHash("sha256").update(verifier).digest("base64url")
      : verifier;
    if (derived !== grant.codeChallenge) return json(INVALID_GRANT, 400);
  }
  const user = gl.world.users.get(grant.userId);
  if (!user) throw new ApiError(400, INVALID_GRANT);
  const t = gl.addToken(user, { kind: "oauth", scopes: grant.scopes, expiresAt: null });
  return json({
    access_token: t.token,
    token_type: "Bearer",
    expires_in: 7200,
    refresh_token: randomBytes(32).toString("hex"),
    scope: grant.scopes.join(" "),
    created_at: Math.floor(gl.world.now().getTime() / 1000),
  });
}

/** The verifier's S256 challenge, for tests that drive the flow. */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
