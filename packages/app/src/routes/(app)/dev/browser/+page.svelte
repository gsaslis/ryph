<script lang="ts">
import { page } from "$app/state";
import { type LiveSource, liveStreamSource } from "$lib/api/browser-live";
import { mergeToolCalls, type ToolCall } from "$lib/api/tools";
import type { HistoryEvent, RunnerResult } from "$lib/api/types";
import { setAttachmentUrlContext } from "$lib/components/attachment-images/attachment-url-context";
import BrowserPane from "$lib/components/browser-pane/browser-pane.svelte";
import RunResult from "$lib/components/run-result/run-result.svelte";
import type { TranscriptAction } from "$lib/components/browser-pane/live-view";
import { createMockBrowser, type MockBrowser } from "$lib/components/browser-pane/mock-source";
import ToolCallView from "$lib/components/tool-call/tool-call.svelte";
import { Button } from "$lib/components/ui/button";
import { describeBrowserCall } from "$lib/utils/browser-tools";
import { SvelteSet } from "svelte/reactivity";

// The pane against a pretend browser (mock-source.ts), and the transcript's browser rows from made-up
// history events, so both can be looked at without a run. Dev only: the load 404s anywhere else.
//
// `?live=<stream url>` points the pane at a real live stream instead: the one the local harness
// (packages/browser/scripts/e2e_live.ts --watch) serves from its own historian.

const live = $derived.by((): string | null => {
  const raw = page.url.searchParams.get("live");
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
});
let mock = $state.raw<MockBrowser>(createMockBrowser());
const source: LiveSource = $derived(live === null ? mock.source : liveStreamSource(() => live));
let runEnded = $state(false);

function restart() {
  mock.endRun();
  runEnded = false;
  mock = createMockBrowser();
}

function end() {
  runEnded = true;
  mock.endRun();
}

// Small screenshots, drawn here. The rows below name them as run attachments with made-up ids,
// and this page hands the thumbnails those ids' pictures, since there is no run to read them from.
function screenshot(line: string, colour: string, width = 480): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = 300;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fafaf9";
  ctx.fillRect(0, 0, width, 300);
  ctx.fillStyle = "#1e293b";
  ctx.fillRect(0, 0, width, 28);
  ctx.fillStyle = colour;
  ctx.font = "600 22px system-ui, sans-serif";
  ctx.fillText(line, 40, 170);
  return canvas.toDataURL("image/jpeg", 0.7);
}

const DEV_SHOT = "dev-screenshot";
const DEV_FORM = "dev-form";
const shots = new Map([
  [DEV_SHOT, screenshot("Hello, Ada Lovelace!", "#15803d")],
  [DEV_FORM, screenshot("Name is required", "#b91c1c", 640)],
]);
setAttachmentUrlContext((_runId, id) => shots.get(id) ?? "");

// A finished run's result with images the agent put in its summary: one on a line of its own, one
// inside a list item, a ref the run never stored (its alt text), and a remote image (left as
// written).
const result: RunnerResult = {
  status: "success",
  branches: [{
    connectedRepoId: "cr-greeter",
    path: "greeter",
    name: "ryph/fix-greeting",
    headSha: "4f1c2d0",
    commits: [{ sha: "4f1c2d0", subject: "fix: greet by name" }],
  }],
  summary: [
    "The greeting now uses the name from the form.",
    "",
    "![The greeting after the fix](img-3f9a1c0b2d4e)",
    "",
    "- An empty name still shows the error: ![the empty form](img-0b2d4e3f9a1c)",
    "- The old screenshot is gone: ![before the fix](img-000000000000)",
    "",
    "A remote image stays as text: ![logo](https://example.com/logo.png)",
  ].join("\n"),
  images: [
    {
      ref: "img-3f9a1c0b2d4e",
      attachmentId: DEV_SHOT,
      mime: "image/jpeg",
      alt: "The greeting after the fix",
    },
    { ref: "img-0b2d4e3f9a1c", attachmentId: DEV_FORM, mime: "image/jpeg", alt: "the empty form" },
  ],
};
let resultOpen = $state(false);

let seq = 0;
const event = (kind: string, payload: unknown): HistoryEvent => ({
  runId: "dev",
  lane: "",
  seq: seq++,
  at: new Date(Date.now() - (40 - seq) * 1000).toISOString(),
  voice: "transcript",
  kind,
  level: null,
  text: null,
  payload,
});
const call = (id: string, tool: string, args: unknown, result?: unknown, truncated = false) => [
  event("tool_use", { toolCallId: id, toolName: `browser__${tool}`, args }),
  ...(result === undefined && !truncated ? [] : [
    event(
      "tool_result",
      truncated ? { truncated: true, bytes: 184_220, toolCallId: id } : { toolCallId: id, result },
    ),
  ]),
];
const text = (t: string) => ({ content: [{ type: "text", text: t }] });

const calls: ToolCall[] = $derived.by(() => {
  seq = 0;
  const events = [
    ...call(
      "a",
      "navigate",
      { url: "http://localhost:5173/" },
      text("Opened http://localhost:5173/ (Greeter)"),
    ),
    ...call("b", "click", { ref: "e12", element: "Name" }, text("Clicked")),
    ...call("c", "type", { ref: "e12", element: "Name", text: "Ada Lovelace" }, text("Typed")),
    ...call("d", "click", { ref: "e14", element: "Greet" }, text("Clicked. Console: 1 new error")),
    // As the runner records a screenshot: the bytes are a run attachment, `data` only their size.
    ...call("e", "screenshot", {}, {
      content: [{
        type: "image",
        mimeType: "image/jpeg",
        data: "[25412 base64 chars omitted]",
        attachment: { id: DEV_SHOT, mime: "image/jpeg" },
      }],
    }),
    // One too big to keep, which the runner records with no attachment.
    ...call("f", "screenshot", { fullPage: true }, {
      content: [{ type: "image", mimeType: "image/png", data: "[7340032 base64 chars omitted]" }],
    }),
    ...call("f2", "snapshot", {}, undefined, true),
    ...call("g", "evaluate", { function: "() => document.title" }, text('"Greeter"')),
    ...call("h", "wait_for", { text: "Hello" }),
  ];
  return [...mergeToolCalls(events).calls.values()];
});

const transcriptActions: TranscriptAction[] = $derived(
  calls.flatMap((c) =>
    c.view.kind === "browser"
      ? [{
        seq: c.seq,
        at: Date.parse(c.at),
        tool: c.view.tool,
        ...describeBrowserCall(c.view.tool, c.view.args),
        done: c.done,
        isError: c.isError,
      }]
      : []
  ),
);

const open = new SvelteSet<number>();
let picked = $state<number | null>(null);
</script>

<svelte:head>
  <title>Browser preview · Ryph</title>
</svelte:head>

<div class="flex flex-col gap-8">
  <div class="flex flex-col gap-2">
    <h1 class="font-heading text-2xl font-bold tracking-[-0.02em]">Browser preview</h1>
    <p class="text-muted-foreground text-sm">
      The run browser's pane against a pretend browser, the transcript's browser rows from
      made-up calls, and a run result with images. Dev only. On a real run page, add <code>?browser=mock</code> to see the pane
      in place.
    </p>
    {#if live !== null}
      <p class="text-muted-foreground text-sm">
        The pane is reading a real stream from <code>{live}</code>.
      </p>
    {:else}
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onclick={() => mock.dropUplink()}>Drop the relay</Button>
        <Button variant="outline" size="sm"
          onclick={() => mock.restoreUplink()}>Restore the relay</Button>
        <Button variant="outline" size="sm" onclick={end}>End the run</Button>
        <Button variant="outline" size="sm" onclick={restart}>Start over</Button>
      </div>
    {/if}
  </div>

  <section class="flex max-w-3xl flex-col gap-3">
    <h2 class="text-sm font-medium">Run result with images</h2>
    <RunResult
      runId="dev"
      {result}
      egressNote={null}
      limit={null}
      expanded={resultOpen}
      ontoggle={(open) => (resultOpen = open)}
    />
  </section>

  <div class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_28rem]">
    <section class="flex min-w-0 flex-col gap-3">
      <h2 class="text-sm font-medium">Transcript rows</h2>
      {#if picked !== null}
        <p class="text-muted-foreground text-xs">Picked seq {picked} in the pane.</p>
      {/if}
      <div class="flex flex-col gap-3">
        {#each calls as c (c.seq)}
          <ToolCallView
            call={c}
            open={open.has(c.seq)}
            ontoggle={(o) => (o ? open.add(c.seq) : open.delete(c.seq))}
          />
        {/each}
      </div>
    </section>

    <div class="bg-background h-[46rem] overflow-hidden rounded-xl border">
      {#key source}
        <BrowserPane
          {source}
          {runEnded}
          calls={live === null ? transcriptActions : []}
          onselect={(s) => (picked = s)}
        />
      {/key}
    </div>
  </div>
</div>
