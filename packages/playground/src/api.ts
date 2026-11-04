/**
 * A person at the control plane: logs in with a password and calls the user API with the bearer,
 * logging in again before the 10-minute access token runs out. Every seeding call goes through
 * one of these, so a fixture uses exactly the surface the app does.
 */

export class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    body: string,
  ) {
    super(`${method} ${path} → ${status}: ${body.slice(0, 500)}`);
  }
}

export interface Person {
  id: string;
  email: string;
  name: string;
  role: string;
  password: string;
}

// Well inside the 600 s the access token lives, so no call ever races its expiry.
const REFRESH_AFTER_MS = 5 * 60_000;

export class Session {
  #token = "";
  #at = 0;

  constructor(readonly base: string, readonly person: Person) {}

  async #bearer(): Promise<string> {
    if (this.#token && Date.now() - this.#at < REFRESH_AFTER_MS) return this.#token;
    const res = await fetch(`${this.base}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.person.email, password: this.person.password }),
    });
    const body = await res.text();
    if (!res.ok) throw new ApiError("POST", "/v1/auth/login", res.status, body);
    this.#token = (JSON.parse(body) as { accessToken: string }).accessToken;
    this.#at = Date.now();
    return this.#token;
  }

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.#bearer()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(method, path, res.status, text);
    return (text ? JSON.parse(text) : null) as T;
  }

  get = <T = unknown>(path: string) => this.call<T>("GET", path);
  post = <T = unknown>(path: string, body: unknown = {}) => this.call<T>("POST", path, body);
  put = <T = unknown>(path: string, body: unknown) => this.call<T>("PUT", path, body);
  patch = <T = unknown>(path: string, body: unknown) => this.call<T>("PATCH", path, body);
}

/** Creates the first account, which setup mode makes the owner, verified and active. A
 * multi-user instance takes it only with the setup token its host printed. */
export async function createOwner(
  base: string,
  who: { email: string; name: string; password: string },
  setupToken: string | null,
): Promise<Session> {
  const res = await fetch(`${base}/v1/auth/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...who, ...(setupToken === null ? {} : { setupToken }) }),
  });
  const body = await res.text();
  if (!res.ok) throw new ApiError("POST", "/v1/auth/users", res.status, body);
  const user = JSON.parse(body) as { id: string; role: string };
  return new Session(base, { ...who, id: user.id, role: user.role });
}

/** Adds a teammate through a bound invite, the only way an owner adds a verified account. */
export async function invite(
  owner: Session,
  who: { email: string; name: string; password: string; role: string },
): Promise<Session> {
  const { token } = await owner.post<{ token: string }>("/v1/auth/invites", {
    email: who.email,
    role: who.role,
  });
  const res = await fetch(`${owner.base}/v1/auth/invites/${token}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: who.name, password: who.password }),
  });
  const body = await res.text();
  if (!res.ok) throw new ApiError("POST", "/v1/auth/invites/…/accept", res.status, body);
  const session = new Session(owner.base, { ...who, id: "" });
  const me = await session.get<{ id?: string; user?: { id: string } }>("/v1/auth/me");
  session.person.id = me.user?.id ?? me.id ?? "";
  return session;
}
