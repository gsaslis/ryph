import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { readAuthBody } from "$lib/server/request-body";
import {
  createUser,
  loginWithPassword,
  sessionHeaders,
  setAuthCookies,
  UpstreamAuthError,
} from "$lib/server/auth";

const bodySchema = z.object({
  name: z.string().optional(),
  email: z.string(),
  password: z.string().optional(),
  setupToken: z.string().optional(),
});

export const POST: RequestHandler = async (event) => {
  const { request } = event;
  const body = bodySchema.safeParse(await readAuthBody(request));
  if (!body.success) error(400, "invalid request");

  try {
    const user = await createUser(body.data, sessionHeaders(event));
    // Open registration: no session until the mailed link is opened, taken address or not.
    if (user === null) return json({ registered: true }, { status: 202 });
    if (body.data.password === undefined) error(400, "password: required");
    const pair = await loginWithPassword(
      body.data.email,
      body.data.password,
      sessionHeaders(event),
    );
    setAuthCookies(event, pair);
    return json({ user });
  } catch (e) {
    if (e instanceof UpstreamAuthError) error(e.status, e.message);
    throw e;
  }
};
