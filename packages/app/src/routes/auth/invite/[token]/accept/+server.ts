import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { readAuthBody } from "$lib/server/request-body";
import { acceptInvite, sessionHeaders, setAuthCookies, UpstreamAuthError } from "$lib/server/auth";

const bodySchema = z.object({
  name: z.string().optional(),
  email: z.string().nullable().default(null),
  password: z.string().optional(),
});

export const POST: RequestHandler = async (event) => {
  const { request, params } = event;
  const body = bodySchema.safeParse(await readAuthBody(request));
  if (!body.success) error(400, "invalid request");

  try {
    const pair = await acceptInvite(params.token ?? "", body.data, sessionHeaders(event));
    if (pair === null) return json({ registered: true }, { status: 202 });
    setAuthCookies(event, pair);
    return json({ user: pair.user });
  } catch (e) {
    if (e instanceof UpstreamAuthError) error(e.status, e.message);
    throw e;
  }
};
