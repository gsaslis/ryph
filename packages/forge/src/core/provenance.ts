// What every body the forge writes for an agent opens with: who wrote it, from which run, for
// whom — and the marker a lost response is reconciled by. Put there by the forge from the grant,
// outside the agent's byte budget. The report's provenance block (docs/threat-model.md), for a
// smaller artifact.
//
// Why the signature leads the body instead of trailing it, which looks odd without this context:
// a footer AFTER the agent's text can be hidden by that text — an unclosed HTML comment,
// `<details>`, `<rp>` or `<script>`, an unclosed code fence, a GitLab `>>>` quote. Rewriting the
// agent's text to stop each of those kept failing review: every round found another construct.
// Nothing written after the signature can hide it, so the agent's text is posted verbatim, and a
// suggestion in it applies byte for byte.

import type { ForgeProvider, ToolProvenance } from "./types.ts";
import { isForgeLogin } from "./provider_rules.ts";

const MARKER_PREFIX = "ryph-action:";

/** The HTML comment a write carries — invisible on the forge, findable in its body. */
export function actionMarker(actionId: string): string {
  return `<!-- ${MARKER_PREFIX}${actionId} -->`;
}

/** Whether a body the forge lists carries this action's marker. */
export function carriesMarker(body: string, actionId: string): boolean {
  return body.includes(actionMarker(actionId));
}

/**
 * How many of `lines` are the footer `withSignature` puts ahead of an agent's text, with the blank
 * line after it: 0 when they do not start with one. What a refusal of a line counts past, so
 * the line it names is the agent's own count.
 */
export function footerLines(lines: string[]): number {
  if (!/^<sub>Written by .*<\/sub>$/.test(lines[0] ?? "")) return 0;
  if (!new RegExp(`^<!-- ${MARKER_PREFIX}\\S* -->$`).test(lines[1] ?? "")) return 0;
  return lines.length > 2 && lines[2] === "" ? 3 : 2;
}

/**
 * Markdown that cannot restyle the footer around it: the agent's name is an admin's text, and a
 * name like `**` or `](http://…)` should read as itself. An image's alt goes through it too.
 */
export function escapeInline(text: string): string {
  return text.replace(/[\\`*_[\]<>|~#]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, " ");
}

/** A chat name as the orchestrator sanitizes it; anything else is dropped rather than echoed —
 * above all an `@`, which would mention somebody on the forge. */
const CHAT_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]{0,39})$/u;

/**
 * The footer, then the agent's text exactly as written. The footer leads the body because no
 * other place is safe: after the agent's text, its own bytes could hold it — an unterminated
 * `<!--` comments it out up to the marker's `-->`, an unclosed `<details>` collapses it under an
 * agent-written `<summary>`, an unclosed `<rp>` hides it, an unclosed `<script>` is dropped with
 * it by GitLab's sanitizer, and an unclosed fence or GitLab `>>>` quote takes it out of the
 * top level, where none of the rest can be undone. Every attempt to model all of that missed
 * some construct. Ahead of the agent's text none of it applies: an HTML element or a markdown
 * block opened later cannot contain what came before it, and the blank line after the footer
 * ends its paragraph, so no later line can turn it into a heading or a table's header row. So
 * the agent's text is posted byte for byte — a suggestion's lines are what "Apply suggestion"
 * commits — and a comment it opens hides only its own words.
 *
 * `provider` is the forge the body lands on: the requester is named `@login` only when the login
 * is one by that forge's rule (`isForgeLogin`), and dropped rather than echoed otherwise.
 */
export function withSignature(
  body: string,
  provenance: ToolProvenance,
  actionId: string,
  provider: ForgeProvider,
): string {
  const parts = [`Written by **${escapeInline(provenance.agentName)}**, a Ryph agent`];
  if (provenance.runUrl !== null) parts.push(`[Run](${encodeURI(provenance.runUrl)})`);
  if (provenance.requestedVia !== null && CHAT_NAME.test(provenance.requestedVia)) {
    // A code span, not text: a chat name may be `www.evil.example`, which a forge autolinks
    // anywhere but in code. CHAT_NAME admits no backtick to close the span early.
    parts.push(`asked by \`${provenance.requestedVia}\` in chat`);
  } else if (provenance.requestedBy !== null && isForgeLogin(provider, provenance.requestedBy)) {
    parts.push(`asked by @${provenance.requestedBy}`);
  }
  const text = body.trim() === "" ? "" : `\n\n${body.trimEnd()}`;
  return `<sub>${parts.join(" · ")}</sub>\n${actionMarker(actionId)}${text}`;
}
