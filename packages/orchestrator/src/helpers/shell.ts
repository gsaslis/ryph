// The platform's shell scripts live as `.sh` files beside the modules that run them, imported as
// text (`with { type: "text" }`, declared in types/text.d.ts), so they get an editor's highlighting
// and shellcheck (`bun run shellcheck`). What TypeScript still writes is the header in front of
// them: the platform's constants, one assignment each, so a value both sides need has one source.

/**
 * A `.sh` file as it is shipped: without its comment lines and blank lines. The comments are for
 * the reader of the file; a script travels as one argv string (`bash -c`, a pod's `command`, a
 * Cloud Build arg), where Linux caps a single argument at 128 KiB and every check container of a
 * suite carries its own copy in the Job. A comment is a line whose first non-blank character is
 * `#` and not a `#!`; a comment after code on the same line stays, as the shell reads it. A
 * heredoc's body is data, not script, and is kept verbatim down to its delimiter (one heredoc per
 * line, `<<WORD`, `<<-WORD` or a quoted word). A quoted string spanning lines is not followed, so no
 * `.sh` file may hold one with a blank or `#` line in it. Never a constants header, whose quoted
 * values may hold lines of any kind.
 */
export function shellBody(text: string): string {
  const out: string[] = [];
  let heredoc: { word: string; tabs: boolean } | undefined;
  for (const line of text.split("\n")) {
    if (heredoc) {
      out.push(line);
      if ((heredoc.tabs ? line.replace(/^\t+/, "") : line) === heredoc.word) heredoc = undefined;
      continue;
    }
    const trimmed = line.trimStart();
    if (trimmed === "" || (trimmed.startsWith("#") && !trimmed.startsWith("#!"))) continue;
    out.push(line);
    // `<<` and not a here-string's `<<<`.
    const opens = line.match(/(?<!<)<<(?!<)(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
    if (opens) heredoc = { word: opens[3], tabs: opens[1] === "-" };
  }
  if (heredoc) throw new Error(`shellBody: heredoc ${heredoc.word} is never closed`);
  return out.join("\n");
}

/** A value as one single-quoted shell word. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A script's constants header: `readonly RYPH_NAME='value'` per entry, for bash and POSIX sh
 * alike. Only ever platform constants: a value of a run, a suite or a build reaches a script as an
 * env var or an argument, never in its text.
 *
 * Every name is `RYPH_`'s, and unset before it is set. A script's commands inherit its
 * environment: a constant that took a name the image already exports (a `WORK`, say) would either
 * hand the platform's value to every command under that name or, unset first, take the image's
 * away from them. Under `RYPH_` there is nothing of an image's to collide with, and unset first
 * none of them is exported, whatever the environment held.
 */
export function shellConstants(values: Record<string, string | number>): string {
  const names = Object.keys(values);
  for (const name of names) {
    if (!/^RYPH_[A-Z0-9_]+$/.test(name)) throw new Error(`shell constant name ${name}`);
  }
  return [
    `unset ${names.join(" ")}`,
    ...names.map((name) => `readonly ${name}=${shellQuote(String(values[name]))}`),
  ].join("\n");
}
