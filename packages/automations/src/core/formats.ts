// Payload formats: how one webhook fire's body (and headers) is read into a SIGNAL — whether the
// thing it reports is firing, resolved, a lifecycle update, or something this format cannot
// tell; which thing it is (the correlation key); and what to call it (the title). The
// orchestrator decides what a signal means for a response;
// this module only reads it, once, at delivery, and never again downstream.
//
// Most presets are a declarative `SignalMapping` evaluated by one helper, the same one a
// `custom` format exposes to its owner. Two vendors do not fit a mapping — incident.io files
// its object under a key named by the event type, and Sentry sends two resource shapes to one
// URL — so they are small functions instead.
//
// Reading NEVER throws and never refuses: a body that is not JSON, a path that is not there, a
// value nobody listed — each is `unknown` with a null key and title, and the fire goes on. A
// format is a lens on the payload, not a gate; the verbatim payload still rides to the run.

import type { ResponseCorrelation } from "./types.ts";

/** What a fire reports about the thing it is about. `update` is a lifecycle event that is
 * neither opening nor closing (acknowledged, assigned, escalated); `unknown` is "this format
 * cannot tell" — a raw format, an unparsable body, a value nobody mapped. */
export type SignalStatus = "firing" | "resolved" | "update" | "unknown";

/** One fire, read. `key` names the thing (an alert group, an incident) so later fires about the
 * same thing can join the response it opened; `title` is what a person calls it. Both trimmed,
 * single-line, at most `SIGNAL_TEXT_MAX` code points, and null rather than empty. */
export interface FireSignal {
  status: SignalStatus;
  key: string | null;
  title: string | null;
}

/** The signal of a fire nothing can read — a schedule's, a raw webhook's, a body that is not
 * JSON. A fresh object per call, so no caller can mutate a shared one. */
export const unknownSignal = (): FireSignal => ({ status: "unknown", key: null, title: null });

export const SIGNAL_TEXT_MAX = 200;

/**
 * A declarative reading of a JSON body. Each list of paths is tried in order and the first that
 * lands on a usable value wins; the status value is then compared, case-insensitively, against
 * the three value lists, and anything in none of them is `unknown`.
 *
 * Path syntax: dot-separated segments (`event.data.id`), `[0]` for an array index, and
 * `["a.b"]` for a key that itself contains a dot (`["public_incident.incident_created_v2"].id`).
 */
export interface SignalMapping {
  /** Paths tried in order; the first that holds a non-empty string is the status value. */
  status: string[];
  /** Values meaning `firing`. */
  firing: string[];
  /** Values meaning `resolved`. */
  resolved: string[];
  /** Values meaning `update`; any value in no list is `unknown`. */
  update: string[];
  /** Paths tried in order; the first holding a non-empty string or a number is the key. */
  key: string[];
  /** Paths tried in order, as for `key`. */
  title: string[];
}

/** Every format a webhook trigger may read its fires with. */
export const WEBHOOK_FORMAT_KINDS = [
  "raw",
  "alertmanager",
  "grafana",
  "grafana-irm",
  "pagerduty",
  "opsgenie",
  "sentry",
  "incident-io",
  "datadog",
  "custom",
] as const;

export type WebhookFormatKind = (typeof WEBHOOK_FORMAT_KINDS)[number];

/** A webhook trigger's format: a preset by name, or the owner's own mapping. */
export type WebhookFormat =
  | { kind: Exclude<WebhookFormatKind, "custom"> }
  | { kind: "custom"; mapping: SignalMapping };

/** Where a preset's verification secret comes from: `minted` by us and pasted into the sender,
 * or `pasted` from the sender's settings into us — the vendor generates it and never lets
 * anyone choose (PagerDuty, Sentry, incident.io). */
export type SecretSource = "minted" | "pasted";

/** A preset's default verification, as the app applies it — the server never infers a
 * verification from a format; this is data for whoever composes the create request. */
export type PresetVerification =
  | { kind: "hmac-sha256"; header: string; prefix: string }
  | { kind: "secret-header"; header: string; prefix: string }
  | { kind: "standard-webhooks" };

/** One format as data: what it verifies with by default (null: the owner's choice), where its
 * secret comes from, and whether it reads correlation keys — the last decides whether a
 * response defaults to joining per key. */
export interface FormatPreset {
  kind: WebhookFormatKind;
  verification: PresetVerification | null;
  secret: SecretSource;
  yieldsKeys: boolean;
}

/** The contract's §4 table, as data. `raw` and `custom` leave verification to the owner; a
 * `custom` mapping yields keys exactly when it names key paths (`formatYieldsKeys`). */
export const FORMAT_PRESETS: readonly FormatPreset[] = [
  { kind: "raw", verification: null, secret: "minted", yieldsKeys: false },
  {
    kind: "alertmanager",
    verification: { kind: "secret-header", header: "authorization", prefix: "Bearer " },
    secret: "minted",
    yieldsKeys: true,
  },
  {
    kind: "grafana",
    verification: { kind: "hmac-sha256", header: "x-grafana-alerting-signature", prefix: "" },
    secret: "minted",
    yieldsKeys: true,
  },
  {
    kind: "grafana-irm",
    verification: { kind: "secret-header", header: "authorization", prefix: "" },
    secret: "minted",
    yieldsKeys: true,
  },
  {
    kind: "pagerduty",
    verification: { kind: "hmac-sha256", header: "x-pagerduty-signature", prefix: "v1=" },
    secret: "pasted",
    yieldsKeys: true,
  },
  {
    kind: "opsgenie",
    verification: { kind: "secret-header", header: "x-ryph-secret", prefix: "" },
    secret: "minted",
    yieldsKeys: true,
  },
  {
    kind: "sentry",
    verification: { kind: "hmac-sha256", header: "sentry-hook-signature", prefix: "" },
    secret: "pasted",
    yieldsKeys: true,
  },
  {
    kind: "incident-io",
    verification: { kind: "standard-webhooks" },
    secret: "pasted",
    yieldsKeys: true,
  },
  {
    kind: "datadog",
    verification: { kind: "secret-header", header: "x-ryph-secret", prefix: "" },
    secret: "minted",
    yieldsKeys: true,
  },
  { kind: "custom", verification: null, secret: "minted", yieldsKeys: false },
];

/** The preset row for a format kind. Total over `WebhookFormatKind`. */
export function presetOf(kind: WebhookFormatKind): FormatPreset {
  return FORMAT_PRESETS.find((p) => p.kind === kind)!;
}

/** Whether a format can read a correlation key at all: a keyed preset, or a custom mapping that
 * names at least one key path. */
export function formatYieldsKeys(format: WebhookFormat): boolean {
  return format.kind === "custom"
    ? format.mapping.key.length > 0
    : presetOf(format.kind).yieldsKeys;
}

/** The correlation a response gets when its owner names none: a schedule's fires have nothing
 * in common to join on, so each is its own; a webhook joins per key when its format reads keys,
 * and otherwise the automation's one open response — today's behaviour for a raw sender. */
export function defaultCorrelation(
  trigger: { kind: "schedule" } | { kind: "webhook"; format: WebhookFormat },
): ResponseCorrelation {
  if (trigger.kind === "schedule") return "fire";
  return formatYieldsKeys(trigger.format) ? "key" : "automation";
}

// ---------------------------------------------------------------------------------------------
// Paths

/** One step into a JSON value: a key into an object, or an index into an array. */
type Segment = { key: string } | { index: number };

/**
 * Parses a path into its segments, or null when it is malformed. Dot-separated keys, `[n]` for
 * an index, `["…"]` for a quoted key (a backslash escapes `"` and `\` inside it). A leading
 * bracket needs no dot before it, and a dot after a bracket is optional only in that it must
 * not be doubled: `a[0].b`, `["a.b"].c`, `a["b"]` all parse; `a..b`, `a.`, `[x]` do not.
 */
export function parsePath(path: string): Segment[] | null {
  const segments: Segment[] = [];
  let i = 0;
  // Whether the next thing must be a key (start, or right after a dot) — a bracket may also
  // come there, but a bare key may not follow a bracket without a dot.
  let expectKey = true;
  while (i < path.length) {
    const c = path[i];
    if (c === "[") {
      const close = readBracket(path, i);
      if (close === null) return null;
      segments.push(close.segment);
      i = close.end;
      expectKey = false;
      continue;
    }
    if (c === ".") {
      // A dot only separates: never leading, never doubled, never trailing.
      if (expectKey || i === path.length - 1) return null;
      i++;
      expectKey = true;
      continue;
    }
    if (!expectKey) return null;
    let end = i;
    while (end < path.length && path[end] !== "." && path[end] !== "[") end++;
    segments.push({ key: path.slice(i, end) });
    i = end;
    expectKey = false;
  }
  return segments.length === 0 ? null : segments;
}

/** Reads one `[…]` starting at `start`: an unsigned integer or a double-quoted key. */
function readBracket(path: string, start: number): { segment: Segment; end: number } | null {
  let i = start + 1;
  if (path[i] === '"') {
    let key = "";
    i++;
    while (i < path.length && path[i] !== '"') {
      if (path[i] === "\\" && i + 1 < path.length) i++;
      key += path[i];
      i++;
    }
    if (path[i] !== '"' || path[i + 1] !== "]") return null;
    return { segment: { key }, end: i + 2 };
  }
  const close = path.indexOf("]", i);
  if (close === -1) return null;
  const digits = path.slice(i, close);
  if (!/^\d{1,9}$/.test(digits)) return null;
  return { segment: { index: Number(digits) }, end: close + 1 };
}

/** The value at `path` in `root`, or undefined when the path is malformed or leads nowhere. An
 * index applies only to an array and a key only to a non-array object — no implicit
 * conversions, so `a.0` is the key "0", never the first element. */
export function valueAt(root: unknown, path: string): unknown {
  const segments = parsePath(path);
  if (segments === null) return undefined;
  let at: unknown = root;
  for (const segment of segments) {
    if ("index" in segment) {
      if (!Array.isArray(at)) return undefined;
      at = at[segment.index];
    } else {
      if (at === null || typeof at !== "object" || Array.isArray(at)) return undefined;
      if (!Object.hasOwn(at, segment.key)) return undefined;
      at = (at as Record<string, unknown>)[segment.key];
    }
  }
  return at;
}

// ---------------------------------------------------------------------------------------------
// Mapping

/** A key or title as the signal carries it: whitespace runs (newlines included) folded to one
 * space, trimmed, cut to `SIGNAL_TEXT_MAX` code points; null when nothing is left. */
function clean(value: unknown): string | null {
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" && Number.isFinite(value)) text = String(value);
  else return null;
  const folded = text.replace(/\s+/g, " ").trim();
  if (folded === "") return null;
  return Array.from(folded).slice(0, SIGNAL_TEXT_MAX).join("");
}

/** The first path in `paths` that lands on a usable key or title. */
function firstText(root: unknown, paths: readonly string[]): string | null {
  for (const path of paths) {
    const text = clean(valueAt(root, path));
    if (text !== null) return text;
  }
  return null;
}

/** The status a value maps to under `mapping`: compared trimmed and case-insensitively. */
function statusOf(
  value: string,
  mapping: Pick<SignalMapping, "firing" | "resolved" | "update">,
): SignalStatus {
  const v = value.trim().toLowerCase();
  const has = (list: readonly string[]) => list.some((x) => x.trim().toLowerCase() === v);
  if (has(mapping.firing)) return "firing";
  if (has(mapping.resolved)) return "resolved";
  if (has(mapping.update)) return "update";
  return "unknown";
}

/** The first non-empty string any status path holds, or null. */
function statusValue(root: unknown, paths: readonly string[]): string | null {
  for (const path of paths) {
    const value = valueAt(root, path);
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/** Reads a parsed body with a mapping — the one helper behind every declarative preset and
 * every custom format. */
export function applyMapping(root: unknown, mapping: SignalMapping): FireSignal {
  const value = statusValue(root, mapping.status);
  return {
    status: value === null ? "unknown" : statusOf(value, mapping),
    key: firstText(root, mapping.key),
    title: firstText(root, mapping.title),
  };
}

/** Alertmanager's title fallbacks: `alertname` is in `commonLabels` when every alert in the
 * group shares it, in `groupLabels` only when `group_by` names it. */
const ALERTMANAGER_TITLES = [
  "commonLabels.alertname",
  "groupLabels.alertname",
  "commonAnnotations.summary",
  "alerts[0].labels.alertname",
];

const ALERTMANAGER: SignalMapping = {
  status: ["status"],
  firing: ["firing"],
  resolved: ["resolved"],
  update: [],
  key: ["groupKey"],
  title: ALERTMANAGER_TITLES,
};

/** Grafana's contact point is an Alertmanager-v4 superset; its own `title` is the last resort,
 * since it carries a `[FIRING:n]` prefix that changes with the count. */
const GRAFANA: SignalMapping = { ...ALERTMANAGER, title: [...ALERTMANAGER_TITLES, "title"] };

/** Grafana IRM's outgoing webhook with "Forward whole payload" on. */
const GRAFANA_IRM: SignalMapping = {
  status: ["event.type"],
  firing: ["alert group created", "unresolve"],
  resolved: ["resolve"],
  update: [
    "acknowledge",
    "unacknowledge",
    "silence",
    "unsilence",
    "escalation",
    "personal notification",
  ],
  key: ["alert_group.id"],
  title: ["alert_group.title"],
};

/** PagerDuty v3. Its `update` list is open-ended — every other `incident.*` event type — which
 * a mapping cannot spell, so the preset function below widens it. */
const PAGERDUTY: SignalMapping = {
  status: ["event.event_type"],
  firing: ["incident.triggered", "incident.reopened"],
  resolved: ["incident.resolved"],
  update: [],
  key: ["event.data.id"],
  title: ["event.data.title"],
};

/** Opsgenie. As for PagerDuty, every action not listed is an update — the preset widens it. */
const OPSGENIE: SignalMapping = {
  status: ["action"],
  firing: ["Create"],
  resolved: ["Close", "Delete"],
  update: [],
  // `alertId`, not `alias`: an alias is reused by the next alert after a close.
  key: ["alert.alertId", "alert.alias"],
  title: ["alert.message"],
};

/** Datadog, reading the payload template the app hands the owner (`transition`, `cycle_key`,
 * `aggreg_key`, `title`): Datadog's body is whatever the owner writes, so this is OUR shape. */
const DATADOG: SignalMapping = {
  status: ["transition"],
  firing: ["Triggered", "Re-Triggered", "Warn"],
  resolved: ["Recovered"],
  update: ["Re-Warn", "Renotify", "No Data", "Re-No Data"],
  key: ["cycle_key", "aggreg_key"],
  title: ["title"],
};

const SENTRY_ISSUE: SignalMapping = {
  status: ["action"],
  firing: ["created", "unresolved"],
  resolved: ["resolved"],
  // "ignored" is what Sentry called "archived" before the rename; both arrive in the wild.
  update: ["assigned", "archived", "ignored"],
  key: ["data.issue.id"],
  title: ["data.issue.title"],
};

const SENTRY_METRIC_ALERT: SignalMapping = {
  status: ["action"],
  // A warning escalating to critical arrives as a second firing under the same key — a join.
  firing: ["critical", "warning"],
  resolved: ["resolved"],
  update: [],
  key: ["data.metric_alert.id"],
  title: ["data.metric_alert.alert_rule.name"],
};

/** An issue alert rule's action: fire-only, Sentry sends no resolve for it. The paths are from
 * the vendor research and marked unconfirmed there, so a miss reads as a null key and title. */
const SENTRY_EVENT_ALERT: SignalMapping = {
  status: ["action"],
  firing: ["triggered"],
  resolved: [],
  update: [],
  key: ["data.event.issue_id"],
  title: ["data.event.title"],
};

/** A mapping whose unlisted status values are updates rather than unknown — `when` narrows that
 * to the values it accepts (PagerDuty: only `incident.*`). */
function withOtherwiseUpdate(
  mapping: SignalMapping,
  when: (value: string) => boolean = () => true,
): (root: unknown) => FireSignal {
  return (root) => {
    const signal = applyMapping(root, mapping);
    if (signal.status !== "unknown") return signal;
    const value = statusValue(root, mapping.status);
    return value !== null && when(value) ? { ...signal, status: "update" } : signal;
  };
}

/** A header lookup that works over a stored hook's record (the mailroom keeps names lowercased,
 * as `Headers` iteration hands them over, but a caller's record may not) and over a `Headers`. */
export type HeaderSource = Record<string, string> | { get(name: string): string | null };

function headerOf(headers: HeaderSource, name: string): string | null {
  const lower = name.toLowerCase();
  if (typeof headers.get === "function") {
    return (headers as { get(name: string): string | null }).get(lower);
  }
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/**
 * Sentry sends issues, metric alerts and issue alert rule actions to one URL and says which in
 * `Sentry-Hook-Resource`. The header decides; when it is absent (a hook replayed by hand, a
 * proxy that dropped it) the shape decides — the `data` object names its resource.
 */
function readSentry(root: unknown, headers: HeaderSource): FireSignal {
  const resource = headerOf(headers, "sentry-hook-resource")?.trim().toLowerCase() ??
    (valueAt(root, "data.metric_alert") !== undefined
      ? "metric_alert"
      : valueAt(root, "data.issue") !== undefined
      ? "issue"
      : valueAt(root, "data.event") !== undefined
      ? "event_alert"
      : null);
  switch (resource) {
    case "issue":
      return applyMapping(root, SENTRY_ISSUE);
    case "metric_alert":
      return applyMapping(root, SENTRY_METRIC_ALERT);
    case "event_alert":
      return applyMapping(root, SENTRY_EVENT_ALERT);
    case null:
      return unknownSignal();
    default:
      // `installation`, `comment`, `error`… — not alert lifecycle: an update, which joins an
      // open response and never starts a run.
      return { status: "update", key: null, title: null };
  }
}

/** incident.io's incident status categories. The slim variant spells two of them differently
 * (`active`, `post-incident`); both spellings are read. */
const INCIDENT_IO_CATEGORIES: Pick<SignalMapping, "firing" | "resolved" | "update"> = {
  firing: ["triage", "live", "active"],
  resolved: ["learning", "closed", "declined", "merged", "canceled", "post-incident"],
  update: ["paused"],
};

/**
 * incident.io files the event's object under a top-level key named by `event_type` — a key
 * with a dot in it — so the paths depend on the event, and a mapping cannot spell them.
 *
 * - Alerts (`*_alert.alert_created_v1` / `…_resolved_v1`): `status` is already `firing` /
 *   `resolved`; the event type says so too, and stands in when `status` is missing.
 * - Incidents: a status update carries `new_status` beside a nested `incident`; created and
 *   updated carry the incident itself with its `incident_status`. Private incidents carry only
 *   `id`, which still makes a key.
 * - Anything else (follow-ups, schedules, escalations) is not a lifecycle this reads.
 */
function readIncidentIo(root: unknown): FireSignal {
  const eventType = valueAt(root, "event_type");
  if (typeof eventType !== "string" || eventType === "") return unknownSignal();
  const object = valueAt(root, `[${JSON.stringify(eventType)}]`);
  if (object === null || typeof object !== "object") return unknownSignal();

  if (/_alert\.alert_(created|resolved)_v\d+$/.test(eventType)) {
    const status = statusValue(object, ["status"]);
    return {
      status: status !== null
        ? statusOf(status, { firing: ["firing"], resolved: ["resolved"], update: [] })
        : eventType.includes("alert_resolved")
        ? "resolved"
        : "firing",
      key: firstText(object, ["id"]),
      title: firstText(object, ["title"]),
    };
  }

  if (/_incident\.incident_(created|updated|status_updated)_v\d+$/.test(eventType)) {
    const category = statusValue(object, ["new_status.category", "incident_status.category"]);
    return {
      status: category === null ? "unknown" : statusOf(category, INCIDENT_IO_CATEGORIES),
      key: firstText(object, ["incident.id", "id"]),
      title: firstText(object, ["incident.name", "name"]),
    };
  }

  return unknownSignal();
}

/** Every preset but `raw` and `custom`, as a reader of a parsed body. */
const PRESET_READERS: Record<
  Exclude<WebhookFormatKind, "raw" | "custom">,
  (root: unknown, headers: HeaderSource) => FireSignal
> = {
  alertmanager: (root) => applyMapping(root, ALERTMANAGER),
  grafana: (root) => applyMapping(root, GRAFANA),
  "grafana-irm": (root) => applyMapping(root, GRAFANA_IRM),
  // Every event type not listed is an update, `pagey.ping` (the subscription test) included.
  pagerduty: withOtherwiseUpdate(PAGERDUTY),
  opsgenie: withOtherwiseUpdate(OPSGENIE),
  sentry: readSentry,
  "incident-io": readIncidentIo,
  datadog: (root) => applyMapping(root, DATADOG),
};

/**
 * Reads one fire's body (and headers) with a format. Never throws: a body that is not JSON, or
 * any surprise inside a reader, is the unknown signal — a format must never be the reason a
 * fire is lost.
 */
export function readSignal(format: WebhookFormat, body: string, headers: HeaderSource): FireSignal {
  if (format.kind === "raw") return unknownSignal();
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return unknownSignal();
  }
  try {
    return format.kind === "custom"
      ? applyMapping(root, format.mapping)
      : PRESET_READERS[format.kind](root, headers);
  } catch {
    return unknownSignal();
  }
}
