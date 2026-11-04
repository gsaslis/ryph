// The ryph MCP extension for pi: the one way tools reach a run.
//
// pi has no MCP client of its own; MCP reaches it through extensions, and the runner switches
// extensions off wholesale (`--no-extensions`) because the workspace is untrusted. This is the
// extension it loads back in, by explicit path (`-e`), when the run has tools (the only other,
// `images.ts` beside it, loads in every run). It reads
// exactly one config file — `mcp.json` in the throwaway `PI_CODING_AGENT_DIR` the runner's pi
// adapter wrote — connects to every server listed there, and registers each tool the server
// lists as a pi tool. The servers are the MCP gateway's per-run endpoints; the gateway is what
// filters the tool list, substitutes the real credential, and meters the calls. Nothing here is
// a security control; everything here is plumbing.
//
// Invariants:
// - one config file, ours: the workspace's `.mcp.json`, `.pi/mcp.json`, `.cursor/mcp.json` are
//   never read — repo-authored MCP config is setup.yml-trust code choosing its own servers
// - the token is an env REFERENCE in the file (`${MCP_GATEWAY_TOKEN}`), never a literal; `${VAR}`
//   is the only substitution, and an unset var is fatal, named by its name and never its value
// - tool names are namespaced by server slug (`linear__create_issue`): two servers exposing the
//   same name cannot shadow each other in the model's view (Invariant's cross-server attack);
//   every listed tool gets a provider-safe name, rewritten and hashed when its own is not one
// - a server's whole tool list is registered, every page of it, or the run dies: never a prefix
// - a run that cannot reach its tools dies before doing work: any setup failure is fatal (stderr
//   line, exit 1), so the runner reports a run error instead of a keyless run limping on — after
//   a retry bounded by one wall-clock window when the failure is one a moment can fix (a hosted
//   server moved by a node scale-down answers 502 through the tool guard for a few seconds),
//   never for a refusal
// - never a socket from the factory of an invocation that will not run: the factory only ever
//   runs under the runner, which always starts a session, so connecting here is safe and keeps
//   every tool registered before the first model request
//
// Loaded by pi through jiti (TypeScript, no build step) with its npm deps installed beside it
// (`/opt/ryph/pi-mcp` in the image); tested under Bun, which resolves the same bare
// specifiers through package.json. Only the structural slice of pi's `ExtensionAPI` this file
// needs is typed, so neither runtime depends on the pi package.

import process from "node:process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** How the ready line on stderr starts. The runner's pi adapter matches on it (prefixed with
 * this module's own `ryph pi-mcp: ` stamp), so it is part of the contract, not a log line. */
const READY = "ready";

/** The file the runner's pi adapter writes; the only MCP config this extension reads. */
export const CONFIG_FILE = "mcp.json";
/** pi's own config-dir variable; the runner points it at a throwaway dir per run. */
export const CONFIG_DIR_ENV = "PI_CODING_AGENT_DIR";

/** What providers accept in a tool name; anything else in a remote name is folded to `_`. */
const TOOL_NAME_CHARS = /[^A-Za-z0-9_-]/g;
/** The tightest provider ceiling on a tool name: OpenAI caps function names at 64 characters. */
const TOOL_NAME_MAX = 64;
/** Hex digits of the SHA-256 that a rewritten tool name ends with. */
const TOOL_NAME_HASH = 8;
/** The tail every rewritten name has. A plain name that already ends this way is rewritten
 * too, which is what keeps the two forms from ever spelling the same string. */
const REWRITTEN_TAIL = new RegExp(`_[0-9a-f]{${TOOL_NAME_HASH}}$`);
/** Bounds the `tools/list` pages read from one server; a list still going after that is refused. */
const TOOL_PAGES_MAX = 100;
/** Bounds the tool description forwarded to the model, and the snippet in pi's system prompt. */
const DESCRIPTION_MAX = 4_000;
const SNIPPET_MAX = 160;
/** How long, wall clock, one server may take to connect and list its tools at startup, retries
 * included, before the run dies of it. Covers a hosted server rescheduled onto another node
 * (seconds), not one that is down. Per server: servers connect one after another and the first
 * that runs out ends startup, so a gateway that is down costs one window, not one per server. */
const CONNECT_RETRY_MS = 60_000;
/** The first wait between attempts; it doubles up to the cap. */
const CONNECT_BACKOFF_MS = 250;
const CONNECT_BACKOFF_MAX_MS = 4_000;
/** The least time worth starting another attempt with: one cut off by the window says nothing. */
const CONNECT_ATTEMPT_MIN_MS = 1_000;
/** Answers that mean "not there yet" whatever their body says. */
const RETRYABLE_STATUS = new Set([503, 504]);
/** The gateway answers 502 for its own refusals too (policy, an unwired platform server, a
 * rejected credential), so a 502 is retried only when its body is one of these: the gateway's
 * own word for an upstream that did not answer (packages/mcp-gateway/src/http/proxy.ts) and the
 * tool guard's, which the gateway passes through (images/tool-guard/main.ts). */
const RETRYABLE_502 = ["upstream unreachable", "the hosted server did not answer"];
/** The gateway's code for a hosted server with no container on it and none coming (no hosting
 * there, or the server is not meant to run): fatal at once whatever the status says, because no
 * wait fixes it. Its `hosted_stale` and `hosted_starting` ride a 503 and are waited out. */
const NOT_COMING = ["hosted_not_running"];
/** What a failed connection says in its `cause` under Node (undici), the runtime pi runs on. */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** `mcp.json`: one entry per server in the run's scope, keyed by the server's slug. */
export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

export interface McpServerEntry {
  url: string;
  /** Header values may reference environment variables as `${VAR}`; nothing else is expanded. */
  headers?: Record<string, string>;
}

/** A tool result block pi understands (pi-agent-core's `TextContent | ImageContent`). */
export type PiContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface PiToolResult {
  content: PiContent[];
  details: unknown;
}

/** The slice of pi's `ToolDefinition` this extension fills in. */
export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  /** A JSON Schema object: pi validates plain schemas as well as TypeBox ones. */
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ): Promise<PiToolResult>;
}

/** The slice of pi's `ExtensionAPI` this extension uses. */
export interface PiApi {
  registerTool(tool: PiToolDefinition): void;
  on(event: "session_shutdown", handler: () => Promise<void> | void): void;
}

/** What an MCP server said about one tool, in the shape the SDK returns from `tools/list`. */
interface RemoteTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** The SDK's `tools/call` result, in the slice this extension reads. */
interface RemoteCallResult {
  content?: unknown;
  isError?: boolean;
}

export interface ExtensionOptions {
  /** The environment to read the config dir and `${VAR}` references from; defaults to the process's. */
  env?: Record<string, string | undefined>;
  /** Injected into the SDK transport; tests hand it an in-process handler, no sockets. */
  fetch?: typeof fetch;
  /** What a setup failure does. Defaults to a stderr line and `process.exit(1)`. */
  fatal?: (message: string) => never;
  /** Where the ready line goes once every tool is registered. Defaults to stderr. */
  note?: (message: string) => void;
  /** How long one server may take, retries included, before it is fatal; defaults to
   * CONNECT_RETRY_MS. */
  connectRetryMs?: number;
  /** Waits between attempts; tests pass one that records instead of sleeping. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock the window is measured on; defaults to a monotonic one (`performance.now`). */
  now?: () => number;
}

/**
 * Whether a failed attempt is worth another: the gateway or tool guard saying the server behind
 * it is not there yet, or no answer at all from the gateway (a network error, which fetch throws
 * as a TypeError). Anything else — a 401, a 404, a 502 that is the gateway refusing, a malformed
 * answer, a TypeError that is not about the network — is a refusal and stays fatal at once.
 */
function transient(err: unknown): boolean {
  if (err instanceof StreamableHTTPError) {
    // Spelled out: the SDK's error type does not narrow `code` and `message` here.
    const { code, message } = err as { code?: number; message: string };
    if (NOT_COMING.some((marker) => message.includes(marker))) return false;
    if (RETRYABLE_STATUS.has(code ?? 0)) return true;
    return code === 502 && RETRYABLE_502.some((body) => message.includes(body));
  }
  return networkError(err);
}

/** A fetch that never got an answer: Node's `fetch failed` with a socket-level cause, or Deno's
 * `error sending request`. */
function networkError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  if (err.message.startsWith("error sending request")) return true;
  return err.message === "fetch failed" && NETWORK_CODES.has(causeCode(err) ?? "");
}

/** The socket-level code under a fetch failure, when there is one (`ECONNREFUSED`). */
function causeCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

/** An error as one line of a fatal, with the socket code Node's bare `fetch failed` hides. */
function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = causeCode(err);
  return code === undefined ? message : `${message} (${code})`;
}

/** The attempt ran out of the window: what a caller reports when nothing else answered. */
class AttemptTimeout extends Error {}

/** Where an attempt failed, so the fatal can say which step, and how many attempts it took. */
class AttemptFailure extends Error {
  attempts = 1;
  constructor(readonly step: "connect" | "list", readonly error: unknown) {
    super(describe(error));
  }
}

/**
 * Builds the extension factory pi calls with its `ExtensionAPI`. The default export is the
 * production instance; tests build their own with an injected environment and fetch.
 */
export function makeExtension(opts: ExtensionOptions = {}): (pi: PiApi) => Promise<void> {
  const env = opts.env ?? process.env;
  const fatal = opts.fatal ?? ((message: string): never => {
    process.stderr.write(`ryph pi-mcp: ${message}\n`);
    process.exit(1);
  });
  const note = opts.note ?? ((message: string) => {
    process.stderr.write(`ryph pi-mcp: ${message}\n`);
  });
  const retryMs = opts.connectRetryMs ?? CONNECT_RETRY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => performance.now());

  /**
   * One attempt: a fresh client connects and lists every tool, all within `ms`. A fresh client
   * and transport each time: closing a transport aborts it for good, and the SDK refuses to
   * start one twice.
   */
  const attempt = async (
    url: string,
    headers: Record<string, string>,
    ms: number,
  ): Promise<{ client: Client; tools: RemoteTool[] }> => {
    const client = new Client({ name: "ryph-pi-mcp", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers },
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    let step: "connect" | "list" = "connect";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Raced against the window rather than handed to the SDK as a request timeout: the
      // `notifications/initialized` POST inside connect takes none, and a server that accepts
      // the socket and never answers would otherwise hold the run past it.
      return await Promise.race([
        (async () => {
          await client.connect(transport);
          step = "list";
          return { client, tools: await listAllTools(client) };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new AttemptTimeout(`did not answer within ${(ms / 1000).toFixed(1)} s`)),
            ms,
          );
        }),
      ]);
    } catch (err) {
      const failed = new AttemptFailure(step, err);
      await client.close().catch(() => {});
      throw failed;
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Attempts until one succeeds, the failure is not transient, or the window — wall clock, the
   * attempts' own time included — has no room left for an attempt worth making. The last wait
   * is cut to fit. An attempt the window cut off reports the failure before it, which is what
   * the server was actually saying; with none before it, the cut-off is the answer.
   */
  const connect = async (
    url: string,
    headers: Record<string, string>,
  ): Promise<{ client: Client; tools: RemoteTool[] }> => {
    const deadline = now() + retryMs;
    let backoff = CONNECT_BACKOFF_MS;
    let previous: AttemptFailure | undefined;
    for (let attempts = 1;; attempts++) {
      try {
        return await attempt(url, headers, Math.max(deadline - now(), 0));
      } catch (err) {
        const failure = err as AttemptFailure;
        failure.attempts = attempts;
        if (failure.error instanceof AttemptTimeout && previous !== undefined) {
          previous.attempts = attempts;
          throw previous;
        }
        if (!transient(failure.error)) throw failure;
        const wait = Math.min(backoff, deadline - now() - CONNECT_ATTEMPT_MIN_MS);
        if (wait <= 0) throw failure;
        previous = failure;
        await sleep(wait);
        backoff = Math.min(backoff * 2, CONNECT_BACKOFF_MAX_MS);
      }
    }
  };

  return async (pi: PiApi): Promise<void> => {
    let config: McpConfig;
    try {
      config = await readConfig(env);
    } catch (err) {
      return fatal(err instanceof Error ? err.message : String(err));
    }

    const clients: Client[] = [];
    // Every connection this extension holds, dropped together: a fatal past the first server
    // must not leave the ones before it open (the default `fatal` exits the process, but an
    // injected one — the tests' — does not).
    const closeAll = () => Promise.all(clients.map((c) => c.close().catch(() => {})));
    const registered = new Set<string>();
    for (const [slug, entry] of Object.entries(config.mcpServers)) {
      let headers: Record<string, string>;
      try {
        headers = resolveHeaders(entry.headers ?? {}, env, slug);
      } catch (err) {
        return fatal(err instanceof Error ? err.message : String(err));
      }

      // The URL's host is fine to name; the token never was in the URL.
      const host = new URL(entry.url).host;
      let client: Client;
      let tools: RemoteTool[];
      try {
        ({ client, tools } = await connect(entry.url, headers));
      } catch (err) {
        const failure = err as AttemptFailure;
        const tries = failure.attempts > 1 ? ` (after ${failure.attempts} attempts)` : "";
        return fatal(
          failure.step === "connect"
            ? `server "${slug}" at ${host} is unreachable: ${failure.message}${tries}`
            : `server "${slug}" at ${host} could not list its tools: ${failure.message}${tries}`,
        );
      }
      clients.push(client);

      for (const tool of tools) {
        const name = toolName(slug, tool.name);
        // Distinct (slug, name) pairs never map alike (see toolName), so this is a server
        // listing the same tool twice — a list that is not a set. Fatal rather than skipped:
        // dropping one is the silent, partial run this file exists to prevent, and an
        // operator-allowlisted tool would be missing from the model's view with only a
        // stderr line to say so.
        if (registered.has(name)) {
          await closeAll();
          return fatal(
            `server "${slug}" listed "${tool.name}" twice — "${name}" is already registered`,
          );
        }
        registered.add(name);
        pi.registerTool(defineTool(client, slug, tool, name));
      }
    }

    // The extension announces itself once every tool is registered, and the runner's pi adapter
    // looks for this line: `-e` is not trust-gated but it is also not acknowledged, so a pi that
    // stopped honouring it alongside `--no-extensions` would start normally and run with no
    // tools at all. Every other failure here is fatal and loud; that one would be silent.
    note(`${READY} — ${registered.size} tool(s) from ${clients.length} server(s)`);

    pi.on("session_shutdown", async () => {
      await closeAll();
    });
  };
}

/** Reads and validates `$PI_CODING_AGENT_DIR/mcp.json`; every failure names what is wrong. */
export async function readConfig(env: Record<string, string | undefined>): Promise<McpConfig> {
  const dir = env[CONFIG_DIR_ENV];
  if (!dir) {
    throw new Error(`${CONFIG_DIR_ENV} is unset; the runner points it at the run's config dir`);
  }
  const path = join(dir, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseConfig(json, path);
}

/** The config's shape check: an object of `{ url, headers? }` entries under `mcpServers`. */
export function parseConfig(json: unknown, source = CONFIG_FILE): McpConfig {
  if (!isRecord(json) || !isRecord(json.mcpServers)) {
    throw new Error(`${source}: expected { "mcpServers": { ... } }`);
  }
  const mcpServers: Record<string, McpServerEntry> = {};
  for (const [slug, raw] of Object.entries(json.mcpServers)) {
    if (!isRecord(raw) || typeof raw.url !== "string") {
      throw new Error(`${source}: server "${slug}" needs a string "url"`);
    }
    try {
      new URL(raw.url);
    } catch {
      throw new Error(`${source}: server "${slug}" has an invalid url`);
    }
    let headers: Record<string, string> | undefined;
    if (raw.headers !== undefined) {
      if (!isRecord(raw.headers)) {
        throw new Error(`${source}: server "${slug}" headers must be an object of strings`);
      }
      headers = {};
      for (const [k, v] of Object.entries(raw.headers)) {
        if (typeof v !== "string") {
          throw new Error(`${source}: server "${slug}" header "${k}" must be a string`);
        }
        headers[k] = v;
      }
    }
    mcpServers[slug] = headers ? { url: raw.url, headers } : { url: raw.url };
  }
  return { mcpServers };
}

/**
 * Expands `${VAR}` references in header values from `env`. The only substitution there is:
 * no `!command`, no keychains, no files. An unset variable is an error naming the VARIABLE.
 */
export function resolveHeaders(
  headers: Record<string, string>,
  env: Record<string, string | undefined>,
  slug: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(headers)) {
    out[name] = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, variable: string) => {
      const value = env[variable];
      if (value === undefined || value === "") {
        throw new Error(
          `server "${slug}": header "${name}" references ${variable}, which is unset`,
        );
      }
      return value;
    });
  }
  return out;
}

/**
 * Every tool a server lists, following `nextCursor` to the last page: the gateway passes
 * pagination through, and a page it filtered empty can still carry a cursor. A cursor seen
 * twice, or a list still going after TOOL_PAGES_MAX pages, throws — registering a prefix of the
 * tools would be the silent, partial run the fatal rule exists to prevent.
 */
async function listAllTools(client: Client): Promise<RemoteTool[]> {
  const tools: RemoteTool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < TOOL_PAGES_MAX; page++) {
    // The SDK re-caches tool metadata on each call, keeping the last page's only; that cache
    // feeds just its output-schema checks and task hints, neither of which this file relies on.
    const result = await client.listTools(cursor === undefined ? undefined : { cursor });
    tools.push(...(result.tools as RemoteTool[]));
    const next = result.nextCursor;
    if (typeof next !== "string" || next === "") return tools;
    if (seen.has(next)) throw new Error("tools/list repeated a cursor");
    seen.add(next);
    cursor = next;
  }
  throw new Error(`tools/list had not ended after ${TOOL_PAGES_MAX} pages`);
}

/**
 * The pi-side name of a remote tool: `<slug>__<name>` when that is already provider-safe and
 * within TOOL_NAME_MAX. Otherwise it is rewritten — refused characters folded to `_`, clipped —
 * and ends in a hash of the slug AND the remote name, so every tool the server lists gets a
 * name, and two that fold or clip alike (`issues.list`, `issues_list`) still get different ones.
 * Deterministic: a tool has the same name on every run.
 *
 * Distinct inputs never map alike, which is what the registration below relies on, and it takes
 * both halves of the hash to hold: the slug, because a clipped name may be all prefix and two
 * servers can list names that clip to the same one; and the REWRITTEN_TAIL check, because a
 * rewritten name is not necessarily longer than a plain one — without it `("a", "x.y")` and
 * `("a", "x_y_b24ca9b7")` both spell `a__x_y_b24ca9b7`.
 */
export function toolName(slug: string, remote: string): string {
  const plain = `${slug}__${remote}`;
  const folded = plain.replace(TOOL_NAME_CHARS, "_");
  if (folded === plain && plain.length <= TOOL_NAME_MAX && !REWRITTEN_TAIL.test(plain)) {
    return plain;
  }
  const hash = createHash("sha256")
    .update(`${slug} ${remote}`)
    .digest("hex")
    .slice(0, TOOL_NAME_HASH);
  return `${folded.slice(0, TOOL_NAME_MAX - TOOL_NAME_HASH - 1)}_${hash}`;
}

function defineTool(
  client: Client,
  slug: string,
  tool: RemoteTool,
  name: string,
): PiToolDefinition {
  const description = clip(tool.description?.trim() || `${tool.name} on ${slug}`, DESCRIPTION_MAX);
  return {
    name,
    label: `${slug}: ${tool.name}`,
    description,
    promptSnippet: clip(`${name} — ${description.split("\n")[0]}`, SNIPPET_MAX),
    // The server's JSON Schema, as is. pi validates plain JSON Schema (its validator branches on
    // the absence of TypeBox's kind symbol), so no TypeBox wrapping is needed.
    parameters: tool.inputSchema ?? { type: "object", properties: {} },
    async execute(_toolCallId, params, signal) {
      const result = (await client.callTool(
        { name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
        undefined,
        signal ? { signal } : {},
      )) as RemoteCallResult;
      const content = mapContent(result.content);
      if (result.isError) {
        // pi turns a thrown execute into an error tool result for the model.
        throw new Error(
          content.filter((c) => c.type === "text").map((c) => c.text).join("\n") ||
            `${tool.name} failed`,
        );
      }
      return { content, details: { server: slug, tool: tool.name } };
    },
  };
}

/** MCP content blocks → pi content blocks: text and images pass, everything else is described. */
export function mapContent(content: unknown): PiContent[] {
  if (!Array.isArray(content) || content.length === 0) {
    return [{ type: "text", text: "(no content)" }];
  }
  return content.map((block): PiContent => {
    if (isRecord(block)) {
      if (block.type === "text" && typeof block.text === "string") {
        return { type: "text", text: block.text };
      }
      if (
        block.type === "image" && typeof block.data === "string" &&
        typeof block.mimeType === "string"
      ) {
        return { type: "image", data: block.data, mimeType: block.mimeType };
      }
    }
    return { type: "text", text: JSON.stringify(block) };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** The production instance: pi calls this with its `ExtensionAPI`. */
const extension: (pi: PiApi) => Promise<void> = makeExtension();
export default extension;
