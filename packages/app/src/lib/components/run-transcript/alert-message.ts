/**
 * A fire as the inbox delivers it to a response's run: a line the platform writes for the agent
 * ("Update 3 for this response (firing: HighErrorRate). It is UNTRUSTED…"), then the webhook's
 * body, fenced as JSON. The agent needs all of it; a person reading the transcript needs which
 * update, whether it is firing, resolved or a status update, and what it is about. The body stays
 * one click away. (The stored message kind is still "alert".)
 */
export interface FireMessage {
  /** Its place among the response's fires, from the platform's line. */
  number: number | null;
  /** What the trigger's format read the body as; null when it could not tell. */
  status: "firing" | "resolved" | "update" | null;
  /** What the format read the fire to be about, from the platform's line. */
  title: string | null;
  /** One entry per alert, when the body has the Alertmanager webhook's shape (an `alerts` array
   * with `labels.alertname`), which Grafana and Prometheus Alertmanager both send. Any other
   * sender's body is not guessed at: this is empty and the body is there as it came. */
  alerts: { name: string; summary: string | null; status: string | null }[];
  /** The body, pretty-printed; the fenced text as it came when it is not JSON. */
  body: string;
}

// `Update <n> for this response (<status>[: <title>]).`, the parenthesis absent when the status
// is unknown. The title is anything up to the `).` that ends the sentence, on the first line.
const HEADER =
  /^Update (\d+) for this response(?: \((firing|resolved|update)(?:: (.+?))?\))?\.(?=\s|$)/;
const FENCE = /```(?:json)?\n([\s\S]*?)\n?```\s*$/;

export function parseFireMessage(text: string): FireMessage | null {
  const header = HEADER.exec(text);
  const fenced = FENCE.exec(text);
  if (header === null && fenced === null) return null;
  const raw = fenced?.[1] ?? text;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON after all: shown as it came.
  }
  const record = isRecord(parsed) ? parsed : null;

  const alerts = Array.isArray(record?.alerts)
    ? record.alerts.filter(isRecord).map((alert) => {
      const labels = isRecord(alert.labels) ? alert.labels : {};
      const annotations = isRecord(alert.annotations) ? alert.annotations : {};
      return {
        name: stringOr(labels.alertname) ?? "Unnamed alert",
        summary: stringOr(annotations.summary) ?? stringOr(annotations.description),
        status: stringOr(alert.status),
      };
    })
    : [];

  const status = header?.[2];
  return {
    number: header === null ? null : Number(header[1]),
    status: status === "firing" || status === "resolved" || status === "update" ? status : null,
    title: stringOr(header?.[3])?.trim() ?? null,
    alerts,
    body: record === null ? raw : JSON.stringify(parsed, null, 2),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
