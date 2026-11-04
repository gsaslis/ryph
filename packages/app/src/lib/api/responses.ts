import { z } from "zod";
import { apiCall } from "./call";
import {
  type ResponseDetail,
  responseDetailSchema,
  type ResponseListItem,
  responseListItemSchema,
} from "./types";

export async function getResponses(f = fetch): Promise<ResponseListItem[]> {
  const res = await apiCall(f, "/v1/responses");
  return z.object({ responses: z.array(responseListItemSchema) }).parse(res).responses;
}

export async function getResponse(f = fetch, id: string): Promise<ResponseDetail> {
  return responseDetailSchema.parse(await apiCall(f, `/v1/responses/${encodeURIComponent(id)}`));
}

/** Closes a response by hand: its run is cancelled the way the run page's Cancel does, and the
 * next alert opens a fresh one. */
export async function closeResponse(f = fetch, id: string): Promise<void> {
  await apiCall(f, `/v1/responses/${encodeURIComponent(id)}/close`, { method: "POST" });
}
