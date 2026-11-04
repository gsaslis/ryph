// What the environment builds this run's patches asked for came to — the read behind the agent's
// `environment_status` tool. An agent cannot run Docker, so a patch that changes `.ryph/` is
// built by the platform, and this is how the agent asks where that build stands, beside the
// message the platform posts when it settles.
//
// The answer is TEXT, composed by the control plane with the build's own output already fenced
// and marked as the build's; the runner hands it to the agent as a tool result and parses nothing
// in it. A pull like the inbox, answering like the patch reporter: the agent asked.

export interface EnvironmentStatus {
  /** Throws when the answer could not be had; the caller says so to the agent. */
  read(): Promise<string>;
}
