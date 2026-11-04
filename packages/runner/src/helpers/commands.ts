// Commands written out for the agent to run. A branch name can hold `$`, `(`, `;`, `|`, `&`,
// quotes and backticks (git refuses none of them), and a command naming one, pasted into a
// shell, runs whatever the name spells. A command names a ref only when the ref is plain;
// otherwise the text says the same thing in words, with no command to paste.

const PLAIN_REF = /^[A-Za-z0-9._/-]+$/;

/** Whether `ref` can be written into a command for the agent's shell as it is: letters, digits,
 * `.`, `_`, `/` and `-` only, and no leading dash. */
export function isPlainRef(ref: string): boolean {
  return PLAIN_REF.test(ref) && !ref.startsWith("-");
}

/** A name inside a code span, for a note or refusal the agent reads: a backtick in it would close
 * the span early and let the rest of the name read as ryph's own words. As the control plane's
 * `inCode` (orchestrator core/inbox.ts). */
export function inCode(name: string): string {
  return `\`${name.replaceAll("`", "'")}\``;
}
