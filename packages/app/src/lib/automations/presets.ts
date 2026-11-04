// The senders a webhook automation knows by name: how each is verified and read, and the steps
// that connect it, as data. The create flow fills the trigger from a preset; the connect step,
// the automation's page and its edit read the same entries back, so what a person is told to do
// in PagerDuty is written once.

import type {
  Automation,
  Correlation,
  SignalMapping,
  WebhookFormat,
  WebhookPresetFormat,
} from "$lib/api/types";

export type PresetId =
  | "grafana"
  | "alertmanager"
  | "grafana-irm"
  | "pagerduty"
  | "sentry"
  | "incident-io"
  | "datadog"
  | "opsgenie"
  | "other";

/** How a preset's requests are trusted, as the service stores it. */
export type PresetVerification =
  | { kind: "hmac-sha256"; header: string; prefix: string }
  | { kind: "secret-header"; header: string; prefix: string }
  | { kind: "standard-webhooks" };

export interface WebhookPreset {
  id: PresetId;
  /** The sender's name, as the person knows it. */
  name: string;
  /** One line under the name in the picker. */
  blurb: string;
  /** What a new automation is called when the name is still empty. */
  defaultName: string;
  /** The format a preset reads; "other" picks raw or custom itself. */
  format: WebhookPresetFormat;
  verification: PresetVerification;
  /** Whether the sender makes the secret (PagerDuty, Sentry, incident.io) and it is pasted here. */
  secretSource: "minted" | "pasted";
  /** What one key names, for "one conversation per …": an alert group, an incident, an issue. */
  keyNoun: string;
  /** What one request from the sender is, for "when Grafana sends an alert". */
  eventNoun: string;
  /** A short worked example of one conversation per key, in the sender's own words. */
  keyExample: string;
  /** A line shown once the preset is picked, when there is something to know first. */
  note?: string;
}

const MINTED_HEADER = "x-ryph-secret";

export const PRESETS: readonly WebhookPreset[] = [
  {
    id: "grafana",
    name: "Grafana",
    blurb: "Contact point",
    defaultName: "Grafana alerts",
    format: "grafana",
    verification: { kind: "hmac-sha256", header: "x-grafana-alerting-signature", prefix: "" },
    secretSource: "minted",
    keyNoun: "alert group",
    eventNoun: "alert",
    keyExample:
      "HighCPU fires: a conversation opens. HighCPU resolves: it joins that one. DiskFull fires meanwhile: a second conversation.",
    note:
      "Older Grafana versions can't sign requests. If yours can't, choose a header in Advanced.",
  },
  {
    id: "alertmanager",
    name: "Alertmanager",
    blurb: "Prometheus receiver",
    defaultName: "Alertmanager alerts",
    format: "alertmanager",
    verification: { kind: "secret-header", header: "authorization", prefix: "Bearer " },
    secretSource: "minted",
    keyNoun: "alert group",
    eventNoun: "alert",
    keyExample:
      "HighCPU fires: a conversation opens. HighCPU resolves: it joins that one. DiskFull fires meanwhile: a second conversation.",
  },
  {
    id: "grafana-irm",
    name: "Grafana IRM",
    blurb: "On-call webhook",
    defaultName: "Grafana IRM alert groups",
    format: "grafana-irm",
    verification: { kind: "secret-header", header: "authorization", prefix: "" },
    secretSource: "minted",
    keyNoun: "alert group",
    eventNoun: "alert",
    keyExample:
      "An alert group fires: a conversation opens. It's acknowledged or resolved: that joins it. Another group fires meanwhile: a second conversation.",
  },
  {
    id: "pagerduty",
    name: "PagerDuty",
    blurb: "Incident webhook",
    defaultName: "PagerDuty incidents",
    format: "pagerduty",
    verification: { kind: "hmac-sha256", header: "x-pagerduty-signature", prefix: "v1=" },
    secretSource: "pasted",
    keyNoun: "incident",
    eventNoun: "incident event",
    keyExample:
      "An incident triggers: a conversation opens. It's acknowledged or resolved: that joins it. A second incident meanwhile: a second conversation.",
  },
  {
    id: "sentry",
    name: "Sentry",
    blurb: "Issues and alerts",
    defaultName: "Sentry issues",
    format: "sentry",
    verification: { kind: "hmac-sha256", header: "sentry-hook-signature", prefix: "" },
    secretSource: "pasted",
    keyNoun: "issue",
    eventNoun: "issue event",
    keyExample:
      "A new issue: a conversation opens. It's resolved: that joins it. Another issue meanwhile: a second conversation.",
  },
  {
    id: "incident-io",
    name: "incident.io",
    blurb: "Incident webhook",
    defaultName: "incident.io incidents",
    format: "incident-io",
    verification: { kind: "standard-webhooks" },
    secretSource: "pasted",
    keyNoun: "incident",
    eventNoun: "incident event",
    keyExample:
      "An incident is declared: a conversation opens. Its updates join it. A second incident meanwhile: a second conversation.",
  },
  {
    id: "datadog",
    name: "Datadog",
    blurb: "Monitor alerts",
    defaultName: "Datadog monitors",
    format: "datadog",
    verification: { kind: "secret-header", header: MINTED_HEADER, prefix: "" },
    secretSource: "minted",
    keyNoun: "alert",
    eventNoun: "alert",
    keyExample:
      "A monitor alerts: a conversation opens. It recovers: that joins it. Another monitor alerts meanwhile: a second conversation.",
  },
  {
    id: "opsgenie",
    name: "Opsgenie",
    blurb: "Alert webhook",
    defaultName: "Opsgenie alerts",
    format: "opsgenie",
    verification: { kind: "secret-header", header: MINTED_HEADER, prefix: "" },
    secretSource: "minted",
    keyNoun: "alert",
    eventNoun: "alert",
    keyExample:
      "An alert is created: a conversation opens. It's closed: that joins it. Another alert meanwhile: a second conversation.",
  },
  {
    id: "other",
    name: "Something else",
    blurb: "Any service",
    defaultName: "",
    format: "raw",
    verification: { kind: "hmac-sha256", header: "x-ryph-signature", prefix: "sha256=" },
    secretSource: "minted",
    keyNoun: "ID",
    eventNoun: "request",
    keyExample: "Requests with the same ID share a conversation. A new ID opens another.",
  },
];

export function presetById(id: PresetId): WebhookPreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[PRESETS.length - 1];
}

/** The preset a saved format reads as: its own, or "other" for raw and custom. */
export function presetOfFormat(format: WebhookFormat): WebhookPreset {
  return PRESETS.find((p) => p.id !== "other" && p.format === format.kind) ?? presetById("other");
}

/** What the automation's page says sends to it. */
export function formatLabel(format: WebhookFormat): string {
  if (format.kind === "custom") return "Something else, read with your own fields";
  if (format.kind === "raw") return "Something else, passed on as is";
  return presetOfFormat(format).name;
}

/** Whether fires in this format carry a key, so "the one for the same alert" means something. */
export function formatYieldsKeys(format: WebhookFormat): boolean {
  if (format.kind === "custom") return format.mapping.key.length > 0;
  return format.kind !== "raw";
}

/** What happens each time an automation starts: a plain run, or one of the ways a conversation
 * is kept. A plain run saves as no response policy; the rest save as its correlation. */
export type ResponseChoice = "run" | Correlation;

/** "an alert", "an incident event": the noun with its article. */
export function withArticle(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}

/**
 * The response choice said in a few words, as the review and the automation's page say it.
 * `sender` is the webhook's preset, or null for a schedule.
 */
export function responseSummary(choice: ResponseChoice, sender: WebhookPreset | null): string {
  if (choice === "run") {
    return sender === null ? "Starts a run each time" : `Starts a run per ${sender.eventNoun}`;
  }
  if (choice === "key") return `One conversation per ${sender?.keyNoun ?? "ID"}`;
  if (choice === "fire") {
    return sender === null ? "One conversation per run" : "One conversation per request";
  }
  return "One shared conversation";
}

type SavedVerification = Extract<Automation["trigger"], { kind: "webhook" }>["verification"];

/**
 * Whether the sender's own secret is still to be pasted: a sender that makes its secret was
 * created without it, and the service holds a minted placeholder until it is pasted.
 */
export function awaitingPaste(verification: SavedVerification, format: WebhookFormat): boolean {
  return secretIsPasted(verification, format) && verification.secretSource === "minted";
}

/** Whether the secret is the sender's own, so replacing it means pasting the sender's new one. */
export function secretIsPasted(
  verification: SavedVerification | PresetVerification,
  format: WebhookFormat,
): boolean {
  if (verification.kind === "standard-webhooks") return true;
  if ("secretSource" in verification && verification.secretSource === "pasted") return true;
  const preset = presetOfFormat(format);
  return preset.secretSource === "pasted" && preset.verification.kind === verification.kind;
}

/** Whether a verification is exactly the preset's, so the vendor's own steps for it apply. */
export function isPresetVerification(
  preset: WebhookPreset,
  verification: SavedVerification | PresetVerification,
): boolean {
  const want = preset.verification;
  if (want.kind !== verification.kind) return false;
  if (want.kind === "standard-webhooks" || verification.kind === "standard-webhooks") return true;
  return want.header.toLowerCase() === verification.header.toLowerCase() &&
    want.prefix === verification.prefix;
}

// ── pasted secrets ──────────────────────────────────────────────────────────────────────────────

/** Why a pasted secret would be refused, in the person's words, or null. */
export function pastedSecretProblem(
  secret: string,
  verification: { kind: PresetVerification["kind"] },
  vendor: string,
): string | null {
  const s = secret.trim();
  if (s === "") return `Paste the signing secret from ${vendor}.`;
  if (!/^[\x20-\x7e]+$/.test(s)) return "That has characters a secret can't have. Copy it again.";
  if (s.length < 16) return "That's too short to be the whole secret. Copy it again.";
  if (s.length > 512) return "That's longer than a secret can be. Copy just the secret.";
  if (
    verification.kind === "standard-webhooks" &&
    !/^[A-Za-z0-9+/]+={0,2}$/.test(s.replace(/^whsec_/, ""))
  ) {
    return "That isn't the whole signing secret. Copy it again, whsec_ and all.";
  }
  return null;
}

// ── custom mappings ─────────────────────────────────────────────────────────────────────────────

/** A mapping as the form holds it: one comma-separated line per list. */
export type MappingFields = Record<keyof SignalMapping, string>;

export function blankMapping(): MappingFields {
  return { status: "", firing: "", resolved: "", update: "", key: "", title: "" };
}

export function splitList(line: string): string[] {
  return line.split(",").map((part) => part.trim()).filter((part) => part !== "");
}

export function composeMapping(fields: MappingFields): SignalMapping {
  return {
    status: splitList(fields.status),
    firing: splitList(fields.firing),
    resolved: splitList(fields.resolved),
    update: splitList(fields.update),
    key: splitList(fields.key),
    title: splitList(fields.title),
  };
}

export function mappingToFields(mapping: SignalMapping): MappingFields {
  return {
    status: mapping.status.join(", "),
    firing: mapping.firing.join(", "),
    resolved: mapping.resolved.join(", "),
    update: mapping.update.join(", "),
    key: mapping.key.join(", "),
    title: mapping.title.join(", "),
  };
}

/** Why a custom mapping can't be saved, or null. */
export function mappingProblem(fields: MappingFields): string | null {
  const mapping = composeMapping(fields);
  if (mapping.status.length === 0 && mapping.key.length === 0 && mapping.title.length === 0) {
    return "Give at least one field to read, or pass the body on as is.";
  }
  if (mapping.status.length > 0 && mapping.firing.length + mapping.resolved.length === 0) {
    return "Say which status values mean firing or resolved.";
  }
  for (const list of Object.values(mapping)) {
    if (list.length > 20) return "Each list holds up to 20 entries.";
    if (list.some((entry) => entry.length > 200)) return "Each entry is up to 200 characters.";
  }
  return null;
}

// ── setup steps ─────────────────────────────────────────────────────────────────────────────────

/** Stands in for a minted secret that was shown once and is gone. */
export const SECRET_PLACEHOLDER = "<your secret>";

export interface SetupValue {
  label: string;
  value: string;
  /** Several lines: shown as a block of code. */
  block?: boolean;
  /** The secret, which is no longer known here: shown as a placeholder with no copy. */
  missing?: boolean;
}

export interface SetupStep {
  text: string;
  /** Where to click, in the sender's own menu names. */
  path?: string[];
  link?: { href: string; label: string };
  values?: SetupValue[];
  note?: string;
}

export interface SetupContext {
  url: string;
  /** The minted secret, while it is still known; null once it has been shown. */
  secret: string | null;
  verification: SavedVerification | PresetVerification;
  /** The automation's name, for names the sender asks for. */
  name: string;
}

/** A header as it reads in a vendor's form: `X-Ryph-Secret`, `Authorization`. */
export function displayHeader(header: string): string {
  return header.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("-");
}

/** A Datadog webhook name: letters, digits and dashes. */
export function datadogWebhookName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? "ryph" : slug.slice(0, 60);
}

/** The payload Datadog is given: every field the datadog format reads, and a few for the agent. */
export const DATADOG_PAYLOAD = `{
  "source": "datadog",
  "transition": "$ALERT_TRANSITION",
  "cycle_key": "$ALERT_CYCLE_KEY",
  "aggreg_key": "$AGGREG_KEY",
  "monitor_id": "$ALERT_ID",
  "scope": "$ALERT_SCOPE",
  "title": "$ALERT_TITLE",
  "event_title": "$EVENT_TITLE",
  "priority": "$ALERT_PRIORITY",
  "link": "$LINK",
  "event_id": "$ID",
  "date": "$DATE",
  "org_id": "$ORG_ID"
}`;

function urlValue(ctx: SetupContext): SetupValue {
  return { label: "URL", value: ctx.url };
}

function secretValue(ctx: SetupContext, label = "Secret"): SetupValue {
  return ctx.secret === null
    ? { label, value: SECRET_PLACEHOLDER, missing: true }
    : { label, value: ctx.secret };
}

const secretText = (ctx: SetupContext) => ctx.secret ?? SECRET_PLACEHOLDER;

/** How to authenticate when the verification is not the preset's own: said for any sender. */
function genericAuthStep(ctx: SetupContext): SetupStep {
  const v = ctx.verification;
  if (v.kind === "standard-webhooks") {
    return {
      text: "Copy the sender's signing secret and paste it below. It starts with whsec_.",
    };
  }
  if (v.kind === "hmac-sha256") {
    return {
      text: "Have it sign each request with the secret, in this header.",
      values: [{ label: "Header", value: displayHeader(v.header) }, secretValue(ctx)],
      note: `The signature is an HMAC-SHA256 of the raw body, as hex${
        v.prefix === "" ? "" : `, written after ${v.prefix}`
      }.`,
    };
  }
  return {
    text: "Have it send this header with every request.",
    values: [
      { label: "Header", value: displayHeader(v.header) },
      ctx.secret === null
        ? { label: "Value", value: `${v.prefix}${SECRET_PLACEHOLDER}`, missing: true }
        : { label: "Value", value: `${v.prefix}${ctx.secret}` },
    ],
  };
}

function alertmanagerYaml(ctx: SetupContext, withAuth: boolean): string {
  const lines = [
    "receivers:",
    "  - name: ryph",
    "    webhook_configs:",
    `      - url: ${ctx.url}`,
    "        send_resolved: true",
  ];
  if (withAuth) {
    lines.push(
      "        http_config:",
      "          authorization:",
      "            type: Bearer",
      `            credentials: ${secretText(ctx)}`,
    );
  }
  return lines.join("\n");
}

const ROUTE_YAML = `route:
  routes:
    - receiver: ryph
      continue: true`;

/** The numbered steps that connect a sender, from opening its settings to the last save. */
export function setupSteps(presetId: PresetId, ctx: SetupContext): SetupStep[] {
  const preset = presetById(presetId);
  const own = isPresetVerification(preset, ctx.verification);
  const auth = (vendor: SetupStep[]): SetupStep[] => (own ? vendor : [genericAuthStep(ctx)]);

  switch (presetId) {
    case "grafana":
      return [
        {
          text: "In Grafana, add a contact point.",
          path: [
            "Alerts & IRM",
            "Alerting",
            "Notification configuration",
            "Contact points",
            "+ Add contact point",
          ],
        },
        { text: "Choose Webhook as the integration and paste the URL.", values: [urlValue(ctx)] },
        ...auth([{
          text:
            "In the webhook's optional settings, find HMAC Signature and paste the secret. Keep the header as it is and leave the timestamp header empty.",
          values: [
            secretValue(ctx),
            { label: "Header", value: "X-Grafana-Alerting-Signature" },
          ],
          note:
            "No HMAC Signature setting? Your Grafana is older than this needs. Create the automation again and choose a header in Advanced.",
        }]),
        {
          text:
            "Save the contact point, then choose it in a notification policy or on an alert rule.",
          note: "Keep Disable resolved message off, so resolves reach the conversation.",
        },
      ];
    case "alertmanager":
      return [
        {
          text: "Add a receiver to alertmanager.yml.",
          values: [{ label: "alertmanager.yml", value: alertmanagerYaml(ctx, own), block: true }],
          ...(ctx.secret === null && own
            ? { note: `Put your secret where it says ${SECRET_PLACEHOLDER}.` }
            : {}),
        },
        ...(own ? [] : [genericAuthStep(ctx)]),
        {
          text: "Route alerts to it, then reload Alertmanager.",
          values: [{ label: "Route", value: ROUTE_YAML, block: true }],
          note: "Add matchers to the route to send only some alerts here.",
        },
      ];
    case "grafana-irm":
      return [
        {
          text: "In Grafana, create an outgoing webhook.",
          path: [
            "Alerts & IRM",
            "IRM",
            "Integrations",
            "Outgoing Webhooks",
            "+ Create an Outgoing Webhook",
          ],
          note: "Choose the preset Advanced webhook for alert groups.",
        },
        {
          text:
            "Set the trigger type to Alert group created and the method to POST, then paste the URL.",
          values: [urlValue(ctx)],
        },
        { text: "Turn on Forward whole payload." },
        ...auth([{
          text: "Paste the secret into the Authorization field.",
          values: [secretValue(ctx)],
        }]),
        {
          text:
            "Save it, then create a second webhook the same way with the trigger type Status change, so resolves and acknowledgements arrive too.",
        },
      ];
    case "pagerduty":
      return [
        {
          text: "In PagerDuty, add a generic webhook.",
          path: ["Integrations", "Generic Webhooks (v3)", "+ New Webhook"],
        },
        {
          text: "Paste the URL, and choose what it covers: a service, a team or the whole account.",
          values: [urlValue(ctx)],
        },
        {
          text: "Subscribe to at least these events.",
          values: [{
            label: "Events",
            value: "incident.triggered, incident.resolved, incident.reopened",
          }],
          note:
            "Other incident events, like acknowledgements, join an open conversation as updates.",
        },
        ...auth([{
          text: "Save. PagerDuty shows the signing secret once: copy it and paste it below.",
        }]),
      ];
    case "sentry":
      return [
        {
          text: "In Sentry, create an internal integration.",
          path: [
            "Settings",
            "Developer Settings",
            "Custom Integrations",
            "Create New Integration",
            "Internal Integration",
          ],
        },
        { text: "Paste the URL as its Webhook URL.", values: [urlValue(ctx)] },
        {
          text: "Turn on Alert Rule Action, and under Webhooks tick issue.",
          note: "Issue webhooks arrive for every new issue. Alert rules alone are quieter.",
        },
        ...auth([{
          text: "Save, then copy the Client Secret under Credentials and paste it below.",
        }]),
        {
          text:
            "For metric alerts, add the action Send a notification via your integration to an alert rule.",
        },
      ];
    case "incident-io":
      return [
        {
          text: "In incident.io, open Webhooks and add an endpoint.",
          path: ["Settings", "Webhooks"],
          link: { href: "https://app.incident.io/~/settings/webhooks", label: "Open Webhooks" },
        },
        { text: "Paste the URL.", values: [urlValue(ctx)] },
        {
          text: "Subscribe to these two events.",
          values: [
            { label: "Incident created", value: "public_incident.incident_created_v2" },
            {
              label: "Status updated",
              value: "public_incident.incident_status_updated_v2",
            },
          ],
          note: "Private incidents arrive with only their ID.",
        },
        ...auth([{
          text: "Copy the signing secret from the endpoint's page and paste it below.",
        }]),
      ];
    case "datadog": {
      const hook = datadogWebhookName(ctx.name);
      return [
        {
          text: "In Datadog, open the Webhooks integration and add a webhook.",
          path: ["Integrations", "Webhooks", "Configuration", "+ New"],
        },
        {
          text: "Name it and paste the URL.",
          values: [{ label: "Name", value: hook }, urlValue(ctx)],
        },
        {
          text: "Paste this as the payload.",
          values: [{ label: "Payload", value: DATADOG_PAYLOAD, block: true }],
          note: "Leave Encode as form unchecked.",
        },
        ...auth([{
          text: "Turn on Custom Headers and paste this.",
          values: [{
            label: "Custom headers",
            value: `{"${displayHeader(MINTED_HEADER)}": "${secretText(ctx)}"}`,
            block: true,
          }],
          ...(ctx.secret === null
            ? { note: `Put your secret where it says ${SECRET_PLACEHOLDER}.` }
            : {}),
        }]),
        {
          text:
            "Mention the webhook in each monitor's message. Keep it outside any {{#is_alert}} block, so recoveries are sent too.",
          values: [{ label: "Mention", value: `@webhook-${hook}` }],
        },
      ];
    }
    case "opsgenie":
      return [
        {
          text: "In Opsgenie, add a Webhook integration.",
          path: ["Settings", "Integrations", "Add integration", "Webhook"],
        },
        { text: "Paste the URL as the Webhook URL.", values: [urlValue(ctx)] },
        ...auth([{
          text: "Add a custom header.",
          values: [
            { label: "Header", value: displayHeader(MINTED_HEADER) },
            secretValue(ctx, "Value"),
          ],
        }]),
        {
          text:
            "Under Alert Actions, post to the webhook when an alert is created and when it is closed.",
          note: "Without the close action, a resolve never arrives.",
        },
        { text: "Turn the integration on and save it." },
      ];
    case "other":
      return [
        { text: "Have the sender POST its requests to this URL.", values: [urlValue(ctx)] },
        genericAuthStep(ctx),
      ];
  }
}

// ── the first request ───────────────────────────────────────────────────────────────────────────

/** What a fire's outcome means, said to the person who just connected the sender. */
export function fireOutcomeSentence(outcome: string): { ok: boolean; text: string } {
  switch (outcome) {
    case "started":
      return { ok: true, text: "Received. It started a run." };
    case "joined":
      return { ok: true, text: "Received. It joined the open conversation." };
    case "resolved":
      return { ok: true, text: "Received a resolve. Nothing was open, so nothing started." };
    case "ignored":
      return { ok: true, text: "Received a status update. Nothing was open, so nothing started." };
    case "rate-limited":
      return { ok: false, text: "Received, but over the rate limit, so it was dropped." };
    case "no-such-agent":
      return { ok: false, text: "Received, but the agent no longer exists." };
    case "no-such-repo":
      return { ok: false, text: "Received, but the repository no longer exists." };
    case "no-such-workspace":
      return { ok: false, text: "Received, but the workspace no longer exists." };
    case "no-linked-identity":
      return { ok: false, text: "Received, but the automation's owner has no linked account." };
    case "refused":
    case "denied":
      return { ok: false, text: "Received, but the run was refused." };
    default:
      return { ok: false, text: "Received, but it couldn't be delivered." };
  }
}
