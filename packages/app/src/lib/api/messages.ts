import { z } from "zod";
import { apiCall } from "./call";
import { type RunMessage, runMessageSchema } from "./types";

/**
 * Says something to a running agent: the run page's message box. The message lands in the
 * run's inbox and the agent reads it as untrusted text from a named person — it can steer the
 * run already in flight, never dispatch new work. A terminal run refuses (409).
 *
 * `attachmentIds` are images already uploaded to this run (api/attachments.ts), in the order
 * the agent is shown them. With images the text may be empty.
 */
export async function postRunMessage(
  f = fetch,
  runId: string,
  text: string,
  attachmentIds: readonly string[] = [],
): Promise<RunMessage> {
  const res = await apiCall(f, `/v1/runs/${encodeURIComponent(runId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, attachmentIds }),
  });
  return z.object({ message: runMessageSchema }).parse(res).message;
}
