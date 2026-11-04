// Optional, best-effort telemetry over pi's existing RPC connection. Never gate a prompt or
// settle on a stats response: older pi versions may not answer it at all.
type JsonObject = Record<string, unknown>;

export function piContext(
  send: (command: JsonObject) => Promise<unknown>,
  emit: (event: JsonObject) => void,
) {
  let serial = 0;
  let pending: string | null = null;
  let contextWindow: number | null = null;
  let compacting = false;
  let lastStatus = "unavailable";
  const snapshot = (
    status: string,
    tokens: number | null = null,
    percent: number | null = null,
  ) => {
    lastStatus = status;
    emit({ type: "context_usage", status, tokens, percent, contextWindow });
  };
  const request = () => {
    const id = `ryph-context-${++serial}`;
    pending = id;
    send({ type: "get_session_stats", id }).catch(() => {
      if (pending !== id) return;
      pending = null;
      // Stdin may close while the run settles. Keep its last useful measurement rather than
      // replacing it with a transport error; compaction has already invalidated old usage.
      if (lastStatus !== "ready") snapshot("unavailable");
    });
  };
  return (event: JsonObject): boolean => {
    if (event.type === "response" && event.command === "get_session_stats") {
      // Consume failures too: missing telemetry must never fail the run. Only the newest
      // request can update the display; compaction invalidates pre-compaction requests.
      if (event.id !== pending || pending === null) return true;
      pending = null;
      const data = event.data as JsonObject | undefined;
      const usage = data?.contextUsage as JsonObject | undefined;
      const window = usage?.contextWindow;
      if (
        event.success !== true || typeof window !== "number" || !Number.isFinite(window) ||
        window <= 0
      ) {
        contextWindow = null;
        snapshot("unavailable");
        return true;
      }
      contextWindow = window;
      const { tokens, percent } = usage!;
      if (tokens === null && percent === null) {
        snapshot("recalculating");
      } else if (
        typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 &&
        typeof percent === "number" && Number.isFinite(percent) && percent >= 0
      ) {
        snapshot("ready", tokens, percent);
      } else {
        snapshot("unavailable");
      }
      return true;
    }
    if (event.type === "compaction_start") {
      compacting = true;
      pending = null;
      snapshot("compacting");
    } else if (event.type === "compaction_end") {
      compacting = false;
      pending = null;
      snapshot(event.aborted || event.errorMessage ? "unavailable" : "recalculating");
      request();
    } else if (!compacting && (event.type === "agent_start" || event.type === "turn_end")) {
      request();
    }
    return false;
  };
}
