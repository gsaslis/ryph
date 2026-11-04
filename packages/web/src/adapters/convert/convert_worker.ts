// The worker program: one message in ({ html, url, format }), one message out. It holds no state, opens
// nothing, and is terminated by its caller after every page — see worker_converter.ts for why.
//
// Anything thrown here comes back as an answer rather than as a dead worker, so the caller can
// tell "this page is unreadable" from "this page ran out of time".

import { parentPort } from "node:worker_threads";
import { htmlToMarkdown } from "../../core/markdown.ts";
import { htmlToText } from "../../core/text.ts";
import type { ConvertFormat } from "./worker_converter.ts";

if (parentPort === null) throw new Error("convert_worker.ts runs only as a worker");
const port = parentPort;

port.on("message", (message: unknown) => {
  const { html, url, format } = message as { html: string; url: string; format: ConvertFormat };
  try {
    let page;
    if (format === "text") {
      const { title, text } = htmlToText(html);
      page = { title, markdown: text, via: "text" };
    } else {
      page = htmlToMarkdown(html, url);
    }
    port.postMessage({ ok: true, page });
  } catch (err) {
    port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
