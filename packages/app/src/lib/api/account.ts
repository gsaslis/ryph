import { z } from "zod";
import { apiCall } from "./call";
import {
  type ApiToken,
  apiTokenSchema,
  type Session,
  sessionSchema,
  type User,
  userSchema,
} from "./types";

// The signed-in user's own account: profile, password, sessions, and the way out.

/** `currentPassword` is required whenever the account already has one. */
export async function changePassword(
  f = fetch,
  input: { currentPassword: string | null; newPassword: string },
): Promise<void> {
  await apiCall(f, "/v1/auth/password", {
    method: "POST",
    body: JSON.stringify({
      ...(input.currentPassword === null ? {} : { currentPassword: input.currentPassword }),
      newPassword: input.newPassword,
    }),
  });
}

export async function listSessions(
  f = fetch,
): Promise<{ sessions: Session[]; current: string }> {
  return z.object({ sessions: z.array(sessionSchema), current: z.string() }).parse(
    await apiCall(f, "/v1/auth/sessions"),
  );
}

export async function revokeSession(f = fetch, id: string): Promise<void> {
  await apiCall(f, `/v1/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Ends every session, this one included; the caller signs out afterwards. */
export async function revokeAllSessions(f = fetch): Promise<void> {
  await apiCall(f, "/v1/auth/sessions/revoke-all", { method: "POST" });
}

export async function listApiTokens(f = fetch): Promise<ApiToken[]> {
  return z.object({ tokens: z.array(apiTokenSchema) }).parse(await apiCall(f, "/v1/auth/tokens"))
    .tokens;
}

/** Mints a token. The secret comes back once, here; the page shows it and never sees it again. */
export async function createApiToken(
  f = fetch,
  input: { name: string; caps: string[]; expiresInDays: number },
): Promise<{ token: string; summary: ApiToken }> {
  return z.object({ token: z.string(), summary: apiTokenSchema }).parse(
    await apiCall(f, "/v1/auth/tokens", { method: "POST", body: JSON.stringify(input) }),
  );
}

export async function revokeApiToken(f = fetch, id: string): Promise<void> {
  await apiCall(f, `/v1/auth/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Changes the signed-in user's name, and on a single-user instance their address. */
export async function updateProfile(
  f = fetch,
  input: { name?: string; email?: string },
): Promise<User> {
  return userSchema.parse(
    await apiCall(f, "/v1/auth/me", { method: "PATCH", body: JSON.stringify(input) }),
  );
}

/** Refused (409) for the last admin. */
export async function deleteOwnAccount(f = fetch, id: string): Promise<void> {
  await apiCall(f, `/v1/auth/users/${encodeURIComponent(id)}`, { method: "DELETE" });
}
