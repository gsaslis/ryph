import { z } from "zod";
import { apiCall } from "./call";

// Signing in with a ChatGPT account, on the model proxy's control listener beside the provider
// keys and admin-gated like registering one. A sign-in is the only way a plan key comes into
// being: the proxy hands back an address to open, and its local listener catches the browser's
// return and finishes it. Only a deployment on the person's own machine offers this.

/** Where a person manages their plan's usage and each app's access to it, disconnecting one
 * included, as OpenAI's guidelines for this feature name it ("Accounts and sessions"). */
export const CHATGPT_MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";

/** Where OpenAI's sign-in lives. The app opens only an address there, whatever it is handed. */
const OPENAI_AUTH_ORIGIN = "https://auth.openai.com";

/** Whether an address is on OpenAI's sign-in host, over https. */
export function isOpenAiSignInUrl(value: string): boolean {
  try {
    return new URL(value).origin === OPENAI_AUTH_ORIGIN &&
      value.startsWith(`${OPENAI_AUTH_ORIGIN}/`);
  } catch {
    return false;
  }
}

export const signInSchema = z.object({
  id: z.string(),
  authorizeUrl: z.string().refine(isOpenAiSignInUrl, "The sign-in address is not OpenAI's."),
  expiresAt: z.string(),
});
export type SignIn = z.infer<typeof signInSchema>;

export const signInStatusSchema = z.object({
  status: z.enum(["pending", "done", "failed", "expired"]),
  keyId: z.string().optional(),
  error: z.string().optional(),
});
export type SignInStatus = z.infer<typeof signInStatusSchema>;

export type StartSignInInput = {
  label?: string;
  /** Signs an existing plan key in again: same key, status back to active. */
  keyId?: string;
};

export async function startSignIn(f = fetch, input: StartSignInInput = {}): Promise<SignIn> {
  return signInSchema.parse(
    await apiCall(f, "/v1/chatgpt-plan/sign-ins", { method: "POST", body: JSON.stringify(input) }),
  );
}

export async function getSignInStatus(f = fetch, id: string): Promise<SignInStatus> {
  return signInStatusSchema.parse(
    await apiCall(f, `/v1/chatgpt-plan/sign-ins/${encodeURIComponent(id)}`),
  );
}

/** Refetches the models a plan key's account can use. */
export async function refreshPlanModels(f = fetch, keyId: string): Promise<string[]> {
  return z.object({ models: z.array(z.string()) }).parse(
    await apiCall(f, `/v1/provider-keys/${encodeURIComponent(keyId)}/chatgpt-plan/models`, {
      method: "POST",
    }),
  ).models;
}
