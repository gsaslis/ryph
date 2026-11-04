// The pi adapter against a fake pi (tests/fixtures/fake_pi.ts) speaking the real RPC protocol:
// event→chunk mapping, the brief and the memory instruction in the prompt, the abort path, and
// the throw-only-for-breakage contract. The opt-in e2e at the bottom is the only test touching
// the real binary.

import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeCredentials } from "../src/helpers/runtime_credentials.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  configuredHosts,
  credentialRejected,
  INLINE_IMAGES,
  mcpConfig,
  piArgs,
  piHarness,
  proxyModelsConfig,
  resizedChars,
  thinkingLevelMap,
  writePiConfigDir,
} from "../src/adapters/harness/pi.ts";
import { IMAGE_BUDGET } from "../../pi-mcp/images.ts";
import type {
  HarnessImage,
  HarnessImages,
  HarnessInput,
  HarnessIo,
  HarnessMessage,
  HarnessSkill,
  HarnessTools,
} from "../src/ports/harness.ts";
import type { TranscriptChunk } from "../src/core/types.ts";
import { repoEntry } from "./util.ts";
import { endsAtSettle } from "./doubles/conversation.ts";

type JsonObject = Record<string, unknown>;

const FAKE_PI = new URL("./fixtures/fake_pi.ts", import.meta.url).pathname;

const noopDiagnostics = { debug: () => {}, warn: () => {} };

function fakeCommand(scenario: string): string[] {
  return [process.execPath, "--no-env-file", FAKE_PI, `--scenario=${scenario}`];
}

async function makeInput(): Promise<{ input: HarnessInput; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  return {
    input: {
      spec: { title: "Fix the bug", instructions: "Do the thing." },
      agent: { name: "Ada", email: "ada@example.test" },
      brief: "## What previous runs learned\n\n- [mem-1] use deno task ci (procedure · today)",
      layout: "## Your checkout\n\n### `repo/` — test/repo @ `main`",
      machine: "## Your machine\n\nEveryday tools on `PATH`: `rg`, `jq` and `mise`.",
      checkoutDir: dir,
      repos: [repoEntry({ url: "https://example.test/repo.git" })],
      serviceHosts: [],
      skills: [],
    },
    cleanup: () => rm(dir, { recursive: true }),
  };
}

/** `collectIo` with the diagnostics recorded: what the adapter warned about, in order. */
function recordingIo() {
  const warnings: string[] = [];
  const { io } = collectIo();
  return {
    io: { ...io, diagnostics: { debug: () => {}, warn: (e: string) => warnings.push(e) } },
    warnings,
  };
}

/**
 * The seq the first narrated chunk lands at. Not zero on purpose: the adapter's `final` mark
 * names a history SEQ, and a base of zero would let a chunk index pass for one undetected.
 */
const SEQ_BASE = 100;

function collectIo(signal?: AbortSignal) {
  const chunks: TranscriptChunk[] = [];
  const io: HarnessIo = {
    signal: signal ?? new AbortController().signal,
    // Stands in for the history emitter: one seq per narrated chunk, handed back the way a
    // run that records history hands it back.
    onTranscript: (c) => {
      chunks.push(c);
      return SEQ_BASE + chunks.length - 1;
    },
    diagnostics: noopDiagnostics,
    conversation: endsAtSettle(),
  };
  return { io, chunks };
}

/** The chunk the run's `final` mark points at, resolved through the fake seqs above. */
function markedChunk(chunks: TranscriptChunk[]): TranscriptChunk | undefined {
  const mark = chunks.find((c) => c.kind === "final");
  if (mark === undefined) return undefined;
  const { seq } = mark.raw as { seq: number };
  return chunks[seq - SEQ_BASE];
}

test("pi: happy path maps events; the final message is the summary, tags and all", async () => {
  const { input, cleanup } = await makeInput();
  const { io, chunks } = collectIo();
  try {
    const outcome = await piHarness({ kind: "pi" }, { command: fakeCommand("happy") })
      .run(input, io);

    assertEquals(outcome.interrupted, false);
    // Memory is tools now, so its old tag rides the summary untouched.
    assertEquals(
      outcome.summary,
      "All done: wrote the file.\n\n<memory>not a protocol any more</memory>",
    );
    assertEquals(
      chunks.map((c) => c.kind),
      [
        "system",
        "system",
        "thinking",
        "assistant",
        "tool_use",
        "tool_result",
        "assistant",
        "final",
      ],
    );
    assert(chunks.every((c) => c.raw !== undefined), "every chunk keeps the raw event");
    // ...and the mark closing the run names the message the summary was taken off: the closing
    // one here, not the earlier "Writing the file now."
    assertEquals(markedChunk(chunks), chunks[6]);
  } finally {
    await cleanup();
  }
});

test("pi: context stats ride history; unsupported telemetry does not fail a run", async () => {
  for (const scenario of ["context", "context-unsupported"]) {
    const { input, cleanup } = await makeInput();
    const { io, chunks } = collectIo();
    try {
      const result = await piHarness({ kind: "pi" }, { command: fakeCommand(scenario) }).run(
        input,
        io,
      );
      assertEquals(result.summary, "Done");
      const snapshot = chunks.find((chunk) => chunk.text === "context_usage");
      assertEquals(snapshot?.kind, "system");
      assertEquals(
        (snapshot?.raw as Record<string, unknown>).status,
        scenario === "context" ? "ready" : "unavailable",
      );
    } finally {
      await cleanup();
    }
  }
});

test("pi: long assistant prose is narrated intact", async () => {
  const { input, cleanup } = await makeInput();
  const { io, chunks } = collectIo();
  try {
    await piHarness({ kind: "pi" }, { command: fakeCommand("long-assistant") }).run(input, io);
    assertEquals(
      chunks.find((chunk) => chunk.kind === "assistant")?.text,
      "Long answer. ".repeat(4_000) + "The end.",
    );
  } finally {
    await cleanup();
  }
});

test("pi: a final message with no text falls back to the prior prose", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  try {
    const outcome = await piHarness({ kind: "pi" }, { command: fakeCommand("prose-then-empty") })
      .run(input, io);
    assertEquals(outcome.summary, "Here is my full answer.");
  } finally {
    await cleanup();
  }
});

test("pi: an oversized system-prompt appendix throws clearly, naming the size", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  try {
    // Well over what argv could ever carry: the appendix rides a file, so this is the
    // defensive ceiling and not a spawn limit.
    const err = await assertRejects(
      () =>
        piHarness({ kind: "pi" }, { command: fakeCommand("happy") })
          .run({ ...input, systemPrompt: "x".repeat(1_100_000) }, io),
      Error,
    );
    assert(err.message.includes("appendix"), `unexpected message: ${err.message}`);
    assert(/is 1100\d{3} bytes, over the/.test(err.message), `unexpected message: ${err.message}`);
  } finally {
    await cleanup();
  }
});

test("pi: the appendix rides a file in the config dir, not argv, and context files are off", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  try {
    const seen: Introspection = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() })
        .run({ ...input, systemPrompt: "You are ada.", environment: "A db on :5432." }, io))
        .summary,
    );
    // argv names a file inside the throwaway config dir, and that file holds the appendix
    const at = seen.args.indexOf("--append-system-prompt");
    assert(at > 0);
    assert(seen.args[at + 1].endsWith("/appendix.md"), seen.args[at + 1]);
    assertEquals(seen.files["appendix.md"], seen.appendix);
    // Who the agent is comes first, then the agent's own prompt, then the checkout.
    assert(seen.appendix!.startsWith("You are Ada, an agent run by Ryph."), seen.appendix!);
    assert(seen.appendix!.includes("\n\nYou are ada.\n\n## Your checkout"), seen.appendix!);
    assert(seen.appendix!.includes("A db on :5432."));
    // The platform's machine block sits between the two: after the checkout it describes,
    // before any prose a repo committed about the machine it thought it would get.
    const machine = seen.appendix!.indexOf("## Your machine");
    assert(machine > seen.appendix!.indexOf("## Your checkout"), seen.appendix!);
    assert(machine < seen.appendix!.indexOf("A db on :5432."), seen.appendix!);
    // pi loads no AGENTS.md of its own: the layout block is the platform's quoted copy
    assert(seen.args.includes("--no-context-files"));
    // nor does it refresh its model catalogue from pi.dev
    assert(seen.args.includes("--offline"));
  } finally {
    await cleanup();
  }
});

// pi enables four built-ins by default and the model pays for the missing three in `bash` calls:
// one subprocess per search, returning whatever the command printed. The choice rides
// `settings.json` and NOT `--tools`, which in pi 0.85.1 is a strict allowlist over every tool the
// session has — naming the built-ins there would delete the extension's `ryph__*`, `memory__*`
// and `forge__*` tools while the extension still printed its ready line. Nothing about that would
// fail, so it is pinned here twice over: the file's exact content, and the flag's absence.
test("pi: the built-ins are chosen in settings.json, never with --tools", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.set("RYPH_MCP_TOKEN", "ryph-mcp-virtual-1");
  try {
    const seen: Introspection = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() })
        .run({ ...input, tools: TOOLS }, io)).summary,
    );
    assertEquals(
      seen.files["settings.json"],
      '{"defaultTools":["read","bash","edit","write","grep","find","ls"],"steeringMode":"all",' +
        '"images":{"autoResize":true}}',
    );
    assert(!seen.args.includes("--tools"), seen.args.join(" "));
    assert(!seen.args.includes("-t"), seen.args.join(" "));
    // ...and the run still holds its tools: the extension is loaded and nothing allowlists it out.
    assert(extensionsOf(seen.args).includes(EXTENSION), seen.args.join(" "));
  } finally {
    runtimeCredentials.delete("RYPH_MCP_TOKEN");
    await cleanup();
  }
});

// The run's result repeats the message it was derived from, so the reader needs to know WHICH
// message that was — it cannot be told in the moment (which message is the last is only known
// at the settle) and it is not always the last one.
test("pi: the final mark names the message the summary came from", async () => {
  const { input, cleanup } = await makeInput();
  const { io, chunks } = collectIo();
  try {
    const outcome = await piHarness({ kind: "pi" }, { command: fakeCommand("done") })
      .run(input, io);

    assertEquals(outcome.summary, "Did the work.");
    const marked = markedChunk(chunks);
    assertEquals(marked?.kind, "assistant");
    // Exactly the row that would otherwise say the summary a second time.
    assertEquals(marked?.text, "Did the work.");
    assertEquals(chunks.at(-1)?.kind, "final", "the mark is the run's last narration");
  } finally {
    await cleanup();
  }
});

test("pi: a final message with no text marks the message ABOVE it", async () => {
  const { input, cleanup } = await makeInput();
  const { io, chunks } = collectIo();
  try {
    // "Here is my full answer." then a message with no text: the summary falls back one message
    // up, and so must the mark.
    const outcome = await piHarness({ kind: "pi" }, { command: fakeCommand("prose-then-empty") })
      .run(input, io);

    assertEquals(outcome.summary, "Here is my full answer.");
    const assistants = chunks.filter((c) => c.kind === "assistant");
    assertEquals(assistants.map((c) => c.text), ["Here is my full answer.", ""]);
    const marked = markedChunk(chunks);
    assertEquals(marked?.text, "Here is my full answer.");
    assertEquals(marked, assistants[0], "not the empty message that came after it");
  } finally {
    await cleanup();
  }
});

test("pi: nothing is marked when the run narrates nowhere that keeps a seq", async () => {
  const { input, cleanup } = await makeInput();
  const chunks: TranscriptChunk[] = [];
  // A console-only narration: no history, so no seq — and a mark naming nothing is worse than
  // no mark at all.
  const io: HarnessIo = {
    signal: new AbortController().signal,
    onTranscript: (c) => {
      chunks.push(c);
      return undefined;
    },
    diagnostics: noopDiagnostics,
    conversation: endsAtSettle(),
  };
  try {
    const outcome = await piHarness({ kind: "pi" }, { command: fakeCommand("done") })
      .run(input, io);

    assertEquals(outcome.summary, "Did the work.");
    assertEquals(chunks.filter((c) => c.kind === "final"), []);
  } finally {
    await cleanup();
  }
});

test("pi: an abort mid-run sends the abort command and returns interrupted", async () => {
  const { input, cleanup } = await makeInput();
  const ctrl = new AbortController();
  const chunks: TranscriptChunk[] = [];
  const io: HarnessIo = {
    signal: ctrl.signal,
    onTranscript: (c) => {
      chunks.push(c);
      if (c.kind === "assistant") ctrl.abort();
    },
    diagnostics: noopDiagnostics,
    conversation: endsAtSettle(),
  };
  try {
    const outcome = await piHarness({ kind: "pi" }, { command: fakeCommand("abort") })
      .run(input, io);

    assertEquals(outcome.interrupted, true);
    // the fake only settles after receiving {"type":"abort"}, so this text proves the round trip
    assertEquals(outcome.summary, "stopped where it was coherent");
  } finally {
    await cleanup();
  }
});

// early-exit's expected message also pins the stderr-into-the-error path: the drained
// "fake pi died" must survive into the thrown reason alongside the exit code
for (
  const [scenario, message] of [
    ["stop-error", "agent error"],
    ["garbage", "non-JSON"],
    ["early-exit", "before settling: fake pi died"],
  ] as const
) {
  test(`pi: ${scenario} is mechanical breakage and throws`, async () => {
    const { input, cleanup } = await makeInput();
    const { io } = collectIo();
    try {
      await assertRejects(
        () => piHarness({ kind: "pi" }, { command: fakeCommand(scenario) }).run(input, io),
        Error,
        message,
      );
    } finally {
      await cleanup();
    }
  });
}

test("pi: teardown noise after an abort never throws — interrupted wins", async () => {
  // the fake answers the abort with a nack, then a non-JSON line, then exits:
  // every one of those would throw mid-run, but during an intentional abort they are noise
  const { input, cleanup } = await makeInput();
  const ctrl = new AbortController();
  const io: HarnessIo = {
    signal: ctrl.signal,
    onTranscript: (c) => {
      if (c.kind === "assistant") ctrl.abort();
    },
    diagnostics: noopDiagnostics,
    conversation: endsAtSettle(),
  };
  try {
    const outcome = await piHarness({ kind: "pi" }, { command: fakeCommand("abort-noise") })
      .run(input, io);

    assertEquals(outcome.interrupted, true);
  } finally {
    await cleanup();
  }
});

test("pi: a failed tool with no result narrates '(no result)', not a bare [error]", async () => {
  const { input, cleanup } = await makeInput();
  const { io, chunks } = collectIo();
  try {
    await piHarness({ kind: "pi" }, { command: fakeCommand("tool-error") }).run(input, io);

    const result = chunks.find((c) => c.kind === "tool_result");
    assertEquals(result?.text, "[error] (no result)");
  } finally {
    await cleanup();
  }
});

test("pi: stderr well past the cap is drained without stalling or failing the run", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  try {
    const outcome = await piHarness({ kind: "pi" }, { command: fakeCommand("stderr-spam") })
      .run(input, io);

    assertEquals(outcome.interrupted, false);
    assertEquals(outcome.summary, "ok");
  } finally {
    await cleanup();
  }
});

test("pi: a wedged child (stdout closed, process alive) is killed, not awaited forever", async () => {
  // not a fake_pi scenario: a script child can't reliably close its OS-level stdout fd and
  // stay alive, so an inline sh child wedges instead
  const wedge = [
    "sh",
    "-c",
    `echo '{"type":"agent_start"}'; echo 'wedged on purpose' >&2; exec 1>&-; exec sleep 60`,
  ];
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  try {
    await assertRejects(
      () =>
        piHarness({ kind: "pi" }, { command: wedge, shutdownGraceMs: 250 })
          .run(input, io),
      Error,
      "before settling: wedged on purpose",
    );
  } finally {
    await cleanup();
  }
});

test("pi: an already-aborted signal returns without spawning", async () => {
  const { input, cleanup } = await makeInput();
  const ctrl = new AbortController();
  ctrl.abort();
  const { io, chunks } = collectIo(ctrl.signal);
  try {
    // a nonexistent binary: reaching spawn would throw, so returning proves we never spawned
    const outcome = await piHarness({ kind: "pi" }, { command: ["no-such-binary-anywhere"] })
      .run(input, io);

    assertEquals(outcome.interrupted, true);
    assertEquals(chunks, []);
  } finally {
    await cleanup();
  }
});

test("pi: proxy routing rewrites the provider endpoint to the proxy, key stays in env", () => {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: "http://model-proxy.test:7420",
    ANTHROPIC_API_KEY: "ryph-vk-secret",
  };
  const config = proxyModelsConfig(
    { kind: "pi", provider: "anthropic", model: "claude-sonnet-5" },
    (name) => env[name],
  );
  assert(config !== null);
  assertEquals(config.provider, "anthropic");
  const provider = (config.models.providers as Record<string, Record<string, unknown>>).anthropic;
  // pi posts <baseUrl>/v1/messages, so the base URL is the proxy root; the proxy forwards the
  // path verbatim to the real provider.
  assertEquals(provider.baseUrl, "http://model-proxy.test:7420");
  assertEquals(provider.api, "anthropic-messages");
  // No apiKey in the file: pi resolves the provider's key from the environment itself, so the
  // virtual key never touches disk — pi treats an explicit apiKey as a literal, not an env ref.
  assert(!("apiKey" in provider), "the override must not carry a key field");
  assert(!JSON.stringify(config.models).includes("ryph-vk-secret"));
});

test("pi: the openai built-in is routed the same way, with its own dialect", () => {
  const config = proxyModelsConfig(
    { kind: "pi", provider: "openai", model: "gpt-5" },
    (name) => name === "OPENAI_BASE_URL" ? "http://model-proxy.test:7420/v1" : undefined,
  );
  assert(config !== null);
  assertEquals(config.provider, "openai");
  // A built-in's key var survives the scrub, so the adapter carries nothing into the spawn env.
  assertEquals(config.keyEnv, null);
  const provider = (config.models.providers as Record<string, Record<string, unknown>>).openai;
  assertEquals(provider.baseUrl, "http://model-proxy.test:7420/v1");
  // The Responses API: pi posts <baseUrl>/responses, the proxy's /v1/responses.
  assertEquals(provider.api, "openai-responses");
  assert(!("apiKey" in provider), "the override must not carry a key field");
  // No enumerated models either: the entry merges onto pi's own catalog.
  assert(!("models" in provider), "a built-in override must not enumerate models");
});

test("pi: no proxy routing without a provider or without a base-URL env", () => {
  const withProxy = (name: string) => (name === "ANTHROPIC_BASE_URL" ? "http://p" : undefined);
  // No provider on the spec: direct (or no) model access, pi keeps its built-in endpoints.
  assertEquals(proxyModelsConfig({ kind: "pi" }, withProxy), null);
  // Provider set but no base-URL env and no custom blob: Stage-A direct key delivery, no proxy
  // in front.
  assertEquals(
    proxyModelsConfig({ kind: "pi", provider: "anthropic" }, () => undefined),
    null,
  );
  assertEquals(proxyModelsConfig({ kind: "pi", provider: "acme" }, () => undefined), null);
  // THE MISMATCH. Only ANTHROPIC_BASE_URL is set, and the run is on openai. The routing is keyed
  // on the run's provider, never on whichever base-URL var happens to be in the environment, so
  // this is no routing at all — not an openai entry pointed at the Anthropic leg of the proxy
  // and declaring `anthropic-messages`, which would fail every model call as a wire-shape
  // mismatch pi cannot explain. Same for a slug with no custom blob behind it.
  assertEquals(proxyModelsConfig({ kind: "pi", provider: "openai" }, withProxy), null);
  assertEquals(proxyModelsConfig({ kind: "pi", provider: "acme" }, withProxy), null);
});

// --- a custom endpoint: the whole provider entry is ours to write -------------------------------

/** What an admin declared for one custom endpoint, as the issuer serializes it into the run's
 * environment. The second model exercises the everything-omitted case. */
const DECLARED_MODELS = [
  {
    id: "@cf/meta/llama-4",
    label: "Llama 4",
    reasoning: false,
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    price: { input: 0.27, output: 0.85, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false },
  },
  { id: "@cf/llava", vision: true },
];

function customEnv(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    RYPH_MODEL_PROVIDER_CONFIG: JSON.stringify({
      id: "cloudflare",
      dialect: "openai-completions",
      models: DECLARED_MODELS,
    }),
    RYPH_MODEL_BASE_URL: "http://model-proxy.test:7420/v1",
    ...overrides,
  };
  return (name: string) => env[name];
}

test("pi: a custom endpoint gets a complete entry, its key a reference to the env var", () => {
  const config = proxyModelsConfig({ kind: "pi", provider: "cloudflare" }, customEnv());
  assert(config !== null);
  assertEquals(config.provider, "cloudflare");
  assertEquals(config.baseUrl, "http://model-proxy.test:7420/v1");
  // The brand-scoped key var the adapter has to carry into pi's spawn env itself.
  assertEquals(config.keyEnv, "RYPH_MODEL_API_KEY");
  const provider = (config.models.providers as Record<string, Record<string, unknown>>).cloudflare;
  assertEquals(provider.baseUrl, "http://model-proxy.test:7420/v1");
  assertEquals(provider.api, "openai-completions");
  // pi has no env convention for a provider it does not know, so the entry references the
  // variable — `$NAME`, which pi expands from the environment; a bare name pi would send as the
  // key itself — never the token.
  assertEquals(provider.apiKey, "$RYPH_MODEL_API_KEY");
  assert(!JSON.stringify(config.models).includes("ryph-vk-"), "no token may reach the file");
});

test("pi: a provider blob that speaks the Responses API is written through as such", () => {
  // No custom row can say so today, but the blob is the slot a non-OpenAI-named provider that
  // speaks Responses arrives through, and pi takes the value as its own `api` verbatim.
  const config = proxyModelsConfig(
    { kind: "pi", provider: "cloudflare" },
    customEnv({
      RYPH_MODEL_PROVIDER_CONFIG: JSON.stringify({
        id: "cloudflare",
        dialect: "openai-responses",
        models: DECLARED_MODELS,
      }),
    }),
  );
  assert(config !== null);
  const provider = (config.models.providers as Record<string, Record<string, unknown>>).cloudflare;
  assertEquals(provider.api, "openai-responses");
  assertEquals(provider.baseUrl, "http://model-proxy.test:7420/v1");
});

test("pi: a ChatGPT plan run is a complete Responses entry on the proxy, keyed by its env var", () => {
  // Exactly the blob @ryph/model-proxy's issuer writes for a `chatgpt-plan` key: pi has no such
  // provider of its own, so it rides the custom-endpoint path, and the proxy holds the plan.
  const config = proxyModelsConfig(
    { kind: "pi", provider: "chatgpt-plan" },
    customEnv({
      RYPH_MODEL_PROVIDER_CONFIG: JSON.stringify({
        id: "chatgpt-plan",
        dialect: "openai-responses",
        models: [
          {
            id: "gpt-6.1-sol",
            label: "GPT-6.1 Sol",
            contextWindow: 400_000,
            reasoning: true,
            vision: true,
          },
          { id: "gpt-6.1-mini", label: "GPT-6.1 mini" },
        ],
      }),
    }),
  );
  assert(config !== null);
  assertEquals(config.provider, "chatgpt-plan");
  assertEquals(config.keyEnv, "RYPH_MODEL_API_KEY");
  assertEquals(config.models, {
    providers: {
      "chatgpt-plan": {
        // pi POSTs `<baseUrl>/responses`: the proxy's `/v1/responses`, the plan's one route.
        baseUrl: "http://model-proxy.test:7420/v1",
        api: "openai-responses",
        apiKey: "$RYPH_MODEL_API_KEY",
        models: [
          {
            id: "gpt-6.1-sol",
            name: "GPT-6.1 Sol",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 400_000,
          },
          // Nothing said of reasoning: pi's own default, not a guess.
          { id: "gpt-6.1-mini", name: "GPT-6.1 mini" },
        ],
      },
    },
  });
});

test("pi: declared models translate to pi's shape, omitted fields left to pi's defaults", () => {
  const config = proxyModelsConfig({ kind: "pi", provider: "cloudflare" }, customEnv());
  assert(config !== null);
  const provider = (config.models.providers as Record<string, Record<string, unknown>>).cloudflare;
  assertEquals(provider.models, [
    {
      id: "@cf/meta/llama-4",
      name: "Llama 4",
      reasoning: false,
      contextWindow: 131_072,
      maxTokens: 8_192,
      cost: { input: 0.27, output: 0.85, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false },
    },
    // vision ⇒ the modality list; everything the admin left unset is simply absent.
    { id: "@cf/llava", input: ["text", "image"] },
  ]);
});

test("pi: declared thinking levels become pi's thinkingLevelMap, and say the model reasons", () => {
  const config = proxyModelsConfig(
    { kind: "pi", provider: "cloudflare" },
    customEnv({
      RYPH_MODEL_PROVIDER_CONFIG: JSON.stringify({
        id: "cloudflare",
        dialect: "openai-completions",
        models: [
          { id: "thinker", thinkingLevels: ["low", "medium", "high", "max"] },
          { id: "plain", thinkingLevels: ["off"] },
          // What the admin said of reasoning stands over what the levels imply.
          { id: "said", reasoning: true, thinkingLevels: ["off"] },
        ],
      }),
    }),
  );
  assert(config !== null);
  const provider = (config.models.providers as Record<string, Record<string, unknown>>).cloudflare;
  assertEquals(provider.models, [
    {
      id: "thinker",
      reasoning: true,
      // Taken and left to pi's own effort: low, medium, high. Named to exist: max. Not taken:
      // every other level, nulled.
      thinkingLevelMap: { off: null, minimal: null, xhigh: null, max: "max" },
    },
    {
      id: "plain",
      reasoning: false,
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
    },
    {
      id: "said",
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
    },
  ]);
  // Every level taken: only the two that must be named are.
  assertEquals(
    thinkingLevelMap(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    { xhigh: "xhigh", max: "max" },
  );
});

test("pi: the ant-ling thinking format names every level taken, the way pi's own models do", () => {
  // pi-ai's Chat Completions sends an ant-ling effort only for a level the map gives a string.
  assertEquals(thinkingLevelMap(["off", "low", "high"], "ant-ling"), {
    off: "off",
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  });
  const mapOf = (provider: string, compat?: Record<string, unknown>) => {
    const config = proxyModelsConfig(
      { kind: "pi", provider },
      customEnv({
        RYPH_MODEL_PROVIDER_CONFIG: JSON.stringify({
          id: provider,
          dialect: "openai-completions",
          models: [{ id: "ling", thinkingLevels: ["low", "high"], ...(compat ? { compat } : {}) }],
        }),
      }),
    );
    const entry = (config!.models.providers as Record<string, { models: JsonObject[] }>)[provider];
    return entry.models[0].thinkingLevelMap;
  };
  // Set on the model, or detected by pi from the provider (the base URL is always the proxy's).
  assertEquals((mapOf("cloudflare", { thinkingFormat: "ant-ling" }) as JsonObject).low, "low");
  assertEquals((mapOf("ant-ling") as JsonObject).low, "low");
  // Any other format leaves taken levels to pi's own effort; an explicit one beats detection.
  assert(!("low" in (mapOf("cloudflare") as JsonObject)));
  assert(!("low" in (mapOf("ant-ling", { thinkingFormat: "openai" }) as JsonObject)));

  // A reasoning model declared without levels takes pi's default ones; ant-ling has them named,
  // any other format has no map at all, and one that does not reason has none either way.
  const unsaid = (provider: string, model: Record<string, unknown>) => {
    const config = proxyModelsConfig(
      { kind: "pi", provider },
      customEnv({
        RYPH_MODEL_PROVIDER_CONFIG: JSON.stringify({
          id: provider,
          dialect: "openai-completions",
          models: [{ id: "ling", ...model }],
        }),
      }),
    );
    return (config!.models.providers as Record<string, { models: JsonObject[] }>)[provider]
      .models[0];
  };
  assertEquals(unsaid("ant-ling", { reasoning: true }), {
    id: "ling",
    reasoning: true,
    thinkingLevelMap: {
      off: "off",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
  });
  assertEquals(unsaid("cloudflare", { reasoning: true }), { id: "ling", reasoning: true });
  assertEquals(unsaid("ant-ling", { reasoning: false }), { id: "ling", reasoning: false });
  assertEquals(unsaid("ant-ling", {}), { id: "ling" });
});

test("pi: a thinking level this pi does not know is dropped with a warning, not fatal", async () => {
  const blob = JSON.stringify({
    id: "cloudflare",
    dialect: "openai-completions",
    models: [
      { id: "m", thinkingLevels: ["low", "extreme", "high"] },
      { id: "only-new", thinkingLevels: ["extreme"] },
      { id: "plain" },
    ],
  });
  const config = proxyModelsConfig(
    { kind: "pi", provider: "cloudflare" },
    customEnv({ RYPH_MODEL_PROVIDER_CONFIG: blob }),
  );
  assert(config !== null);
  assertEquals(config.unknownLevels, { m: ["extreme"], "only-new": ["extreme"] });
  const models = (config.models.providers as Record<string, { models: JsonObject[] }>)
    .cloudflare.models;
  // The known ones stand; a model left with none is one whose levels are not known.
  assertEquals(models[0].thinkingLevelMap, {
    off: null,
    minimal: null,
    medium: null,
    xhigh: null,
    max: null,
  });
  assertEquals(models[1], { id: "only-new" });
  // A blob with every level known says nothing of it.
  assert(
    !("unknownLevels" in proxyModelsConfig({ kind: "pi", provider: "cloudflare" }, customEnv())!),
  );

  // Writing the config dir warns with what was dropped.
  const names = ["RYPH_MODEL_PROVIDER_CONFIG", "RYPH_MODEL_BASE_URL", "RYPH_MODEL_API_KEY"];
  runtimeCredentials.set("RYPH_MODEL_PROVIDER_CONFIG", blob);
  runtimeCredentials.set("RYPH_MODEL_BASE_URL", "http://model-proxy.test:7420/v1");
  runtimeCredentials.set("RYPH_MODEL_API_KEY", "ryph-vk-1");
  const warned: Array<[string, unknown]> = [];
  try {
    const { dir } = await writePiConfigDir(
      { kind: "pi", provider: "cloudflare" },
      { appendix: "", defaultTools: [] },
      { debug: () => {}, warn: (event, detail) => warned.push([event, detail]) },
    );
    await rm(dir, { recursive: true });
  } finally {
    for (const name of names) runtimeCredentials.delete(name);
  }
  assertEquals(warned.length, 1);
  const [event, detail] = warned[0] as [string, Record<string, unknown>];
  assertEquals(event, "pi.thinking_levels.unknown");
  assertEquals(detail.provider, "cloudflare");
  assertStringIncludes(String(detail.message), 'The custom endpoint "cloudflare" declares');
  assertEquals(detail.models, { m: ["extreme"], "only-new": ["extreme"] });
  assertStringIncludes(String(detail.message), "rebuild the environment");
});

test("pi: a run's thinking level this runner does not know is left off argv, with a warning", async () => {
  const args = (thinking?: string) =>
    piArgs({ kind: "pi", model: "m", thinking }, {
      session: null,
      skillFiles: [],
      extensions: { mcp: "/mcp.ts", images: "/images.ts" },
      mcp: false,
      appendixPath: "/appendix.md",
    });
  // A known level still rides `--thinking`, right after the model.
  const known = args("high");
  assertEquals(known.slice(known.indexOf("--thinking"), known.indexOf("--thinking") + 2), [
    "--thinking",
    "high",
  ]);
  // An unknown one is dropped: pi runs at the model's default.
  assert(!args("extreme").includes("--thinking"));
  assert(!args("extreme").includes("extreme"));
  assert(!args().includes("--thinking"));

  const warnedFor = async (thinking: string) => {
    const warned: Array<[string, unknown]> = [];
    const { dir } = await writePiConfigDir(
      { kind: "pi", thinking },
      { appendix: "", defaultTools: [] },
      { debug: () => {}, warn: (event, detail) => warned.push([event, detail]) },
    );
    await rm(dir, { recursive: true });
    return warned;
  };
  assertEquals(await warnedFor("high"), []);
  const warned = await warnedFor("extreme");
  assertEquals(warned.length, 1);
  const [event, detail] = warned[0] as [string, Record<string, unknown>];
  assertEquals(event, "pi.thinking_level.unknown");
  assertEquals(detail.level, "extreme");
  assertStringIncludes(String(detail.message), 'The thinking level "extreme" is not known');
  assertStringIncludes(String(detail.message), "harness's default level");
  assertStringIncludes(String(detail.message), "rebuild the environment");

  // The level is any flag-safe string the platform passed through: the message the person reads
  // carries it JSON-quoted and cut short, and the `level` field keeps it whole.
  const long = `x".${"y".repeat(60)}`;
  const [[, longDetail]] = (await warnedFor(long)) as Array<[string, Record<string, unknown>]>;
  assertEquals(longDetail.level, long);
  assertStringIncludes(
    String(longDetail.message),
    `The thinking level ${JSON.stringify(`${long.slice(0, 32)}…`)} is not known`,
  );
  assert(!String(longDetail.message).includes(long));
});

test("pi: a broken custom provider refuses the run by name, never falls through to null", () => {
  const spec = { kind: "pi", provider: "cloudflare" } as const;
  const cases: Array<[Record<string, string | undefined>, string]> = [
    [{ RYPH_MODEL_PROVIDER_CONFIG: "{not json" }, "is not JSON"],
    [{ RYPH_MODEL_PROVIDER_CONFIG: '"cloudflare"' }, "is not a provider object"],
    [
      { RYPH_MODEL_PROVIDER_CONFIG: JSON.stringify({ dialect: "openai-completions", models: [] }) },
      "has no provider id",
    ],
    [
      {
        RYPH_MODEL_PROVIDER_CONFIG: JSON.stringify({
          id: "elsewhere",
          dialect: "openai-completions",
          models: DECLARED_MODELS,
        }),
      },
      'the run\'s spec asks for "cloudflare"',
    ],
    [
      {
        RYPH_MODEL_PROVIDER_CONFIG: JSON.stringify({
          id: "cloudflare",
          dialect: "grpc",
          models: DECLARED_MODELS,
        }),
      },
      "no dialect pi speaks",
    ],
    [
      {
        RYPH_MODEL_PROVIDER_CONFIG: JSON.stringify({
          id: "cloudflare",
          dialect: "openai-completions",
          models: [],
        }),
      },
      "declares no models",
    ],
    [
      {
        RYPH_MODEL_PROVIDER_CONFIG: JSON.stringify({
          id: "cloudflare",
          dialect: "openai-completions",
          models: [{ name: "nameless" }],
        }),
      },
      "a model with no id",
    ],
    [
      {
        RYPH_MODEL_PROVIDER_CONFIG: JSON.stringify({
          id: "cloudflare",
          dialect: "openai-completions",
          models: [{ id: "m", thinkingLevels: "high" }],
        }),
      },
      "thinking levels that are not a list",
    ],
    [{ RYPH_MODEL_BASE_URL: undefined }, "RYPH_MODEL_BASE_URL is unset"],
  ];
  for (const [overrides, message] of cases) {
    assertThrows(
      () => proxyModelsConfig(spec, customEnv(overrides)),
      Error,
      message,
      `a broken blob must name the fault: ${message}`,
    );
  }
});

// --- tools: mcp.json, the -e extension, and the token in the spawn env only ---------------------

const TOOLS: HarnessTools = {
  servers: [
    { slug: "linear", name: "Linear", url: "http://gw.test:7430/v1/mcp/run-1/linear" },
    { slug: "github", name: "GitHub", url: "http://gw.test:7430/v1/mcp/run-1/github" },
  ],
  // brand-scoped on purpose: the same scrub that hides the run token from setup steps must hide
  // this one from pi's env too — pi gets the token under MCP_GATEWAY_TOKEN, and only that
  tokenEnv: "RYPH_MCP_TOKEN",
};
const EXTENSION = "/opt/ryph/pi-mcp/index.ts";
const IMAGES_EXTENSION = "/opt/ryph/pi-mcp/images.ts";

/** Every path pi was handed with `-e`, in order. */
function extensionsOf(args: string[]): string[] {
  return args.flatMap((arg, i) => arg === "-e" ? [args[i + 1]] : []);
}

/** The introspect scenario: the fake reports its env and config dir. */
function introspectCommand(): string[] {
  return [
    process.execPath,
    "--no-env-file",
    FAKE_PI,
    "--scenario=introspect",
  ];
}

interface Introspection {
  args: string[];
  /** The images the task's prompt carried, as the fake read them off stdin. */
  images: unknown[];
  /** The appendix file's contents — what pi reads `--append-system-prompt <path>` as. */
  appendix: string | null;
  prompt: string;
  mcpToken: string | null;
  brandVars: string[];
  files: Record<string, string>;
}

/** The system-prompt appendix a spawn was handed, as pi reads it. */
const appendixOf = (seen: Introspection): string => seen.appendix ?? "";

/** The finish ask, verbatim. Spelled out here because the whole point of the instruction is the
 * two concrete tests it names — "nothing more is expected" was neither. */
const FINISH_ASK = "This run can be spoken to: messages from people and the platform " +
  "arrive as you work, and once you have nothing more to do the run waits for the next one. " +
  "End the run with ryph__finish as soon as what you were asked for is delivered and complete " +
  "in itself — a review, an answer, a triage comment, or a finding that no change is needed — " +
  "or as soon as you know you cannot do it and have said why. Ending your message is not " +
  "ending the run: until you call ryph__finish, the run keeps waiting. A later request starts " +
  "a new run with the whole thread in front of it, so nothing is lost by ending. Keep the run " +
  "open only when you are waiting on something that continues THIS work: you shipped a change " +
  "with ryph__submit_patch and expect review feedback on it, you asked a question you need " +
  "answered to proceed, or you set a wake-up with ryph__wake_me to look at something again. " +
  "An answer that offers to do more — options to choose from, a plan to approve, an offer to " +
  "make the change — is waiting on that reply, so keep the run open. " +
  "Asking a person to take the task over is not one of those: finish as failed.";

/** The outcome ask, verbatim: a run says how it went through its tools, judged against what it
 * was asked for, and a run that stays open to wait reports "in-progress" while work remains. */
const OUTCOME_ASK = "Record the outcome through the reporting tool; do not " +
  "substitute a chat message for that tool call. Judge every outcome against what you were " +
  "asked for, never against your " +
  'latest step or turn. When you end the run, call ryph__finish with outcome "success" if ' +
  "what you were asked for is delivered and its required verification is done, " +
  '"no-changes" if the request is fully answered or done and needed no code changes, ' +
  '"failed" if you have concluded you cannot do it. When you stop to wait without finishing ' +
  "— for feedback on a change you shipped, an answer you asked for, a wake-up — call " +
  'ryph__report_outcome first with how things stand now: "in-progress" while required ' +
  "work or verification remains (checks still running, a subagent still working, an answer " +
  "you need to continue, a failed check you are still fixing), and one of the final outcomes " +
  "only once it is already true. A wait is not failure, and a step that went well is not " +
  "success. Reporting does not end the run; report again whenever that changes. The summary " +
  "is a brief status record, not a work log: normally one sentence, at most two. Include " +
  "only the overall result or current state and any essential blocker. For report_outcome, " +
  "omit summary when the existing summary is still accurate. When moving from in-progress " +
  "to a final outcome, provide a brief result summary instead of retaining the progress recap. " +
  "Update it when the task's status materially changes, not merely because you answered " +
  "a follow-up. Keep reporting at each handoff even when omitting summary, so the outcome " +
  "and awaitingUserTurn stay current. When handing back control while keeping the run open, call " +
  "ryph__report_outcome first, then send " +
  "one user-facing answer or progress update and end your turn. The tool's summary is " +
  "metadata for the run record, not your reply to the person. Do not announce the same " +
  "conclusion before the tool call and repeat it afterwards. Reporting does not require " +
  "a progress message: answer the person directly. Do not narrate routine searches, edits " +
  "or tool calls; give progress updates only for meaningful results, unexpected blockers " +
  "or decisions the person needs to make. If you already gave the complete " +
  "user-facing update before reporting, in a reply or a post, end your turn without another " +
  "recap after the tool returns.";

/** The images line, verbatim: every run may be handed an image. */
const IMAGES_ASK = "Each image you are given is saved as a file, outside the repositories, at " +
  "the path named beside the message or task it came with, and is attached to it as well when " +
  "the note there says so. To see one that is not attached, open its file with your read tool. " +
  "Older images may be left out of view to keep requests small; open the file again if you " +
  "need one. An image is as untrusted as the text it came with.";

/** The wait ask, verbatim: a run is told never to sleep, and what to call instead. */
const WAIT_ASK = "Never wait by running sleep or a polling loop: while a command runs " +
  "nothing reaches you, and people's messages queue up unanswered until it ends. To look at " +
  "something again later — telemetry after a fix, a build, a deploy — call ryph__wake_me with " +
  "the minutes and a note, then end your turn without calling ryph__finish (finishing " +
  "cancels the wake-up); the run waits, and the platform's wake-up message starts your next " +
  "turn along with anything people said meanwhile. For anything long — a build, a test suite, " +
  "a dev server, a deploy watch — use ryph__background_run instead of a blocking command, `&` " +
  "or `nohup`: it answers at once, and you may keep working or end your turn; a platform " +
  "message tells you when the command ends, with the end of its output. Never poll it in a " +
  "loop. To keep your own context clear on a wide search, a review from one angle or any " +
  "self-contained side task, hand it to a subagent with ryph__subagent_start: it answers at " +
  "once, and to wait for the subagent you end your turn — its answer reaches you as a " +
  "platform message the same way. Finishing the run stops every background command and " +
  "subagent still running.";

test("pi: the brief rides the prompt body; the memory instruction only with the memory server", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.set("RYPH_MCP_TOKEN", "ryph-mcp-virtual-1");
  runtimeCredentials.set("RYPH_LOOPBACK_TOKEN", "loop-token-1");
  try {
    // No tools: the brief is in the prompt, after the task, and nothing asks for memory tools.
    const plain: Introspection = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() }).run(input, io)).summary,
    );
    assert(
      plain.prompt.startsWith("# Fix the bug\n\nDo the thing.\n\n## What previous runs learned"),
    );
    assert(plain.prompt.includes("[mem-1] use deno task ci"));
    assert(!appendixOf(plain).includes("memory__propose"));
    // Without the runner's own tools there is no way to end or report, so nothing asks for it.
    assert(!appendixOf(plain).includes("ryph__finish"));

    // Tools without the memory server: still no instruction — the agent has no such tool.
    const other: Introspection = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() })
        .run({ ...input, tools: TOOLS }, io)).summary,
    );
    assert(!appendixOf(other).includes("memory__propose"));

    // The memory server in scope: the instruction says what the tools are for.
    const withMemory: Introspection = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() }).run({
        ...input,
        tools: {
          ...TOOLS,
          servers: [...TOOLS.servers, {
            slug: "memory",
            name: "Memory",
            url: "http://gw.test:7430/v1/mcp/run-1/memory",
          }],
        },
      }, io)).summary,
    );
    assert(appendixOf(withMemory).includes("memory__propose"));
    assert(appendixOf(withMemory).includes('"introduced"'));
    // Only a run holding the forge tools can have posted in its thread: only it is asked
    // whether the status comment should repeat the summary.
    assert(!appendixOf(withMemory).includes('pass comment: "minimal"'));

    // With the forge tools: the finish and outcome asks verbatim, and the status-comment choice
    // as the tools' `comment`.
    const talkingForge: Introspection = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() }).run({
        ...input,
        tools: {
          ...TOOLS,
          loopback: TOOLS_WITH_LOOPBACK.loopback,
          servers: [...TOOLS.servers, {
            slug: "forge",
            name: "Issues & pull requests",
            url: "http://gw.test:7430/v1/mcp/run-1/forge",
          }],
        },
      }, io)).summary,
    );
    const talkingForgeAsk = appendixOf(talkingForge);
    assert(talkingForgeAsk.includes(FINISH_ASK));
    assert(talkingForgeAsk.includes(OUTCOME_ASK));
    assert(talkingForgeAsk.includes('pass comment: "minimal" with the outcome'));
    // Forge-neutral: a Radicle run is not told it came from a pull request.
    assert(talkingForgeAsk.includes("issue or change request"));
    assert(talkingForgeAsk.includes("a Radicle patch"));
    assert(talkingForgeAsk.includes("a GitLab merge request"));

    // No brief: no section, and the prompt ends with the instructions.
    const briefless: Introspection = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() })
        .run({ ...input, brief: null }, io)).summary,
    );
    assertEquals(briefless.prompt, "# Fix the bug\n\nDo the thing.");
  } finally {
    runtimeCredentials.delete("RYPH_MCP_TOKEN");
    runtimeCredentials.delete("RYPH_LOOPBACK_TOKEN");
    await cleanup();
  }
});

// pi's own prompt calls the agent "an expert coding assistant operating inside pi", and a live
// incident run believed it: it did not know it was a ryph agent, and told the Telegram group it
// was talking in that it had not seen anything sent to it on Telegram. The block that says who
// and where it is leads the appendix, and names only the tool families the run holds.
test("pi: the appendix opens with who the agent is and the tool families it holds", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.set("RYPH_MCP_TOKEN", "ryph-mcp-virtual-1");
  runtimeCredentials.set("RYPH_LOOPBACK_TOKEN", "loop-token-1");
  const server = (slug: string) => ({ slug, name: slug, url: `http://gw.test:7430/${slug}` });
  try {
    const bare = appendixOf(JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() }).run(input, io)).summary,
    ));
    const first = bare.split("\n\n")[0];
    assert(first.startsWith("You are Ada, an agent run by Ryph. Ryph is a platform"), first);
    // No tools, no tool families — and no room, without a chat.
    assert(!first.includes("__"), first);
    assert(!bare.includes("Telegram") && !bare.includes("Zulip") && !bare.includes("Slack"), bare);

    const held = appendixOf(JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() }).run({
        ...input,
        tools: {
          ...TOOLS,
          servers: [...TOOLS.servers, server("forge"), server("memory")],
          loopback: TOOLS_WITH_LOOPBACK.loopback,
        },
      }, io)).summary,
    )).split("\n\n")[0];
    assertStringIncludes(held, "Tools prefixed `ryph__` are the platform's own;");
    assertStringIncludes(
      held,
      "`forge__` and `memory__` tools reach the platform's forge and memory services.",
    );
    assert(!held.includes("chat__"), "a run without the chat server is not told of it");
  } finally {
    runtimeCredentials.delete("RYPH_MCP_TOKEN");
    runtimeCredentials.delete("RYPH_LOOPBACK_TOKEN");
    await cleanup();
  }
});

test("pi: a run bound to a chat is told which room it is, per kind, and how people reach it", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.set("RYPH_MCP_TOKEN", "ryph-mcp-virtual-1");
  const tools: HarnessTools = {
    ...TOOLS,
    servers: [...TOOLS.servers, { slug: "chat", name: "Chat", url: "http://gw.test:7430/chat" }],
  };
  try {
    const telegram = appendixOf(JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() }).run({
        ...input,
        tools,
        chat: { kind: "telegram", roomTitle: "Ops war room", botHandle: "ryph_ada_bot" },
      }, io)).summary,
    ));
    const [intro, room] = telegram.split("\n\n");
    assertStringIncludes(intro, "`chat__` tools reach the platform's chat service.");
    assert(
      room.startsWith(
        'This run is bound to the Telegram group "Ops war room", where you are the bot ' +
          "@ryph_ada_bot.",
      ),
      room,
    );
    assertStringIncludes(
      room,
      "only when they mention @ryph_ada_bot or reply to one of your posts",
    );
    assertStringIncludes(room, "ask them to mention you");
    assertStringIncludes(room, "chat__post posts into the group, signed with your name");
    assertStringIncludes(room, "a post is your answer to them: once you have posted it, end your");
    assert(!room.includes("Nothing is posted"), "a room that is not quiet hears the closing line");

    // A quiet room posts nothing when the run succeeds: the agent is told to answer there itself.
    const quiet = appendixOf(JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() }).run({
        ...input,
        tools,
        chat: { kind: "zulip", roomTitle: "Radicle", botHandle: "Ada", quiet: true },
      }, io)).summary,
    )).split("\n\n")[1];
    assertStringIncludes(
      quiet,
      "Nothing is posted to the topic when this run finishes successfully, not even your " +
        "summary, so post your answer or result there yourself with chat__post before you finish.",
    );

    const zulip = appendixOf(JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() }).run({
        ...input,
        tools,
        chat: { kind: "zulip", roomTitle: "Radicle", botHandle: "Ada" },
      }, io)).summary,
    )).split("\n\n")[1];
    assert(
      zulip.startsWith(
        'This run is bound to a topic in the Zulip organization "Radicle", where you are "Ada".',
      ),
      zulip,
    );
    assertStringIncludes(zulip, "(@**Ada**) in that topic");
    assertStringIncludes(zulip, "chat__post posts into the topic");

    const slack = appendixOf(JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() }).run({
        ...input,
        tools,
        chat: { kind: "slack", roomTitle: "Acme", botHandle: "ryph" },
      }, io)).summary,
    )).split("\n\n")[1];
    assert(
      slack.startsWith(
        'This run is bound to a thread in the Slack workspace "Acme", where you are the app ' +
          "@ryph.",
      ),
      slack,
    );
    assertStringIncludes(slack, "(@ryph) in that thread");
    assertStringIncludes(slack, "chat__post posts into the thread");
    // Slack renders mrkdwn, not Markdown, and the agent is told so where it can post.
    assertStringIncludes(slack, "*one asterisk* as bold");

    const discord = appendixOf(JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() }).run({
        ...input,
        tools,
        chat: { kind: "discord", roomTitle: "Acme", botHandle: "ryph" },
      }, io)).summary,
    )).split("\n\n")[1];
    assert(
      discord.startsWith(
        'This run is bound to a thread in the Discord server "Acme", where you are the bot ' +
          "@ryph.",
      ),
      discord,
    );
    assertStringIncludes(discord, "(@ryph) in that thread or reply to one of your posts");
    assertStringIncludes(discord, "chat__post posts into the thread");
    // Discord's ceiling and its silent mentions are the agent's to know.
    assertStringIncludes(discord, "at most 2000 characters");
    assertStringIncludes(discord, "notifies nobody");

    // Bound to a room but without the chat tools: told where it is, not told to post.
    const mute = appendixOf(JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() }).run({
        ...input,
        chat: {
          kind: "telegram",
          roomTitle: "Ops war room",
          botHandle: "ryph_ada_bot",
          quiet: true,
        },
      }, io)).summary,
    ));
    assertStringIncludes(mute, 'the Telegram group "Ops war room"');
    // Quiet or not, a run that cannot post is not told to.
    assert(!mute.includes("chat__post"), mute);
  } finally {
    runtimeCredentials.delete("RYPH_MCP_TOKEN");
    await cleanup();
  }
});

test("pi: mcp.json names the gateway URL per server and the token as an env reference", () => {
  const config = mcpConfig(TOOLS) as { mcpServers: Record<string, unknown> };
  assertEquals(config, {
    mcpServers: {
      linear: {
        url: "http://gw.test:7430/v1/mcp/run-1/linear",
        headers: { Authorization: "Bearer ${MCP_GATEWAY_TOKEN}" },
      },
      github: {
        url: "http://gw.test:7430/v1/mcp/run-1/github",
        headers: { Authorization: "Bearer ${MCP_GATEWAY_TOKEN}" },
      },
    },
  });
});

test("pi: with tools, the extension loads by path, mcp.json is written, and the token rides the spawn env only", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.set("RYPH_MCP_TOKEN", "ryph-mcp-virtual-1");
  try {
    const outcome = await piHarness({ kind: "pi" }, { command: introspectCommand() })
      .run({ ...input, tools: TOOLS }, io);
    const seen: Introspection = JSON.parse(outcome.summary);

    // ryph's extensions, the only ones that load, by explicit path, with --no-extensions still
    // in force: the images one in every run, the MCP one because there are tools
    assertEquals(extensionsOf(seen.args), [IMAGES_EXTENSION, EXTENSION]);
    assert(seen.args.includes("--no-extensions"));

    // the token: under the harness-facing name, and under nothing brand-scoped
    assertEquals(seen.mcpToken, "ryph-mcp-virtual-1");
    assertEquals(seen.brandVars, []);

    // the file: servers and an env reference, never the token itself
    const mcpJson = seen.files["mcp.json"];
    assert(mcpJson, `config dir held ${Object.keys(seen.files).join(", ")}`);
    assert(!mcpJson.includes("ryph-mcp-virtual-1"), "the token must not land in the file");
    assertEquals(JSON.parse(mcpJson), mcpConfig(TOOLS));
    // no model proxy in this run, so no models.json rides along
    assertEquals(seen.files["models.json"], undefined);
  } finally {
    runtimeCredentials.delete("RYPH_MCP_TOKEN");
    await cleanup();
  }
});

test("pi: a pi that took -e and loaded nothing is a warning, not a silent toolless run", async () => {
  const { input, cleanup } = await makeInput();
  runtimeCredentials.set("RYPH_MCP_TOKEN", "ryph-mcp-virtual-1");
  try {
    // the healthy shape first: the extension says "ready" on stderr, and nothing is warned
    const healthy = recordingIo();
    await piHarness({ kind: "pi" }, { command: fakeCommand("happy") })
      .run({ ...input, tools: TOOLS }, healthy.io);
    assertEquals(healthy.warnings, []);

    // and the one failure in this path that is otherwise silent: pi starts, the run proceeds,
    // the model simply has no tools — and nothing bounds the images its requests carry
    const toolless = recordingIo();
    await piHarness({ kind: "pi" }, { command: fakeCommand("no-extension") })
      .run({ ...input, tools: TOOLS }, toolless.io);
    assertEquals(toolless.warnings, ["pi.mcp_extension.silent", "pi.images_extension.silent"]);

    // A run without tools still loads the images extension, and is warned for its silence alone.
    const plain = recordingIo();
    await piHarness({ kind: "pi" }, { command: fakeCommand("happy") }).run(input, plain.io);
    assertEquals(plain.warnings, []);
    const unbounded = recordingIo();
    await piHarness({ kind: "pi" }, { command: fakeCommand("no-extension") })
      .run(input, unbounded.io);
    assertEquals(unbounded.warnings, ["pi.images_extension.silent"]);
  } finally {
    runtimeCredentials.delete("RYPH_MCP_TOKEN");
    await cleanup();
  }
});

test("pi: without tools, only the images extension, no mcp.json, no MCP token", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  try {
    const outcome = await piHarness({ kind: "pi" }, { command: introspectCommand() })
      .run(input, io);
    const seen: Introspection = JSON.parse(outcome.summary);
    assertEquals(extensionsOf(seen.args), [IMAGES_EXTENSION]);
    assertEquals(seen.mcpToken, null);
    assertEquals(seen.files["mcp.json"], undefined);
  } finally {
    await cleanup();
  }
});

test("pi: opts.mcpExtension relocates both extensions for a checkout outside the image", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.set("RYPH_MCP_TOKEN", "t");
  try {
    const outcome = await piHarness({ kind: "pi" }, {
      command: introspectCommand(),
      mcpExtension: "/checkout/packages/pi-mcp/index.ts",
    }).run({ ...input, tools: TOOLS }, io);
    const seen: Introspection = JSON.parse(outcome.summary);
    assertEquals(extensionsOf(seen.args), [
      "/checkout/packages/pi-mcp/images.ts",
      "/checkout/packages/pi-mcp/index.ts",
    ]);
  } finally {
    runtimeCredentials.delete("RYPH_MCP_TOKEN");
    await cleanup();
  }
});

test("pi: tools without the parked token is refused by name, before anything spawns", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.delete("RYPH_MCP_TOKEN");
  try {
    // a binary that does not exist: had the adapter spawned, the error would say so instead
    const err = await assertRejects(
      () =>
        piHarness({ kind: "pi" }, { command: ["no-such-binary-anywhere"] })
          .run({ ...input, tools: TOOLS }, io),
      Error,
    );
    assert(err.message.includes("RYPH_MCP_TOKEN"), `unexpected message: ${err.message}`);
  } finally {
    await cleanup();
  }
});

/** The runner's own tool server beside the gateway's: two env references, two tokens. */
const TOOLS_WITH_LOOPBACK: HarnessTools = {
  ...TOOLS,
  loopback: { url: "http://127.0.0.1:41234/mcp", tokenEnv: "RYPH_LOOPBACK_TOKEN" },
};

test("pi: the addresses the config dir points pi at are named as direct, gateway included", async () => {
  const { input, cleanup } = await makeInput();
  try {
    const withTools: HarnessInput = { ...input, tools: TOOLS_WITH_LOOPBACK };
    const hosts = configuredHosts(
      { kind: "pi", provider: "anthropic" },
      withTools,
      (name) => name === "ANTHROPIC_BASE_URL" ? "http://model-proxy.ryph.svc:7420" : undefined,
    );
    // The gateway once, not once per server: this list becomes NO_PROXY.
    assertEquals(hosts, ["model-proxy.ryph.svc", "gw.test", "127.0.0.1"]);
  } finally {
    await cleanup();
  }
});

test("pi: a custom endpoint's host is named as direct as well", async () => {
  const { input, cleanup } = await makeInput();
  try {
    const hosts = configuredHosts(
      { kind: "pi", provider: "cloudflare" },
      input,
      customEnv({ RYPH_MODEL_BASE_URL: "http://model-proxy.ryph.svc:7420/v1" }),
    );
    assertEquals(hosts, ["model-proxy.ryph.svc"]);
  } finally {
    await cleanup();
  }
});

test("pi: a run with neither tools nor a model proxy names no address of its own", async () => {
  const { input, cleanup } = await makeInput();
  try {
    assertEquals(configuredHosts({ kind: "pi" }, input, () => undefined), []);
  } finally {
    await cleanup();
  }
});

test("pi: mcp.json carries the runner's own tool server under `ryph`, with its own env reference", () => {
  const config = mcpConfig(TOOLS_WITH_LOOPBACK) as { mcpServers: Record<string, unknown> };
  assertEquals(config.mcpServers.ryph, {
    url: "http://127.0.0.1:41234/mcp",
    headers: { Authorization: "Bearer ${MCP_LOOPBACK_TOKEN}" },
  });
  assertEquals(Object.keys(config.mcpServers), ["linear", "github", "ryph"]);
});

test("pi: the loopback alone loads the extension; its token rides the spawn env under its own name", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.set("RYPH_LOOPBACK_TOKEN", "loop-token-1");
  runtimeCredentials.delete("RYPH_MCP_TOKEN");
  try {
    // No gateway servers: the gateway token is not required, and the extension still loads.
    const only: HarnessTools = {
      servers: [],
      tokenEnv: "RYPH_MCP_TOKEN",
      loopback: TOOLS_WITH_LOOPBACK.loopback,
    };
    const seen: Introspection & { loopbackToken: string | null } = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() })
        .run({ ...input, tools: only }, io)).summary,
    );
    assert(extensionsOf(seen.args).includes(EXTENSION));
    assertEquals(seen.loopbackToken, "loop-token-1");
    assertEquals(seen.mcpToken, null);
    assertEquals(seen.brandVars, []);
    assertEquals(JSON.parse(seen.files["mcp.json"]), mcpConfig(only));
    // The patch tools are explained, and both tests, verbatim: when to end, and the only two
    // reasons to stay open. And how to wait without blocking, and how to say how it went.
    const appendix = appendixOf(seen);
    assert(appendix.includes("ryph__submit_patch"));
    assert(appendix.includes(FINISH_ASK));
    assert(appendix.includes(WAIT_ASK));
    assert(appendix.includes(IMAGES_ASK));
    assertEquals(appendix.split("\n\n").at(-1), OUTCOME_ASK);
  } finally {
    runtimeCredentials.delete("RYPH_LOOPBACK_TOKEN");
    await cleanup();
  }
});

test("pi: an unattended run is told to finish once its work is submitted, not to wait for review", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.set("RYPH_LOOPBACK_TOKEN", "loop-token-1");
  const only: HarnessTools = {
    servers: [],
    tokenEnv: "RYPH_MCP_TOKEN",
    loopback: TOOLS_WITH_LOOPBACK.loopback,
  };
  const appendix = async (patch: Partial<HarnessInput>): Promise<string> =>
    appendixOf(JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() })
        .run({ ...input, tools: only, ...patch }, io)).summary,
    ));
  const UNATTENDED = "Nobody is following this run";
  try {
    // Attended (every door but an automation without a response): the ask as it was.
    const attended = await appendix({});
    assert(attended.includes(FINISH_ASK));
    assert(!attended.includes(UNATTENDED));

    // Lines are told of where the run may ship a branch of its own; a fork pull request's head
    // ships onto that pull request alone, and is told so instead.
    const LINES = "Keep unrelated changes apart: put each on its own branch";
    assertStringIncludes(attended, LINES);
    // After a merge the agent moves its own work: ryph fetches, the agent rebases.
    assertStringIncludes(
      attended,
      "rebase your branch onto it with the command ryph's message names",
    );
    assertStringIncludes(attended, "Plain `git rebase` is expected.");
    // Starting fresh: the new branch is submitted before the old one goes.
    assertStringIncludes(
      attended,
      "move your later commits there and submit it with ryph__submit_patch; only once that " +
        "submit is accepted, delete the old branch",
    );
    // A fresh branch is a line of its own, not the old one's next change request.
    assertStringIncludes(
      attended,
      "A new branch ships as a change request of its own, never as the next one of the old branch.",
    );
    assert(!attended.includes("never reset or rebase"), attended);
    const fork = await appendix({ repos: input.repos.map((r) => ({ ...r, forkHead: true })) });
    assert(!fork.includes(LINES), fork);
    assertStringIncludes(fork, "ryph__submit_patch refuses any other branch here");

    const alone = await appendix({ unattended: true });
    assert(!alone.includes("expect review feedback"), "promises a review");
    assertStringIncludes(
      alone,
      "Nobody is following this run, so no review feedback will reach it. Once your change is " +
        "submitted with ryph__submit_patch, call ryph__finish.",
    );
    assert(!alone.includes("If checks you asked for are still running"));
    // Nobody is there to answer a question, so none is worth staying open for.
    assert(!alone.includes("you asked a question"), alone);
    assert(!alone.includes("An answer that offers to do more"), alone);
    assertStringIncludes(alone, "continues THIS work: you set a wake-up with ryph__wake_me");

    // Where checks run, it is told the run still brings it their results first.
    const checked = await appendix({
      unattended: true,
      checksEnabled: true,
      checksDeclared: { declared: [], unread: ["repo"] },
    });
    assert(!checked.includes("expect review feedback"));
    assertStringIncludes(checked, "If checks you asked for are still running, the run waits");
    assert(!checked.includes("you asked a question"), checked);
    assertStringIncludes(checked, "waiting for the results, or you set a wake-up");

    // Artifacts are told of only where the run may publish them.
    const ARTIFACTS =
      "You can publish artifacts: HTML pages in Ryph that everyone on this instance";
    assert(!attended.includes(ARTIFACTS));
    // Without the design skill in the run, nothing tells it to read one.
    const publishing = await appendix({ canPublishArtifacts: true });
    assertStringIncludes(publishing, ARTIFACTS);
    assertStringIncludes(publishing, "ryph__publish_artifact");
    assertStringIncludes(publishing, "ryph__fetch_artifact");
    assertStringIncludes(publishing, "only as the img- ref a tool showed you");
    assert(!publishing.includes("ryph-artifact-design"), publishing);
    assertStringIncludes(publishing, "Never put secrets");
    const withSkill = await appendix({
      canPublishArtifacts: true,
      skills: [
        {
          name: "ryph-artifact-design",
          description: "How to design an artifact",
          source: "catalogue",
          dir: "/skills/ryph-artifact-design",
        } as HarnessInput["skills"][number],
      ],
    });
    assertStringIncludes(withSkill, "Read the ryph-artifact-design skill");

    // A run that ships nothing finishes when its work is done.
    const reading = await appendix({ unattended: true, canOpenPatches: false });
    assertStringIncludes(reading, "Nobody is following this run: call ryph__finish as soon as");
    assert(!reading.includes("ryph__submit_patch"));
    assert(!reading.includes("you asked a question"), reading);

    // One that ships nothing reads checks and runs none: no run_checks, no wait for them.
    const reviewing = await appendix({
      unattended: true,
      canOpenPatches: false,
      checksEnabled: true,
      checksDeclared: { declared: [], unread: ["repo"] },
    });
    assertStringIncludes(reviewing, "ryph__check_status shows the checks on what each repository");
    assertStringIncludes(reviewing, "ryph__check_log");
    assert(!reviewing.includes("ryph__run_checks"), reviewing);
    assert(!reviewing.includes("If checks you asked for are still running"), reviewing);
    // and nothing at all where no repo has checks
    const noChecks = await appendix({
      canOpenPatches: false,
      checksEnabled: true,
      checksDeclared: { declared: [], unread: [] },
    });
    assert(!noChecks.includes("ryph__check_status"), noChecks);
  } finally {
    runtimeCredentials.delete("RYPH_LOOPBACK_TOKEN");
    await cleanup();
  }
});

test("pi: an interactive run is told that answering is not finishing", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.set("RYPH_LOOPBACK_TOKEN", "loop-token-1");
  const only: HarnessTools = {
    servers: [],
    tokenEnv: "RYPH_MCP_TOKEN",
    loopback: TOOLS_WITH_LOOPBACK.loopback,
  };
  const appendix = async (patch: Partial<HarnessInput>): Promise<string> =>
    appendixOf(JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() })
        .run({ ...input, tools: only, ...patch }, io)).summary,
    ));
  try {
    for (const patch of [{}, { canOpenPatches: false }]) {
      const talking = await appendix({ interactive: true, ...patch });
      assert(!talking.includes(FINISH_ASK));
      assert(!talking.includes("as soon as what you were asked for is delivered"), talking);
      assertStringIncludes(talking, "This run is a conversation");
      assertStringIncludes(talking, "Answering is not finishing.");
      assertStringIncludes(
        talking,
        "Call ryph__finish only when they say they are done or ask you to end the run",
      );
      // An idle end still has its outcome: reported at every turn's end, "in-progress" while
      // work remains, a final outcome once it is done.
      assertStringIncludes(talking, "Call ryph__report_outcome each time you end your turn");
      assertStringIncludes(
        talking,
        '"in-progress" while you still have work or verification to do or need their answer',
      );
      assertStringIncludes(talking, '"success" or "no-changes" once it is done');
      assertStringIncludes(
        talking,
        "the run ends on its own as you last reported, and work still in progress then ends " +
          "unfinished.",
      );
    }
  } finally {
    runtimeCredentials.delete("RYPH_LOOPBACK_TOKEN");
    await cleanup();
  }
});

test("pi: every run with the loopback is told what in-progress means, and that a wait is not failure", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.set("RYPH_LOOPBACK_TOKEN", "loop-token-1");
  const only: HarnessTools = {
    servers: [],
    tokenEnv: "RYPH_MCP_TOKEN",
    loopback: TOOLS_WITH_LOOPBACK.loopback,
  };
  const appendix = async (patch: Partial<HarnessInput>): Promise<string> =>
    appendixOf(JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() })
        .run({ ...input, tools: only, ...patch }, io)).summary,
    ));
  try {
    const patches: Partial<HarnessInput>[] = [
      {},
      { unattended: true },
      { interactive: true },
      { canOpenPatches: false },
    ];
    for (const patch of patches) {
      const told = await appendix(patch);
      const label = JSON.stringify(patch);
      // Judged against the request, never the latest step.
      assertStringIncludes(
        told,
        "Judge every outcome against what you were asked for, never against your latest step " +
          "or turn",
        label,
      );
      // A report is what is true now: in-progress while work remains, a final word only once
      // it is true.
      assertStringIncludes(
        told,
        'call ryph__report_outcome first with how things stand now: "in-progress" while ' +
          "required work or verification remains",
        label,
      );
      assertStringIncludes(told, "a failed check you are still fixing", label);
      assertStringIncludes(told, "one of the final outcomes only once it is already true", label);
      assertStringIncludes(
        told,
        "A wait is not failure, and a step that went well is not success.",
        label,
      );
      assertStringIncludes(told, "Reporting does not end the run", label);
      // finish takes only the final words, each said against the deliverable.
      assertStringIncludes(
        told,
        'call ryph__finish with outcome "success" if what you were asked for is delivered and ' +
          "its required verification is done",
        label,
      );
      assertStringIncludes(told, '"failed" if you have concluded you cannot do it', label);
      // The old ask — report the outcome true "if nobody comes back" — is gone: it read as a
      // guess at how the run ends.
      assert(!told.includes("the outcome that is true if nobody comes back"), label);
    }
    // A run that ships nothing has no change to wait on feedback for, in-progress or not.
    const unshipping = await appendix({ canOpenPatches: false });
    assert(!unshipping.includes("for feedback on a change you shipped"), unshipping);
    assertStringIncludes(
      unshipping,
      "for an answer you asked for, a wake-up — call ryph__report_outcome first",
    );
  } finally {
    runtimeCredentials.delete("RYPH_LOOPBACK_TOKEN");
    await cleanup();
  }
});

test("pi: a run that may not open patches is told so, and nothing invites it to ship", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.set("RYPH_LOOPBACK_TOKEN", "loop-token-1");
  const only: HarnessTools = {
    servers: [],
    tokenEnv: "RYPH_MCP_TOKEN",
    loopback: TOOLS_WITH_LOOPBACK.loopback,
  };
  try {
    const seen: Introspection = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() })
        .run({ ...input, tools: only, canOpenPatches: false }, io)).summary,
    );
    const appendix = appendixOf(seen);
    assertStringIncludes(
      appendix,
      "You cannot open patches or change requests in this run",
    );
    assertStringIncludes(appendix, "call ryph__checkout_change_request FIRST");
    // Every paragraph that would promise shipping is swapped, not merely left out of the
    // tool list: a reworded source would otherwise slip back in unnoticed.
    assert(!appendix.includes("change you shipped"), "promises shipping");
    assert(!appendix.includes("ships as"), "promises shipping");
    for (const tool of ["submit_patch", "update_from_base", "patches", "environment_status"]) {
      assert(!appendix.includes(`ryph__${tool}`), `mentions ${tool}`);
    }
  } finally {
    runtimeCredentials.delete("RYPH_LOOPBACK_TOKEN");
    await cleanup();
  }
});

test("pi: checks are told only where a repo declares some, next to their commands", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.set("RYPH_LOOPBACK_TOKEN", "loop-token-1");
  const only: HarnessTools = {
    servers: [],
    tokenEnv: "RYPH_MCP_TOKEN",
    loopback: TOOLS_WITH_LOOPBACK.loopback,
  };
  const appendix = async (patch: Partial<HarnessInput>): Promise<string> =>
    appendixOf(JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() })
        .run({ ...input, ...patch }, io)).summary,
    ));
  const api = {
    path: "api",
    repoRef: "acme/api",
    checksRef: "main",
    setup: ["npm ci"],
    checks: [
      { name: "lint", run: "npm run lint", timeoutSeconds: 600, services: [] },
      { name: "test", run: "npm test\nnpm run e2e", timeoutSeconds: 90, services: ["postgres"] },
    ],
  };
  const docs = { path: "docs", repoRef: "acme/docs", checksRef: "main", setup: [], checks: [] };
  const checksDeclared = { declared: [api, docs], unread: [] };
  const checksOf = (text: string) =>
    text.split("\n\n").filter((part) => part.includes(".ryph/checks.yml"));
  // The finish ask names waiting on checks too; it is checked on its own below.
  const howOf = (text: string) =>
    text.split("\n\n").filter((part) =>
      part.includes("ryph__run_checks") && !part.startsWith("This run can be spoken to")
    );
  const WAITS_ON_CHECKS = "you ran ryph__run_checks and are waiting for the results,";
  const UNKNOWN = "If a repository has a .ryph/checks.yml, it defines checks. Don't run their " +
    "commands yourself: commit, call ryph__run_checks, and end your turn. The results arrive " +
    "as the next message.";
  try {
    const off = await appendix({ tools: only });
    assertEquals(checksOf(off), []);
    assertEquals(howOf(off), []);

    // A repo declares checks: one block, the commands first, the instructions after them.
    const on = await appendix({ tools: only, checksEnabled: true, checksDeclared });
    assertStringIncludes(on, "These repositories define checks");
    assertStringIncludes(on, "api (acme/api, .ryph/checks.yml on main):");
    assertStringIncludes(on, "- setup, before the checks: `npm ci`");
    assertStringIncludes(on, "- lint: `npm run lint` (timeout 10m)");
    assertStringIncludes(
      on,
      "- test: `npm test; npm run e2e` (timeout 90s; services: `postgres`)",
    );
    assert(!on.includes("docs (acme/docs"), "a repo without checks is not listed");
    const block = howOf(on);
    assertEquals(block.length, 1, "one paragraph about checks");
    const how = block[0];
    assert(how.startsWith("Checks run in a clean container of their own. Don't run a check's"));
    // the likely-broken ones by name first, in one call; all of them before a patch
    assertStringIncludes(how, "commit, call ryph__run_checks, and end your turn.");
    assertStringIncludes(how, "Start with the checks your change most likely breaks");
    assertStringIncludes(how, "by naming them in `checks`");
    assertStringIncludes(
      how,
      "since a new call on " +
        "a branch replaces the one before it on that branch",
    );
    assert(!how.includes("with that check's name"));
    assert(!how.includes("`repo`"), "one repo: no repo to name");
    assertStringIncludes(how, "Commit whenever you want a check to look at your work.");
    assert(!how.includes("stay private"));
    assertStringIncludes(how, "Running a single test yourself while you debug is fine.");
    assertStringIncludes(how, "Only a run of all of them counts for a patch");
    assertStringIncludes(
      how,
      "checks that already passed on that commit are usually not run again",
    );
    assertStringIncludes(how, "shows as failing on its change request");
    assertStringIncludes(
      how,
      "don't weaken or skip it: submit anyway and say in the patch's description which check " +
        "fails and why.",
    );
    // an urgent fix opens its patch first; the hold still brings it the results
    assertStringIncludes(how, "If the change is urgent, such as a hotfix");
    assertStringIncludes(how, "so you can fix it, commit and submit again.");
    assert(on.indexOf("- lint:") < on.indexOf("Don't run a check's command yourself"));
    // a finish waits for the results, and the finish ask names waiting on checks
    assertStringIncludes(how, "If you call ryph__finish while checks are still running");
    assertStringIncludes(on, WAITS_ON_CHECKS);
    // that block and that clause are the whole difference
    assertEquals(
      on.split("\n\n").filter((part) =>
        !part.startsWith("Checks run") && !part.startsWith("api (") &&
        !part.startsWith("These repositories")
      ).join("\n\n"),
      off.replace(
        "you shipped a change with ryph__submit_patch and expect review feedback on it, ",
        "you shipped a change with ryph__submit_patch and expect review feedback on it, " +
          WAITS_ON_CHECKS + " ",
      ),
    );

    // More than one repo: the call names the repository.
    const two = await appendix({
      tools: only,
      checksEnabled: true,
      checksDeclared,
      repos: [input.repos[0], { ...input.repos[0], path: "docs" }],
    });
    assertStringIncludes(
      howOf(two)[0],
      "commit, call ryph__run_checks naming the repository in `repo`, and end your turn.",
    );

    // No repo declares any and every file was read: nothing about checks anywhere, and the
    // plain finish ask.
    for (const known of [{ declared: [], unread: [] }, { declared: [docs], unread: [] }]) {
      const none = await appendix({ tools: only, checksEnabled: true, checksDeclared: known });
      assertEquals(checksOf(none), []);
      assertEquals(howOf(none), []);
      assertEquals(none, off);
    }

    // Nothing could be read: one cautious line, and the finish ask still names waiting on
    // checks.
    const unknown = await appendix({ tools: only, checksEnabled: true, checksDeclared: null });
    assertEquals(checksOf(unknown), [UNKNOWN]);
    assertStringIncludes(unknown, WAITS_ON_CHECKS);
    assertEquals(checksOf(await appendix({ tools: only, checksEnabled: true })), [UNKNOWN]);
    // ...and the same where the platform answered that it could not read any of them
    assertEquals(
      checksOf(
        await appendix({
          tools: only,
          checksEnabled: true,
          checksDeclared: { declared: [], unread: ["*"] },
        }),
      ),
      [UNKNOWN],
    );

    // Only some files could not be read, none declares any: the line names those repos.
    const someUnread = await appendix({
      tools: only,
      checksEnabled: true,
      checksDeclared: { declared: [], unread: ["web", "docs"] },
    });
    assertEquals(checksOf(someUnread), [
      UNKNOWN.replace("If a repository has", "If web or docs has"),
    ]);
    assertStringIncludes(someUnread, WAITS_ON_CHECKS);

    // Some declare checks and some could not be read: the block, then one line for the rest.
    const mixed = await appendix({
      tools: only,
      checksEnabled: true,
      checksDeclared: { declared: [api], unread: ["web"] },
    });
    const mixedParts = mixed.split("\n\n");
    const mixedHow = mixedParts.findIndex((part) => part.startsWith("Checks run"));
    assertEquals(
      mixedParts[mixedHow + 1],
      "If web has a .ryph/checks.yml, it defines checks too: run them the same way.",
    );
    assertEquals(
      checksOf(
        await appendix({
          tools: only,
          checksEnabled: true,
          checksDeclared: { declared: [api], unread: ["*"] },
        }),
      ).at(-1),
      "If another repository has a .ryph/checks.yml, it defines checks too: run them the same " +
        "way.",
    );

    // never where checks do not run, and never without the loopback to call them through
    assertEquals(await appendix({ tools: only, checksDeclared }), off);
    assert(!(await appendix({ checksEnabled: true, checksDeclared })).includes("ryph__run_checks"));
  } finally {
    runtimeCredentials.delete("RYPH_LOOPBACK_TOKEN");
    await cleanup();
  }
});

test("pi: the loopback without its parked token is refused by name, before anything spawns", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.delete("RYPH_LOOPBACK_TOKEN");
  try {
    const err = await assertRejects(
      () =>
        piHarness({ kind: "pi" }, { command: ["no-such-binary-anywhere"] })
          .run({
            ...input,
            tools: {
              servers: [],
              tokenEnv: "RYPH_MCP_TOKEN",
              loopback: TOOLS_WITH_LOOPBACK.loopback,
            },
          }, io),
      Error,
    );
    assert(err.message.includes("RYPH_LOOPBACK_TOKEN"), `unexpected message: ${err.message}`);
  } finally {
    await cleanup();
  }
});

// --- the browser: a third local tool server, its own token, and the appendix only when true ----

const BROWSER_TOOLS = { url: "http://127.0.0.1:7490/mcp", tokenEnv: "RYPH_BROWSER_TOKEN" };

test("pi: mcp.json carries the browser under `browser`, after the gateway's, with its own env reference", () => {
  const config = mcpConfig({ ...TOOLS_WITH_LOOPBACK, browser: BROWSER_TOOLS }) as {
    mcpServers: Record<string, unknown>;
  };
  assertEquals(config.mcpServers.browser, {
    url: "http://127.0.0.1:7490/mcp",
    headers: { Authorization: "Bearer ${MCP_BROWSER_TOKEN}" },
  });
  assertEquals(Object.keys(config.mcpServers), ["linear", "github", "ryph", "browser"]);
  // An operator's gateway server slugged `browser` gives way to the platform's.
  const clash = mcpConfig({
    servers: [{ slug: "browser", name: "Theirs", url: "http://gw.test/browser" }],
    tokenEnv: "RYPH_MCP_TOKEN",
    browser: BROWSER_TOOLS,
  }) as { mcpServers: Record<string, { url: string }> };
  assertEquals(clash.mcpServers.browser.url, "http://127.0.0.1:7490/mcp");
});

test("pi: a ready browser rides the spawn env under its own name and gets its appendix block", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.set("RYPH_LOOPBACK_TOKEN", "loop-token-1");
  runtimeCredentials.set("RYPH_BROWSER_TOKEN", "browser-token-1");
  try {
    const tools: HarnessTools = {
      servers: [],
      tokenEnv: "RYPH_MCP_TOKEN",
      loopback: TOOLS_WITH_LOOPBACK.loopback,
      browser: BROWSER_TOOLS,
    };
    const seen: Introspection & { browserToken: string | null } = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() })
        .run({ ...input, tools, browser: "ready" }, io)).summary,
    );
    assertEquals(seen.browserToken, "browser-token-1");
    assertEquals(seen.brandVars, []);
    assertEquals(JSON.parse(seen.files["mcp.json"]), mcpConfig(tools));
    assert(
      !seen.files["mcp.json"].includes("browser-token-1"),
      "the token must not land in the file",
    );
    const appendix = appendixOf(seen);
    assert(appendix.includes("## Your browser"), appendix);
    assert(appendix.includes("shares your localhost"), appendix);
    assert(appendix.includes("never to stand in for the user"), appendix);
    assert(appendix.includes("may be watching"), appendix);
    // and its host stays off the egress proxy with the rest of the platform's
    assert(
      configuredHosts({ kind: "pi" }, { ...input, tools }, () => undefined).includes("127.0.0.1"),
    );

    // A browser that never came up: one line, and no tools to point at.
    const failed: Introspection & { browserToken: string | null } = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() })
        .run({ ...input, tools: { ...tools, browser: undefined }, browser: "failed" }, io))
        .summary,
    );
    assertEquals(failed.browserToken, null);
    assert(!appendixOf(failed).includes("## Your browser"));
    assert(appendixOf(failed).includes("failed to start"), appendixOf(failed));
    assertEquals(JSON.parse(failed.files["mcp.json"]).mcpServers.browser, undefined);

    // No browser at all: not a word about one.
    const none: Introspection = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() })
        .run({ ...input, tools: { ...tools, browser: undefined } }, io)).summary,
    );
    assert(!appendixOf(none).includes("browser"), appendixOf(none));
  } finally {
    runtimeCredentials.delete("RYPH_LOOPBACK_TOKEN");
    runtimeCredentials.delete("RYPH_BROWSER_TOKEN");
    await cleanup();
  }
});

test("pi: a browser without its parked token is refused by name, before anything spawns", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.delete("RYPH_BROWSER_TOKEN");
  try {
    const err = await assertRejects(
      () =>
        piHarness({ kind: "pi" }, { command: ["no-such-binary-anywhere"] })
          .run({
            ...input,
            tools: { servers: [], tokenEnv: "RYPH_MCP_TOKEN", browser: BROWSER_TOOLS },
            browser: "ready",
          }, io),
      Error,
    );
    assert(err.message.includes("RYPH_BROWSER_TOKEN"), `unexpected message: ${err.message}`);
  } finally {
    await cleanup();
  }
});

/** A hand-driven conversation for the adapter: messages fed by the test, `done` at its say. */
function conversationIo(signal?: AbortSignal) {
  const { io, chunks } = collectIo(signal);
  const queue: HarnessMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const done = new AbortController();
  let settles = 0;
  const conversation = {
    messages: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (closed) return;
          await new Promise<void>((resolve) => (wake = resolve));
        }
      },
    },
    done: done.signal,
    onSettled: () => void settles++,
  };
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    io: { ...io, conversation },
    chunks,
    settles: () => settles,
    say(text: string, images?: HarnessImages) {
      queue.push(images === undefined ? { text } : { text, images });
      notify();
    },
    end() {
      done.abort();
      closed = true;
      notify();
    },
    /** Closes the queue alone, as the core does on a cancel. */
    close() {
      closed = true;
      notify();
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

test("pi: a rejected credential fails the run at its settle, not after the idle clock", async () => {
  const { input, cleanup } = await makeInput();
  const side = conversationIo();
  try {
    // The conversation never ends on its own: only the adapter giving up can settle this.
    await assertRejects(
      () =>
        piHarness({ kind: "pi" }, { command: fakeCommand("stop-auth-error") }).run(input, side.io),
      Error,
      "invalid x-api-key",
    );
    assertEquals(side.settles(), 0);
  } finally {
    side.close();
    await cleanup();
  }
});

test("pi: any other error stop waits for the next message, and throws only at the run's end", async () => {
  const { input, cleanup } = await makeInput();
  const side = conversationIo();
  const running = piHarness({ kind: "pi" }, { command: fakeCommand("stop-error") })
    .run(input, side.io);
  try {
    await until(() => side.settles() === 1, "the error settle");
    side.end();
    await assertRejects(() => running, Error, "provider exploded");
  } finally {
    side.close();
    await running.catch(() => {});
    await cleanup();
  }
});

test("pi: credentialRejected knows a refused key from other provider errors", () => {
  for (
    const message of [
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      "403 Forbidden",
      "401 Incorrect API key provided",
      '{"type":"error","error":{"type":"permission_error","message":"no access"}}',
    ]
  ) assert(credentialRejected(message), message);
  for (
    const message of [
      undefined,
      "provider exploded",
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "429 rate limited",
      "400 prompt is too long: 4010 tokens",
      "4010 something",
    ]
  ) assert(!credentialRejected(message), String(message));
});

test("pi: a startup backlog and later idle bursts wait for correlated acceptance AND agent start", async () => {
  const { input, cleanup } = await makeInput();
  const side = conversationIo();
  const ctrl = new AbortController();
  const replies = () => side.chunks.filter((c) => c.kind === "assistant").map((c) => c.text);
  side.say("provisioning message one");
  side.say("provisioning message two");
  const running = piHarness({ kind: "pi" }, { command: fakeCommand("delayed-start") })
    .run(input, { ...side.io, signal: ctrl.signal });
  try {
    await until(() => replies().length === 3, "startup backlog");
    side.say("idle burst one");
    side.say("idle burst two");
    await until(() => replies().length === 5, "idle burst");
    assertEquals(replies(), [
      "Initial task started",
      "Re(steer): provisioning message one",
      "Re(steer): provisioning message two",
      "Re(steer): idle burst one",
      "Re(steer): idle burst two",
    ]);
    side.end();
    assertEquals((await running).interrupted, false);
  } finally {
    ctrl.abort();
    side.close();
    await running.catch(() => {});
    await cleanup();
  }
});

test("pi: cancellation releases startup acceptance with messages buffered", async () => {
  const { input, cleanup } = await makeInput();
  const ctrl = new AbortController();
  const side = conversationIo(ctrl.signal);
  side.say("buffered");
  const running = piHarness({ kind: "pi" }, { command: fakeCommand("delayed-cancel") })
    .run(input, side.io);
  try {
    await until(() => side.chunks.some((c) => c.text === "Preparing"), "preflight");
    ctrl.abort();
    assertEquals((await running).interrupted, true);
  } finally {
    ctrl.abort();
    side.close();
    await running.catch(() => {});
    await cleanup();
  }
});

test("pi: image-bearing startup and buffered follow-up survive delayed preparation", async () => {
  const { input, cleanup } = await makeInput();
  const ctrl = new AbortController();
  const side = conversationIo(ctrl.signal);
  side.say("image follow-up", imagesOf("follow-up"));
  const running = piHarness({ kind: "pi" }, { command: fakeCommand("delayed-start") })
    .run({ ...input, taskImages: imagesOf("task") }, side.io);
  try {
    await until(
      () => side.chunks.some((c) => c.text?.includes("image follow-up") === true),
      "image follow-up",
    );
    const reply = side.chunks.find((c) => c.text?.includes("image follow-up"))!;
    assertStringIncludes(reply.text!, IMAGE.path);
    side.end();
    assertEquals((await running).interrupted, false);
  } finally {
    ctrl.abort();
    side.close();
    await running.catch(() => {});
    await cleanup();
  }
});

for (const scenario of ["delayed-reject", "delayed-exit"]) {
  test(`pi: ${scenario} fails with a buffered startup message`, async () => {
    const { input, cleanup } = await makeInput();
    const side = conversationIo();
    side.say("must not disappear silently");
    try {
      await assertRejects(() =>
        piHarness({ kind: "pi" }, { command: fakeCommand(scenario) }).run(input, side.io)
      );
    } finally {
      side.close();
      await cleanup();
    }
  });
}

test("pi: a conversation keeps reading past the settle, relays messages as steer-prompts, and ends when told", async () => {
  const { input, cleanup } = await makeInput();
  const side = conversationIo();
  try {
    const running = piHarness({ kind: "pi" }, { command: fakeCommand("conversation") })
      .run(input, side.io);
    // the task's settle is reported, and the run is NOT over
    await until(() => side.settles() === 1, "the first settle");
    // a message becomes a new turn: pi answers it, and settles again
    side.say("look at the cache first");
    await until(() => side.settles() === 2, "the second settle");
    side.say("and the queue");
    await until(() => side.settles() === 3, "the third settle");
    // every relay went up as a prompt with steer semantics — the fake echoes the flag
    const replies = side.chunks.filter((c) => c.kind === "assistant").map((c) => c.text);
    assertEquals(replies, [
      "Ready when you are.",
      "Re(steer): look at the cache first",
      "Re(steer): and the queue",
    ]);
    // the core says the run is over while pi sits settled: stdin closes, pi exits, no throw
    side.end();
    const outcome = await running;
    assertEquals(outcome.interrupted, false);
    assertEquals(outcome.summary, "Re(steer): and the queue");
  } finally {
    await cleanup();
  }
});

test("pi: pi exiting between turns, with the run not over, is breakage and throws", async () => {
  const { input, cleanup } = await makeInput();
  const side = conversationIo();
  try {
    await assertRejects(
      () =>
        piHarness({ kind: "pi" }, { command: fakeCommand("conversation-exit") }).run(
          input,
          side.io,
        ),
      Error,
      "pi exited (code 3) while waiting for the next message: fake pi crashed between turns",
    );
    assertEquals(side.settles(), 1, "the settle was reported before pi went");
  } finally {
    side.end();
    await cleanup();
  }
});

test("pi: an abort while settled in a conversation lets pi go at once", async () => {
  const { input, cleanup } = await makeInput();
  const ctrl = new AbortController();
  const side = conversationIo(ctrl.signal);
  try {
    const running = piHarness({ kind: "pi" }, { command: fakeCommand("conversation") })
      .run(input, side.io);
    await until(() => side.settles() === 1, "the first settle");
    const at = Date.now();
    // The core closes the queue on a cancel, and `done` stays as it was: only the abort can let
    // the settled pi go before the kill grace.
    ctrl.abort();
    side.close();
    const outcome = await running;
    assertEquals(outcome.interrupted, true);
    assert(Date.now() - at < 5_000, "not held for the kill grace");
  } finally {
    side.end();
    await cleanup();
  }
});

test("pi: an abort mid-conversation returns interrupted, whatever the queue holds", async () => {
  const { input, cleanup } = await makeInput();
  const ctrl = new AbortController();
  const side = conversationIo(ctrl.signal);
  try {
    const running = piHarness({ kind: "pi" }, { command: fakeCommand("conversation") })
      .run(input, side.io);
    await until(() => side.settles() === 1, "the first settle");
    ctrl.abort();
    side.end(); // the core closes the queue on a cancel too
    const outcome = await running;
    assertEquals(outcome.interrupted, true);
  } finally {
    await cleanup();
  }
});

// Skills reach pi as explicit SKILL.md paths the core wrote, beside --no-skills, and ryph's own
// catalogue earns one line pointing at it — only when the run holds one of its skills.
test("pi: each skill is one --skill SKILL.md path, discovery stays off, and ryph's get a line", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  const skill = (name: string, source: "catalogue" | "org" | "repo"): HarnessSkill => ({
    ...(source === "repo" ? { source, path: "repo" } : { source }),
    name,
    description: `What ${name} is for.`,
    dir: `/tmp/ryph-skills-test/${name}`,
  });
  const seen = async (skills: HarnessSkill[]): Promise<Introspection> =>
    JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() }).run(
        { ...input, skills },
        io,
      )).summary,
    );
  try {
    const all = await seen([
      skill("ryph-checks", "catalogue"),
      skill("ryph-environment", "catalogue"),
      skill("release", "org"),
      skill("deploy", "repo"),
    ]);
    assert(all.args.includes("--no-skills"), "nothing is discovered");
    const paths = all.args.flatMap((arg, i) => arg === "--skill" ? [all.args[i + 1]] : []);
    assertEquals(paths, [
      "/tmp/ryph-skills-test/ryph-checks/SKILL.md",
      "/tmp/ryph-skills-test/ryph-environment/SKILL.md",
      "/tmp/ryph-skills-test/release/SKILL.md",
      "/tmp/ryph-skills-test/deploy/SKILL.md",
    ]);
    assertStringIncludes(
      appendixOf(all),
      "Before you create or change anything under .ryph/ in any repository, read the skill " +
        "that documents it (ryph-checks and ryph-environment).",
    );
    // The line sits after the machine block, with what the platform says about the machine.
    assert(appendixOf(all).indexOf("read the skill") > appendixOf(all).indexOf("## Your machine"));

    // The artifact skill is not about .ryph/, so the line leaves it out.
    const withArtifacts = await seen([
      skill("ryph-artifact-design", "catalogue"),
      skill("ryph-checks", "catalogue"),
    ]);
    assertStringIncludes(appendixOf(withArtifacts), "that documents it (ryph-checks).");
    const artifactsOnly = await seen([skill("ryph-artifact-design", "catalogue")]);
    assert(!appendixOf(artifactsOnly).includes(".ryph/"), appendixOf(artifactsOnly));

    // Org and repo skills alone: pi lists them, and ryph adds nothing about what they say.
    const theirs = await seen([skill("release", "org"), skill("deploy", "repo")]);
    assert(!appendixOf(theirs).includes(".ryph/"), appendixOf(theirs));
    const none = await seen([]);
    assert(!none.args.includes("--skill"));
    assert(none.args.includes("--no-skills"));
    assert(!appendixOf(none).includes("read the skill"));
  } finally {
    await cleanup();
  }
});

// Opt-in e2e against the real binary: PI_E2E=1 bun run test
// (needs pi and an API key in the environment). Spawns the
// harness layer's /opt/ryph/bin/pi unless PI_E2E_BIN names another — `pi` for one on PATH.
test.skipIf(process.env.PI_E2E !== "1")(
  "pi: real binary answers a trivial prompt (opt-in: PI_E2E=1)",
  async () => {
    const { input, cleanup } = await makeInput();
    const { io } = collectIo();
    try {
      const bin = process.env.PI_E2E_BIN;
      // A pi outside the layer loads ryph's extensions from this checkout: every run loads the
      // images one, found beside the MCP one.
      const checkout = new URL("../../pi-mcp/index.ts", import.meta.url).pathname;
      const outcome = await piHarness(
        { kind: "pi" },
        bin ? { command: [bin], mcpExtension: checkout } : {},
      ).run(
        { ...input, spec: { title: "Ping", instructions: "Reply with exactly: pong" } },
        io,
      );
      assert(outcome.summary.toLowerCase().includes("pong"), `summary was: ${outcome.summary}`);
    } finally {
      await cleanup();
    }
  },
);

// A real file: the adapter reads an image's bytes from it only when it sends the image inline.
const IMAGE_DIR = await mkdtemp(join(tmpdir(), "ryph-images-"));
const IMAGE: HarnessImage = {
  path: `${IMAGE_DIR}/1.png`,
  mime: "image/png",
  bytes: 4,
  dimensions: { width: 1, height: 1 },
};
await writeFile(IMAGE.path, Uint8Array.fromBase64("iVBORw=="));

// The adapter restates the images extension's budget (the extension is node code pi loads, not a
// module the runner may import); the import across packages is a test's.
test("pi: the inline budget is the images extension's", () => {
  assertEquals(INLINE_IMAGES, IMAGE_BUDGET);
});

test("pi: an image pi would re-encode counts at its resize ceiling, however small the file", () => {
  const ceiling = 4.5 * 1024 * 1024;
  const at = (bytes: number, dimensions: HarnessImage["dimensions"]) =>
    resizedChars({ ...IMAGE, bytes, dimensions });
  // Sent as it is: its own base64.
  assertEquals(at(300_000, { width: 2000, height: 1500 }), 400_000);
  // Over 2000 pixels on a side: re-encoded, and a PNG of it can outgrow the file.
  assertEquals(at(300_000, { width: 4000, height: 3000 }), ceiling);
  assertEquals(at(300_000, { width: 1500, height: 2001 }), ceiling);
  // Header unread: the worst case.
  assertEquals(at(300_000, null), ceiling);
  // At or over the ceiling as it is: re-encoded under it.
  assertEquals(at(4 * 1024 * 1024, { width: 100, height: 100 }), ceiling);
});

/** One image's note pair, as the core makes it: the form says which way it went. */
const imagesOf = (of: string): HarnessImages => ({
  images: [IMAGE],
  attached: `ATTACHED ${of}\n[image 1: ${IMAGE.path}]`,
  saved: `SAVED ${of}\n[image 1: ${IMAGE.path}]`,
});

test("pi: the task's images ride its prompt inline, and the note names their files under the instructions", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  try {
    const seen: Introspection = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() }).run({
        ...input,
        spec: { title: "Fix the bug", instructions: "See [image 1]." },
        taskImages: imagesOf("task"),
      }, io)).summary,
    );
    // pi's RPC shape: type, base64 data, mimeType. A fresh pi is idle: the prompt starts its
    // turn, so pi resizes them.
    assertEquals(seen.images, [{ type: "image", data: "iVBORw==", mimeType: "image/png" }]);
    assert(
      seen.prompt.startsWith(
        `# Fix the bug\n\nSee [image 1].\n\nATTACHED task\n[image 1: ${IMAGE.path}]`,
      ),
    );
    assertStringIncludes(appendixOf(seen), "open its file with your read tool");

    // No images: none on the prompt, though the run is still told how images reach it (a
    // message may bring some).
    const plain: Introspection = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() }).run(input, io)).summary,
    );
    assertEquals(plain.images, []);
    assertStringIncludes(appendixOf(plain), "open its file with your read tool");
  } finally {
    await cleanup();
  }
});

test("pi: the task's images that would not fit one request together go up as files only", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  try {
    // The 4-byte image is 8 characters of base64: one under that is too many.
    for (const inlineImages of [{ chars: 7, count: 20 }, { chars: 1_000, count: 0 }]) {
      const seen: Introspection = JSON.parse(
        (await piHarness({ kind: "pi" }, { command: introspectCommand(), inlineImages }).run({
          ...input,
          spec: { title: "Fix the bug", instructions: "See [image 1]." },
          taskImages: imagesOf("task"),
        }, io)).summary,
      );
      assertEquals(seen.images, [], JSON.stringify(inlineImages));
      assertStringIncludes(
        seen.prompt,
        `See [image 1].\n\nSAVED task\n[image 1: ${IMAGE.path}]`,
      );
    }
  } finally {
    await cleanup();
  }
});

test("pi: a message's images ride inline only on a prompt to a settled pi", async () => {
  const { input, cleanup } = await makeInput();
  const side = conversationIo();
  try {
    const running = piHarness({ kind: "pi" }, { command: fakeCommand("conversation") })
      .run(input, side.io);
    await until(() => side.settles() === 1, "the first settle");
    side.say("what is this?", imagesOf("message"));
    await until(() => side.settles() === 2, "the second settle");
    side.say("and without one");
    await until(() => side.settles() === 3, "the third settle");
    const replies = side.chunks.filter((c) => c.kind === "assistant").map((c) => c.text);
    assertEquals(replies.slice(1), [
      "Re(steer)[image:image/png:8]: what is this?\n\nATTACHED message\n" +
      `[image 1: ${IMAGE.path}]`,
      "Re(steer): and without one",
    ]);
    side.end();
    await running;
  } finally {
    await cleanup();
  }
});

test("pi: a message that arrives mid-turn carries its images as files only — pi would not resize a steer's", async () => {
  const { input, cleanup } = await makeInput();
  const side = conversationIo();
  try {
    const running = piHarness({ kind: "pi" }, { command: fakeCommand("conversation-busy") })
      .run(input, side.io);
    await until(
      () => side.chunks.some((c) => c.kind === "assistant" && c.text === "Working on it."),
      "the task's turn",
    );
    assertEquals(side.settles(), 0);
    side.say("look at this", imagesOf("message"));
    await until(() => side.settles() === 1, "the settle after the steer");
    // Settled now: the next message starts a turn, and its images go inline.
    side.say("and this", imagesOf("message"));
    await until(() => side.settles() === 2, "the second settle");
    const replies = side.chunks.filter((c) => c.kind === "assistant").map((c) => c.text);
    assertEquals(replies.slice(1), [
      `Steered(steer): look at this\n\nSAVED message\n[image 1: ${IMAGE.path}]`,
      "Re(steer)[image:image/png:8]: and this\n\nATTACHED message\n" +
      `[image 1: ${IMAGE.path}]`,
    ]);
    side.end();
    await running;
  } finally {
    await cleanup();
  }
});

test("pi: the inline limit is each prompt's own: earlier images never count, a prompt past it goes as files", async () => {
  const { input, cleanup } = await makeInput();
  const side = conversationIo();
  try {
    // Room for one image per prompt. What the images sent before add up to is the images
    // extension's to bound, request by request — not a reason to send a later one as a file.
    const running = piHarness({ kind: "pi" }, {
      command: fakeCommand("conversation"),
      inlineImages: { chars: 1_000, count: 1 },
    }).run({ ...input, taskImages: imagesOf("task") }, side.io);
    await until(() => side.settles() === 1, "the first settle");
    side.say("one", imagesOf("message"));
    await until(() => side.settles() === 2, "the second settle");
    side.say("two", imagesOf("message"));
    await until(() => side.settles() === 3, "the third settle");
    // ...and all of a message's images or none: two at once do not fit.
    side.say("three", { ...imagesOf("message"), images: [IMAGE, IMAGE] });
    await until(() => side.settles() === 4, "the fourth settle");
    const replies = side.chunks.filter((c) => c.kind === "assistant").map((c) => c.text);
    assertEquals(replies.slice(1).map((r) => r!.split("\n")[0] + " " + r!.split("\n")[2]), [
      "Re(steer)[image:image/png:8]: one ATTACHED message",
      "Re(steer)[image:image/png:8]: two ATTACHED message",
      "Re(steer): three SAVED message",
    ]);
    side.end();
    await running;
  } finally {
    await cleanup();
  }
});

test("pi: an image whose file is gone goes as a file, with a warning, and the run goes on", async () => {
  const { input, cleanup } = await makeInput();
  const rec = recordingIo();
  try {
    const gone: HarnessImage = { ...IMAGE, path: `${IMAGE_DIR}/gone.png` };
    const seen: Introspection = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() }).run({
        ...input,
        spec: { title: "Fix the bug", instructions: "See [image 1]." },
        taskImages: { ...imagesOf("task"), images: [gone] },
      }, rec.io)).summary,
    );
    assertEquals(seen.images, []);
    assertStringIncludes(seen.prompt, "SAVED task");
    assertEquals(rec.warnings, ["pi.images.read_failed"]);
  } finally {
    await cleanup();
  }
});

test("pi: an image a tool returned is narrated as a note of its size, never as its bytes", async () => {
  const { input, cleanup } = await makeInput();
  const { io, chunks } = collectIo();
  try {
    await piHarness({ kind: "pi" }, { command: fakeCommand("image-read") }).run(input, io);
    const result = chunks.find((c) => c.kind === "tool_result")!;
    assert(!JSON.stringify(result).includes("QUJDQUJD"), "no base64 in the transcript");
    assertStringIncludes(result.text!, "[20000 base64 chars omitted]");
    assertStringIncludes(JSON.stringify(result.raw), "Read image file");
  } finally {
    await cleanup();
  }
});

test("pi: the image-ref paragraph rides only a run whose tool images are kept", async () => {
  const { input, cleanup } = await makeInput();
  runtimeCredentials.set("RYPH_MCP_TOKEN", "ryph-mcp-virtual-1");
  runtimeCredentials.set("RYPH_LOOPBACK_TOKEN", "loop-token-1");
  try {
    const appendix = async (keeps: boolean) => {
      const { io } = collectIo();
      const withKeep = keeps
        ? { ...io, keepImage: () => Promise.resolve({ id: "att-1", mime: "image/png" as const }) }
        : io;
      return appendixOf(JSON.parse(
        (await piHarness({ kind: "pi" }, { command: introspectCommand() })
          .run({ ...input, tools: TOOLS_WITH_LOOPBACK }, withKeep))
          .summary,
      ));
    };
    const kept = await appendix(true);
    assertStringIncludes(kept, "is followed by a line `Image ref: img-…`");
    assertStringIncludes(
      kept,
      "That works in the summary you give ryph__finish or ryph__report_outcome",
    );
    assert(!(await appendix(false)).includes("Image ref:"));
  } finally {
    runtimeCredentials.delete("RYPH_MCP_TOKEN");
    runtimeCredentials.delete("RYPH_LOOPBACK_TOKEN");
    await cleanup();
  }
});

// A background command runs with the agent's own powers, so it is given exactly what pi was
// spawned with: the tokens pi's bash sees, and none of the runner's own.
test("pi: the env pi is spawned with is handed on as the agent's, for its background commands", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  let handed: Readonly<Record<string, string>> | null = null;
  io.onAgentEnv = (env) => (handed = env);
  runtimeCredentials.set("RYPH_MCP_TOKEN", "ryph-mcp-virtual-1");
  runtimeCredentials.set("RYPH_LOOPBACK_TOKEN", "loop-token-1");
  try {
    const seen: Introspection & { loopbackToken: string | null } = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() })
        .run({ ...input, tools: TOOLS_WITH_LOOPBACK }, io)).summary,
    );
    const env = handed as Readonly<Record<string, string>> | null;
    assert(env !== null, "handed at spawn");
    assertEquals(env.MCP_GATEWAY_TOKEN, seen.mcpToken);
    assertEquals(env.MCP_LOOPBACK_TOKEN, seen.loopbackToken);
    assertEquals(env.MCP_LOOPBACK_TOKEN, "loop-token-1");
    assertEquals(Object.keys(env).filter((k) => k.startsWith("RYPH_")), seen.brandVars);
  } finally {
    runtimeCredentials.delete("RYPH_MCP_TOKEN");
    runtimeCredentials.delete("RYPH_LOOPBACK_TOKEN");
    await cleanup();
  }
});

test("pi: a run on GitHub is told of pull requests, not of GitLab's merge requests", async () => {
  const { input, cleanup } = await makeInput();
  const { io } = collectIo();
  runtimeCredentials.set("RYPH_LOOPBACK_TOKEN", "loop-token-1");
  const only: HarnessTools = {
    servers: [],
    tokenEnv: "RYPH_MCP_TOKEN",
    loopback: TOOLS_WITH_LOOPBACK.loopback,
  };
  try {
    const repos = input.repos.map((r) => ({ ...r, provider: "github" as const }));
    const seen: Introspection = JSON.parse(
      (await piHarness({ kind: "pi" }, { command: introspectCommand() })
        .run({ ...input, repos, tools: only }, io)).summary,
    );
    const appendix = appendixOf(seen);
    assertStringIncludes(appendix, "as a patch — a pull request on GitHub — while");
    assertStringIncludes(appendix, "the platform opens the pull request shortly after");
    assert(!appendix.includes("merge request on GitLab"), "names GitLab");
  } finally {
    runtimeCredentials.delete("RYPH_LOOPBACK_TOKEN");
    await cleanup();
  }
});
