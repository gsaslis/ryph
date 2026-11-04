import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { readAuthBody } from "$lib/server/request-body";
import { sessionHeaders, setAuthCookies, UpstreamAuthError, verifyEmail } from "$lib/server/auth";

const bodySchema = z.object({
  name: z.string(),
  password: z.string(),
});

export const POST: RequestHandler = async (event) => {
  const { request, params } = event;
  const body = bodySchema.safeParse(await readAuthBody(request));
  if (!body.success) error(400, "invalid request");

  try {
    const pair = await verifyEmail(params.token ?? "", body.data, sessionHeaders(event));
    setAuthCookies(event, pair);
    return json({ user: pair.user });
  } catch (e) {
    if (e instanceof UpstreamAuthError) error(e.status, e.message);
    throw e;
  }
};
