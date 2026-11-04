// The plain icon each sender is drawn with: what it is, not its logo.

import ActivityIcon from "@lucide/svelte/icons/activity";
import BellRingIcon from "@lucide/svelte/icons/bell-ring";
import BugIcon from "@lucide/svelte/icons/bug";
import ChartLineIcon from "@lucide/svelte/icons/chart-line";
import FlameIcon from "@lucide/svelte/icons/flame";
import MegaphoneIcon from "@lucide/svelte/icons/megaphone";
import PhoneIncomingIcon from "@lucide/svelte/icons/phone-incoming";
import RadioTowerIcon from "@lucide/svelte/icons/radio-tower";
import WebhookIcon from "@lucide/svelte/icons/webhook";
import type { PresetId } from "./presets";

export const PRESET_ICONS: Record<PresetId, typeof WebhookIcon> = {
  grafana: ChartLineIcon,
  alertmanager: BellRingIcon,
  "grafana-irm": PhoneIncomingIcon,
  pagerduty: RadioTowerIcon,
  sentry: BugIcon,
  "incident-io": FlameIcon,
  datadog: ActivityIcon,
  opsgenie: MegaphoneIcon,
  other: WebhookIcon,
};
