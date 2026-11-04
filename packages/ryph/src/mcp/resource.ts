// A tool over one family of plain REST routes, one `action` per route: what the configuration
// surfaces (agents, repos, workspaces, skills, memory, chat, MCP servers, …) are made of. Each
// family is two tools, the reads and the writes, so a client's read-only hint stays true and the
// list stays short.
//
// Invariants:
// - an action is exactly one route: its method and path are fixed here, and arguments fill only
//   the path's `{placeholders}` (each one a single encoded segment) and the named query params
// - a body is the caller's JSON, sent as given. Where the service's own zod schema is at hand it
//   is checked first, for an early and precise refusal, but never transformed: defaults stay the
//   server's to apply, and a PATCH sends only what the caller wrote
// - `describe` hands out an action's body as JSON Schema, generated from the same zod schema, so
//   the tool list stays short and the schema is still exact
// - a read of one record (a path ending in its id) keeps its strings whole, since a field a model
//   saw only part of is one it cannot safely edit; any other read cuts long strings, and its marker
//   names `full: true`, which reads them whole

import { z } from "@zod/zod";
import { readBody, UsageError } from "../api/client.ts";
import { type Args, optBool, optInt, optObject, optString, seg } from "./args.ts";
import { compact, type CompactOptions, cut, lastLines, record } from "./format.ts";
import {
  DESTRUCTIVE,
  type JsonSchema,
  READ,
  type Tool,
  type ToolAnnotations,
  type ToolContext,
} from "./tool.ts";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface Action {
  method: Method;
  /** `/v1/agents/{agentId}`: each placeholder is a required argument of the same name. */
  path: string;
  /** What it does, in a few words, for the tool's description. */
  doc: string;
  /** Arguments sent as query parameters, as `arg` or `[arg, param]`. */
  query?: ReadonlyArray<string | readonly [string, string]>;
  /** The query arguments the route cannot do without. */
  requiredQuery?: readonly string[];
  /** Whether the action takes `body`, and the service's schema for it when there is one. */
  body?: { required: boolean; schema?: z.ZodType };
  /** The answer is text (a log): its last `tail` lines are shown. */
  text?: boolean;
  /**
   * How the answer reads; compact JSON when absent. `opts` are how long strings are cut, for a
   * render that shows a record.
   */
  render?(
    answer: unknown,
    ctx: ToolContext,
    args: Args,
    opts: CompactOptions,
  ): string | Promise<string>;
}

export interface ResourceSpec {
  name: string;
  description: string;
  needs: readonly string[];
  /** Actions any token may take, whatever `needs` says. */
  openActions?: readonly string[];
  actions: Record<string, Action>;
  /** The schemas of the arguments the actions take beyond `action` and `body`. */
  params?: Record<string, JsonSchema>;
  /** Defaults to read-only for a family whose every action is a GET, destructive otherwise. */
  annotations?: ToolAnnotations;
}

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;
const TEXT_TAIL = 200;

/** What a cut string's marker says to read it whole. */
export const FULL_HINT = "pass full: true for all of it";

function placeholders(path: string): string[] {
  return [...path.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/** The JSON Schema of a body, as a caller writes it (before the server's defaults). */
export function bodySchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
}

export function resourceTool(spec: ResourceSpec): Tool {
  const names = Object.keys(spec.actions);
  const described = names.filter((n) => spec.actions[n].body?.schema);
  const readOnly = names.every((n) => spec.actions[n].method === "GET");
  const hasRead = names.some((n) => spec.actions[n].method === "GET" && !spec.actions[n].text);
  const actionDocs = names.map((n) => {
    const a = spec.actions[n];
    const args = [
      ...placeholders(a.path),
      ...(a.query ?? []).map((q) => {
        const arg = typeof q === "string" ? q : q[0];
        return a.requiredQuery?.includes(arg) ? arg : `${arg}?`;
      }),
      ...(a.body ? [a.body.required ? "body" : "body?"] : []),
      ...(a.text ? ["tail?"] : []),
    ];
    return `- ${n}${args.length > 0 ? ` {${args.join(", ")}}` : ""}: ${a.doc}`;
  });
  const description = [
    spec.description,
    "Actions:",
    ...actionDocs,
    ...(described.length > 0
      ? [`- describe {of}: the JSON Schema of an action's body (${described.join(", ")})`]
      : []),
    ...(hasRead ? ["A read cuts long strings unless full: true; one record's are whole."] : []),
  ].join("\n");

  const hasBody = names.some((n) => spec.actions[n].body);
  const hasText = names.some((n) => spec.actions[n].text);
  const params: Record<string, JsonSchema> = {};
  for (const n of names) {
    for (const p of placeholders(spec.actions[n].path)) params[p] ??= { type: "string" };
    for (const q of spec.actions[n].query ?? []) {
      params[typeof q === "string" ? q : q[0]] ??= { type: "string" };
    }
  }
  Object.assign(params, spec.params ?? {});
  const inputSchema: JsonSchema = {
    type: "object",
    properties: {
      action: { type: "string", enum: [...names, ...(described.length > 0 ? ["describe"] : [])] },
      ...params,
      ...(hasBody ? { body: { type: "object", additionalProperties: true } } : {}),
      ...(hasText ? { tail: { type: "integer", minimum: 1, maximum: 5000 } } : {}),
      ...(hasRead ? { full: { type: "boolean" } } : {}),
      ...(described.length > 0 ? { of: { type: "string", enum: described } } : {}),
    },
    required: ["action"],
    additionalProperties: false,
  };

  return {
    name: spec.name,
    description,
    inputSchema,
    annotations: spec.annotations ?? (readOnly ? READ : DESTRUCTIVE),
    needs: spec.needs,
    ...(spec.openActions ? { openActions: spec.openActions } : {}),
    routes: names.map((n) => [spec.actions[n].method, spec.actions[n].path.split("?")[0]] as const),
    run: async (args, ctx) => {
      const name = optString(args, "action");
      if (name === "describe" && described.length > 0) {
        const of = optString(args, "of");
        const action = of === undefined ? undefined : spec.actions[of];
        if (!action?.body?.schema) throw new UsageError(`of: one of ${described.join(", ")}`);
        return JSON.stringify(bodySchema(action.body.schema));
      }
      const action = name === undefined ? undefined : spec.actions[name];
      if (action === undefined) throw new UsageError(`action: one of ${names.join(", ")}`);
      return await perform(spec.name, action, args, ctx);
    },
  };
}

async function perform(tool: string, action: Action, args: Args, ctx: ToolContext) {
  let path = action.path.replace(PLACEHOLDER, (_, name: string) => {
    const value = optString(args, name);
    if (value === undefined) throw new UsageError(`${name}: required for this action`);
    return seg(value);
  });
  const query = new URLSearchParams();
  for (const q of action.query ?? []) {
    const [arg, param] = typeof q === "string" ? [q, q] : q;
    const value = args[arg];
    if (value === undefined || value === null || value === "") {
      if (action.requiredQuery?.includes(arg)) {
        throw new UsageError(`${arg}: required for this action`);
      }
      continue;
    }
    // Every query param is a scalar: an object or a list would go out as "[object Object]".
    if (typeof value === "object") {
      throw new UsageError(
        `${arg}: a ${Array.isArray(value) ? "list" : "object"} where one value goes`,
      );
    }
    query.set(param, String(value));
  }
  if (query.size > 0) path += `?${query}`;

  let body: Record<string, unknown> | undefined;
  if (action.body) {
    body = optObject(args, "body");
    if (body === undefined && action.body.required) {
      throw new UsageError(
        action.body.schema
          ? `body: required; ${tool} {action: "describe", of: …} gives its schema`
          : "body: required",
      );
    }
    if (body !== undefined && action.body.schema) {
      const checked = action.body.schema.safeParse(body);
      if (!checked.success) {
        throw new UsageError(`body: ${z.prettifyError(checked.error).replace(/\n/g, "; ")}`);
      }
    }
  }

  const api = await ctx.api();
  if (action.text) {
    // A 404 is a refusal like any other read's, in the server's words (`no such environment`,
    // `this build has no log (yet)`), not an empty answer.
    const res = await api.send("GET", path);
    if (!res.ok) throw await api.error(res);
    const text = await readBody(res);
    const n = optInt(args, "tail", 1, 5000) ?? TEXT_TAIL;
    const { text: shown, dropped } = lastLines(text, n);
    return dropped > 0
      ? `…[${dropped} earlier lines; pass a larger tail for more]\n${cut(shown, 100_000)}`
      : cut(shown, 100_000);
  }
  const answer = await api.json(action.method, path, body);
  const read = action.method === "GET";
  if (answer === null) return read ? "None." : "Done.";
  const whole = optBool(args, "full") === true || (read && action.path.endsWith("}"));
  const opts: CompactOptions = whole ? { maxString: Infinity } : read ? { more: FULL_HINT } : {};
  if (action.render) return await action.render(answer, ctx, args, opts);
  // A write that answers nothing worth reading (`{}`) did what it was asked.
  if (!read && compact(answer) === null) return "Done.";
  return record(answer, opts);
}
