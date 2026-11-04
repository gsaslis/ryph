import type { Role } from "$lib/utils/auth/capabilities";
import { z } from "zod";
import { apiCall } from "./call";
import {
  type AuthSettings,
  authSettingsSchema,
  type Invite,
  inviteSchema,
  type User,
  userSchema,
} from "./types";

// The admin's surface: every call here answers 403 to a plain user, so pages only offer these
// controls to admins.

export async function listUsers(f = fetch): Promise<User[]> {
  return z.object({ users: z.array(userSchema) }).parse(await apiCall(f, "/v1/auth/users")).users;
}

export async function updateUser(
  f = fetch,
  id: string,
  patch: { role?: Role; status?: "active" | "deactivated" },
): Promise<User> {
  return userSchema.parse(
    await apiCall(f, `/v1/auth/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteUser(f = fetch, id: string): Promise<void> {
  await apiCall(f, `/v1/auth/users/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export type CreateInviteInput = {
  email: string | null;
  role: Role;
  expiresInDays: number;
  maxUses: number | null;
};

/** Mints an invite. The token comes back once; the page turns it into a link and shows it. */
export async function createInvite(
  f = fetch,
  input: CreateInviteInput,
): Promise<{ invite: Invite; token: string }> {
  return z.object({ invite: inviteSchema, token: z.string() }).parse(
    await apiCall(f, "/v1/auth/invites", { method: "POST", body: JSON.stringify(input) }),
  );
}

export async function listInvites(f = fetch): Promise<Invite[]> {
  return z.object({ invites: z.array(inviteSchema) }).parse(await apiCall(f, "/v1/auth/invites"))
    .invites;
}

export async function revokeInvite(f = fetch, id: string): Promise<void> {
  await apiCall(f, `/v1/auth/invites/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** A one-time link for the user, minted now and shown once — the instance keeps no copy. */
async function mintLink(f: typeof fetch, id: string, kind: "reset-link" | "verify-link") {
  return z.object({ link: z.string() }).parse(
    await apiCall(f, `/v1/auth/users/${encodeURIComponent(id)}/${kind}`, { method: "POST" }),
  ).link;
}

export const mintResetLink = (f = fetch, id: string) => mintLink(f, id, "reset-link");
export const mintVerificationLink = (f = fetch, id: string) => mintLink(f, id, "verify-link");

/** Users whose "forgot password" nobody could mail, oldest first. */
export async function listResetRequests(f = fetch): Promise<User[]> {
  return z.object({ users: z.array(userSchema) }).parse(
    await apiCall(f, "/v1/auth/password/pending"),
  ).users;
}

export async function updateAuthSettings(
  f = fetch,
  patch: Partial<Pick<AuthSettings, "allowOpenRegistration" | "allowForgeOrgJoin">>,
): Promise<AuthSettings> {
  return authSettingsSchema.parse(
    await apiCall(f, "/v1/auth/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  );
}
