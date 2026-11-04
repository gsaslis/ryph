// The setup wizard's test double: a terminal that answers from a script, and a machine with
// docker and nothing else. Shared by the wizard's suites.

import type { AskOptions, Choice, Prompter } from "../src/prompt.ts";
import type { SetupContext } from "../src/setup.ts";

/** Answers in the order they are asked; "" means "take the offered default". */
export class Scripted implements Prompter {
  readonly said: string[] = [];
  /** Each select's question and the labels it offered, in the order asked. */
  readonly offered: { question: string; labels: string[] }[] = [];
  constructor(private readonly answers: string[]) {}

  private next(): string {
    if (this.answers.length === 0) throw new Error(`no scripted answer left: ${this.said.at(-1)}`);
    return this.answers.shift()!;
  }

  say(text = ""): void {
    this.said.push(text);
  }

  heading(text: string): void {
    this.said.push(text);
  }

  async ask(question: string, opts: AskOptions = {}): Promise<string> {
    this.said.push(question);
    // Trimmed like the real prompter, so a scripted "  " means the same "no answer" it does at a
    // terminal.
    const answer = this.next().trim() || opts.default || "";
    const complaint = answer === "" ? null : await opts.validate?.(answer) ?? null;
    // The real prompter re-asks; a test that supplies a rejected answer is a test with a bug.
    if (complaint !== null) throw new Error(`answer rejected: ${complaint}`);
    return answer;
  }

  secret(question: string): Promise<string> {
    this.said.push(question);
    return Promise.resolve(this.next());
  }

  select<T>(question: string, choices: Choice<T>[], defaultIndex = 0): Promise<T> {
    this.said.push(question);
    this.offered.push({ question, labels: choices.map((choice) => choice.label) });
    const answer = this.next();
    const index = answer === "" ? defaultIndex : Number(answer) - 1;
    return Promise.resolve(choices[index].value);
  }

  confirm(question: string, defaultYes: boolean): Promise<boolean> {
    this.said.push(question);
    const answer = this.next();
    return Promise.resolve(answer === "" ? defaultYes : answer === "y");
  }

  /** Everything the wizard printed, as one string — for asserting that a warning was given. */
  transcript(): string {
    return this.said.join("\n");
  }
}

export const context = (over: Partial<SetupContext> = {}): SetupContext => ({
  dbUrl: "pglite:/tmp/ryph/data",
  keyFromEnv: false,
  storedKeyPath: null,
  storableKeyPath: "/tmp/ryph/secrets.key",
  docker: { available: true, version: "Docker 27.3.1" },
  agentImages: [],
  browserImages: [],
  gateImages: [],
  apiPort: 7411,
  proxyPort: 7420,
  mcpPort: 7430,
  egressPort: 7460,
  egressKeyPresent: false,
  githubCli: false,
  current: new Map(),
  ...over,
});

/** Question 2 answered on the default context: docker's agent and browser images typed in, and
 * the internet question's default (allowlisted, with no run gate built). */
export const RUNNER = ["ryph-agent:dev", "ryph-browser:dev", ""];
