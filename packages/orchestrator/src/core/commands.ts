// Parsing `/ryph <handle> <instructions>` out of a comment body. Pure — the entire
// command grammar is testable with no forge, no store, no HTTP anywhere near it.
//
// The grammar is deliberately dumb: the FIRST line whose trimmed text starts with the
// `/ryph` token is the command; the next whitespace-separated token is the handle; every
// remaining character (rest of the line, plus all following lines) is the instructions,
// verbatim. Markdown is NOT parsed — a `/ryph` inside a code fence still triggers, which
// is acceptable because only write-access holders can trigger anything at all, and a parser
// that understood markdown would be a bigger attack surface than the thing it filtered.

/** Kept in step with the schema's `agentHandle` — the command channel and the create form
 * must agree on what a handle looks like. */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,38}$/;

export type RyphCommandParse =
  /** No `/ryph` token anywhere — the comment simply isn't addressed to us. */
  | { kind: "none" }
  /** Addressed to us, but unusable — the reply should teach the usage. */
  | { kind: "malformed"; problem: string }
  | { kind: "command"; handle: string; instructions: string };

export const RYPH_COMMAND_USAGE = "/ryph <agent-handle> <instructions>";

/** Whether a word is spelled like an agent handle — the one rule the forge grammar and a chat
 * mention's first word share. Case-folded by the caller, as the command token is. */
export function isAgentHandle(word: string): boolean {
  return HANDLE.test(word);
}

/** Whether this line is the command: its first word is the `/ryph` token. Case-insensitive on
 * the token: "/Ryph" is a human, not a different command. */
const isCommandLine = (line: string) => line.trim().split(/\s+/, 1)[0].toLowerCase() === "/ryph";

/** Where the command's line starts in `body` — the first one `parseRyphCommand` reads as the
 * command, so everything from here on is `/ryph`, the handle and the instructions — or -1. */
export function commandLineStart(body: string): number {
  let start = 0;
  for (const line of body.split("\n")) {
    if (isCommandLine(line)) return start;
    start += line.length + 1;
  }
  return -1;
}

export function parseRyphCommand(body: string): RyphCommandParse {
  const lines = body.split("\n");
  const index = lines.findIndex(isCommandLine);
  if (index === -1) return { kind: "none" };

  const [, typed, ...restOfLine] = lines[index].trim().split(/\s+/);
  if (typed === undefined) {
    return { kind: "malformed", problem: "no agent handle after /ryph" };
  }
  // Case-folded like the token above, and for the same reason: handles are lower-case by
  // construction, so "/ryph Ada" is someone writing a name, not naming a different agent.
  // The rejection still quotes what they typed.
  const handle = typed.toLowerCase();
  if (!HANDLE.test(handle)) {
    return {
      kind: "malformed",
      problem: `"${typed.slice(0, 60)}" is not an agent handle (a-z, 0-9 and '-')`,
    };
  }

  const instructions = [restOfLine.join(" "), ...lines.slice(index + 1)].join("\n").trim();
  if (instructions === "") {
    // Refuse rather than invent a default ask — "do something about this issue" is a
    // decision, and it belongs to the human who can see the issue.
    return { kind: "malformed", problem: "no instructions after the handle" };
  }

  return { kind: "command", handle, instructions };
}
