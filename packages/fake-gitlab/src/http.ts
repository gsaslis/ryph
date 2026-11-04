// The REST surface's plumbing: a small router over `/api/v4` paths, GitLab's token rules
// (`PRIVATE-TOKEN` or `Authorization: Bearer`, scopes, expiry), its parameter conventions (query
// string, JSON, form and `a[b]` nesting all land in one input) and its pagination headers.

import type { Instance } from "./instance.ts";
import type { Token, User } from "./model.ts";

export type Json = Record<string, unknown>;

export interface Ctx {
  req: Request;
  url: URL;
  gl: Instance;
  user: User | null;
  token: Token | null;
  /** Path parameters, percent-decoded (`:id` may be `group%2Fproject`). */
  params: Record<string, string>;
  /** Query string and body, merged; the body wins. */
  input: Json;
  /** A multipart body's form, for uploads. */
  form: FormData | null;
}

export type Handler = (ctx: Ctx) => Response | Promise<Response>;

/** What a route needs of a token: `user` takes `read_user` (and `api`); `read` takes `read_api`
 * or `api`; `write` takes `api`. GETs are `read` unless declared otherwise. */
export type Need = "anonymous" | "user" | "read" | "write";

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  need: Need;
}

export class Router {
  #routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, need?: Need) {
    this.#routes.push({
      method,
      parts: pattern.split("/").filter((s) => s !== ""),
      handler,
      need: need ?? (method === "GET" ? "read" : "write"),
    });
    return this;
  }

  match(
    method: string,
    path: string,
  ): { route: Route; params: Record<string, string> } | "method" | null {
    const segs = path.split("/").filter((s) => s !== "");
    let wrongMethod = false;
    for (const route of this.#routes) {
      if (route.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const want = route.parts[i]!;
        if (want.startsWith(":")) {
          try {
            params[want.slice(1)] = decodeURIComponent(segs[i]!);
          } catch {
            ok = false;
            break;
          }
        } else if (want !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method !== method) {
        wrongMethod = true;
        continue;
      }
      return { route, params };
    }
    return wrongMethod ? "method" : null;
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** GitLab's error envelope: `{"message": "404 Project Not Found"}`. */
export function fail(status: number, message: string | Json): Response {
  return json({ message }, status);
}

export const notFound = (what: string) => fail(404, `404 ${what} Not Found`);
export const forbidden = () => fail(403, "403 Forbidden");
export const unauthorized = () => fail(401, "401 Unauthorized");
/** Grape's parameter error: `{"error": "title is missing"}`. */
export const missing = (param: string) => json({ error: `${param} is missing` }, 400);
export const invalid = (param: string) => json({ error: `${param} is invalid` }, 400);

/** Folds `a[b]=1`, `a[]=1` and `a=1` pairs into one object. */
export function foldParams(pairs: Iterable<[string, string]>): Json {
  const out: Json = {};
  for (const [rawKey, value] of pairs) {
    const m = /^([^[]+)((?:\[[^\]]*\])*)$/.exec(rawKey);
    if (!m) {
      out[rawKey] = value;
      continue;
    }
    const keys = [m[1]!, ...[...m[2]!.matchAll(/\[([^\]]*)\]/g)].map((x) => x[1]!)];
    let into: Record<string, unknown> = out;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      const last = i === keys.length - 1;
      const next = keys[i + 1];
      if (last) {
        into[k] = value;
      } else if (next === "") {
        const arr = Array.isArray(into[k]) ? (into[k] as unknown[]) : [];
        arr.push(value);
        into[k] = arr;
        break;
      } else {
        if (typeof into[k] !== "object" || into[k] === null) into[k] = {};
        into = into[k] as Record<string, unknown>;
      }
    }
  }
  return out;
}

/** The request's parameters: query string and body (JSON, form or multipart), merged. */
export async function readInput(
  req: Request,
  url: URL,
): Promise<{ input: Json; form: FormData | null }> {
  const input = foldParams(url.searchParams.entries());
  const type = req.headers.get("content-type") ?? "";
  if (req.method === "GET" || req.method === "HEAD" || req.body === null) {
    return { input, form: null };
  }
  if (type.includes("multipart/form-data")) {
    // Node's and the DOM's FormData types differ only in name here.
    const form = (await req.formData()) as unknown as FormData;
    const pairs: Array<[string, string]> = [];
    for (const [k, v] of form.entries()) if (typeof v === "string") pairs.push([k, v]);
    return { input: { ...input, ...foldParams(pairs) }, form };
  }
  const text = await req.text();
  if (text.trim() === "") return { input, form: null };
  if (type.includes("application/x-www-form-urlencoded")) {
    return { input: { ...input, ...foldParams(new URLSearchParams(text).entries()) }, form: null };
  }
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return { input: { ...input, ...(body as Json) }, form: null };
    }
  } catch {
    // Grape answers an unparsable body as a bad request.
  }
  throw new BadRequest("400 Bad request - body is not valid JSON");
}

export class BadRequest extends Error {}

/** The token a request carries: `PRIVATE-TOKEN`, or `Authorization: Bearer` (OAuth and personal
 * tokens alike). */
export function tokenOf(req: Request): string | null {
  const pt = req.headers.get("private-token");
  if (pt) return pt;
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1]!.trim() : null;
}

/** Whether a token's scopes cover what the route needs. */
export function scopesCover(scopes: string[], need: Need): boolean {
  if (need === "anonymous") return true;
  if (scopes.includes("api")) return true;
  if (need === "user") return scopes.includes("read_user") || scopes.includes("read_api");
  if (need === "read") return scopes.includes("read_api");
  return false;
}

export const str = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : null;

export function bool(v: unknown): boolean | null {
  if (v === true || v === "true" || v === "1" || v === 1) return true;
  if (v === false || v === "false" || v === "0" || v === 0) return false;
  return null;
}

export function int(v: unknown): number | null {
  const s = str(v);
  return s !== null && /^-?\d+$/.test(s) ? Number(s) : null;
}

/** A comma-separated or array parameter (`labels`, `add_labels`). */
export function list(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) {
    return v.map(String).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  }
  const s = str(v);
  return s === null ? null : s.split(",").map((x) => x.trim()).filter(Boolean);
}

/**
 * One page of `items`, with GitLab's pagination headers. `X-Total` and `X-Total-Pages` are left
 * out above `countCap`, as GitLab leaves them out above 10 000.
 */
export function paginate<T>(ctx: Ctx, items: T[], render: (t: T) => unknown): Response {
  const perPage = Math.min(100, Math.max(1, int(ctx.input.per_page) ?? 20));
  const page = Math.max(1, int(ctx.input.page) ?? 1);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {
    "x-page": String(page),
    "x-per-page": String(perPage),
    "x-next-page": page < pages ? String(page + 1) : "",
    "x-prev-page": page > 1 ? String(page - 1) : "",
  };
  const link = (n: number, rel: string) => {
    const u = new URL(ctx.url);
    u.searchParams.set("page", String(n));
    u.searchParams.set("per_page", String(perPage));
    return `<${u}>; rel="${rel}"`;
  };
  const links = [link(1, "first")];
  if (page < pages) links.unshift(link(page + 1, "next"));
  if (page > 1) links.unshift(link(page - 1, "prev"));
  if (total <= ctx.gl.countCap) {
    headers["x-total"] = String(total);
    headers["x-total-pages"] = String(pages);
    links.push(link(pages, "last"));
  }
  headers.link = links.join(", ");
  return json(slice.map(render), 200, headers);
}

/** Sorts by `order_by` (`created_at` or `updated_at`) and `sort` (default `desc`), GitLab's list
 * defaults. */
export function ordered<T extends { createdAt: string; updatedAt: string; id: number }>(
  ctx: Ctx,
  items: T[],
): T[] {
  const by = str(ctx.input.order_by) === "updated_at" ? "updatedAt" : "createdAt";
  const asc = str(ctx.input.sort) === "asc";
  return [...items].sort((a, b) => {
    const c = a[by] < b[by] ? -1 : a[by] > b[by] ? 1 : a.id - b.id;
    return asc ? c : -c;
  });
}
