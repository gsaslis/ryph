import { readCapped } from "@ryph/shared/http";
import { error } from "@sveltejs/kit";

/** Auth forms and passkey assertions are small; never buffer the app's upload-sized limit. */
export const MAX_AUTH_BODY_BYTES = 256 * 1024;

export async function readAuthBody(request: Request): Promise<unknown> {
  let text: string | null;
  try {
    text = await readCapped(request, MAX_AUTH_BODY_BYTES);
  } catch {
    return null;
  }
  if (text === null) error(413, `request body exceeds ${MAX_AUTH_BODY_BYTES} byte limit`);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
