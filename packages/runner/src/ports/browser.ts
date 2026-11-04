// The browser sidecar, as the core sees it: one answer, once — is there a browser for the agent,
// and if so where are its tools. Everything else about it (the wait for its port, configuring it,
// relaying what it shows to the run page) is the adapter's, started by the composition root at
// boot so it overlaps the clone and setup instead of adding to them.
//
// Invariants:
// - `ready` never rejects. A browser that never answered, or refused to be configured, settles
//   `failed` with the reason, and the run goes on without it — the agent is told it failed
// - `ready` settles within the adapter's bounded wait (a minute) of boot, or as soon as the run
//   is cancelled; the core awaits it just before the harness starts, so the most a slow browser
//   can cost a run is what is left of that minute once setup is done

/** The browser's tool server, as the harness dials it: an MCP endpoint on loopback and the NAME
 * of the runner env var holding its bearer — the token itself never rides a type. */
export interface BrowserTools {
  url: string;
  tokenEnv: string;
}

export type BrowserState =
  | { kind: "ready"; tools: BrowserTools }
  | { kind: "failed"; reason: string };

export interface BrowserSession {
  /** Settles once: ready, or failed with the reason. Never rejects. */
  readonly ready: Promise<BrowserState>;
}
