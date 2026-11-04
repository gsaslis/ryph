import { z } from "zod";
import { apiCall, ApiError } from "./call";
import {
  type AuthSettings,
  authSettingsSchema,
  type InvitePreview,
  invitePreviewSchema,
  type User,
  userSchema,
} from "./types";

/**
 * Whether this instance still has no users, so the next registration would bootstrap the first
 * admin.
 *
 * Unauthenticated, because the surface that needs it is the login page — which has to decide
 * whether to offer a "create the admin account" link at all. Offering one on an instance that
 * already has an admin produces a form whose only possible answer is "unauthorized", which reads
 * as "your details are wrong" rather than "someone already claimed this instance".
 */
export async function needsBootstrap(f = fetch): Promise<boolean> {
  const res = await apiCall(f, "/v1/auth/bootstrap");
  return z.object({ needsBootstrap: z.boolean() }).parse(res).needsBootstrap;
}

/** The signed-in user as the control plane holds them — fresher than the token's claims. */
export async function getMe(f = fetch): Promise<User> {
  return userSchema.parse(await apiCall(f, "/v1/auth/me"));
}

/** The registration gates. Unauthenticated: the sign-in page decides what to offer from them. */
export async function getAuthSettings(f = fetch): Promise<AuthSettings> {
  return authSettingsSchema.parse(await apiCall(f, "/v1/auth/settings", {}, false));
}

/** What an invite link admits, or null for a link nobody minted. */
export async function previewInvite(f = fetch, token: string): Promise<InvitePreview | null> {
  try {
    return invitePreviewSchema.parse(
      await apiCall(f, `/v1/auth/invites/${encodeURIComponent(token)}`, {}, false),
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
