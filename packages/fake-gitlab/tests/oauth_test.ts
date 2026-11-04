// The OAuth application flow ryph's sign-in uses: authorize (auto-approved for the configured
// user) with PKCE, then the token exchange, then `/user` with a `read_user` token.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { s256 } from "../src/mod.ts";
import { seeded } from "./util.ts";

const REDIRECT = "https://ryph.example/gitlab/callback";

async function authorize(base: string, params: Record<string, string>) {
  const res = await fetch(`${base}/oauth/authorize?${new URLSearchParams(params)}`, {
    redirect: "manual",
  });
  return res;
}

test("authorize → code → token with PKCE → /user", async () => {
  await using fake = await seeded();
  fake.oauthApp({ clientId: "cid", clientSecret: "csecret", redirectUris: [REDIRECT] });
  fake.signInAs("maya");
  const verifier = "v".repeat(64);
  const res = await authorize(fake.url, {
    client_id: "cid",
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "read_user",
    state: "st8",
    code_challenge: s256(verifier),
    code_challenge_method: "S256",
  });
  assertEquals(res.status, 302);
  const back = new URL(res.headers.get("location")!);
  assertEquals([back.origin + back.pathname, back.searchParams.get("state")], [REDIRECT, "st8"]);
  const code = back.searchParams.get("code")!;

  const exchange = (body: Record<string, string>) =>
    fetch(`${fake.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  const base = {
    grant_type: "authorization_code",
    client_id: "cid",
    client_secret: "csecret",
    redirect_uri: REDIRECT,
  };
  const tokenRes = await exchange({ ...base, code, code_verifier: verifier });
  assertEquals(tokenRes.status, 200);
  const t = await tokenRes.json();
  assertEquals([t.token_type, t.scope, typeof t.expires_in], ["Bearer", "read_user", "number"]);
  const me = await (await fetch(`${fake.apiUrl}/user`, {
    headers: { authorization: `Bearer ${t.access_token}` },
  })).json();
  assertEquals([me.username, me.email], ["maya", "maya@example.com"]);
  const emails = await (await fetch(`${fake.apiUrl}/user/emails`, {
    headers: { authorization: `Bearer ${t.access_token}` },
  })).json();
  assert(emails[0].confirmed_at);
  // read_user reaches nothing else.
  const projects = await fetch(`${fake.apiUrl}/projects`, {
    headers: { authorization: `Bearer ${t.access_token}` },
  });
  assertEquals(projects.status, 403);
  // Nor does it read a personal access token's own record.
  const self = await fetch(`${fake.apiUrl}/personal_access_tokens/self`, {
    headers: { authorization: `Bearer ${t.access_token}` },
  });
  assertEquals(self.status, 403);

  // The code is single-use.
  const replay = await exchange({ ...base, code, code_verifier: verifier });
  assertEquals([replay.status, (await replay.json()).error], [400, "invalid_grant"]);
});

test("refusals: wrong verifier, wrong redirect_uri, wrong secret, unknown client, nobody signed in", async () => {
  await using fake = await seeded();
  fake.oauthApp({ clientId: "cid", clientSecret: "csecret", redirectUris: [REDIRECT] });
  const params = {
    client_id: "cid",
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "read_user",
    code_challenge: s256("right"),
    code_challenge_method: "S256",
  };
  assertEquals((await authorize(fake.url, params)).status, 401);
  fake.signInAs("dev");
  const codeOf = async () =>
    new URL((await authorize(fake.url, params)).headers.get("location")!).searchParams.get("code")!;
  const exchange = async (body: Record<string, string>) => {
    const r = await fetch(`${fake.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: "cid",
        client_secret: "csecret",
        redirect_uri: REDIRECT,
        ...body,
      }),
    });
    return [r.status, (await r.json()).error];
  };
  assertEquals(await exchange({ code: await codeOf(), code_verifier: "wrong" }), [
    400,
    "invalid_grant",
  ]);
  assertEquals(await exchange({ code: await codeOf() }), [400, "invalid_request"]);
  assertEquals(
    await exchange({
      code: await codeOf(),
      code_verifier: "right",
      redirect_uri: "https://evil.example/cb",
    }),
    [400, "invalid_grant"],
  );
  assertEquals(
    await exchange({ code: await codeOf(), code_verifier: "right", client_secret: "nope" }),
    [401, "invalid_client"],
  );
  assertEquals((await authorize(fake.url, { ...params, client_id: "other" })).status, 401);
  assertEquals(
    (await authorize(fake.url, { ...params, redirect_uri: "https://evil.example/cb" })).status,
    400,
  );
  const scoped = await authorize(fake.url, { ...params, scope: "api" });
  assertEquals(new URL(scoped.headers.get("location")!).searchParams.get("error"), "invalid_scope");
  // Basic client authentication works as well as body parameters.
  const r = await fetch(`${fake.url}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa("cid:csecret")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: await codeOf(),
      redirect_uri: REDIRECT,
      code_verifier: "right",
    }),
  });
  assertEquals(r.status, 200);
});
