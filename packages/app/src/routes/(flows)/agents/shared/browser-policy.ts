// The Browser switch's rules, beside the switch (browser-fields.svelte), so they are tested on
// their own.

import type { Harness } from "$lib/api/types";

/**
 * Turning a browser on is an administrator's call, as turning patches back on is: anyone else finds
 * the switch held off. One already on stays movable, so it can be turned off.
 */
export function browserLocked(enabled: boolean, canGrant: boolean): boolean {
  return !enabled && !canGrant;
}

/**
 * Why the switch is held off on this deployment, for the line under it. Null when the harness can
 * have a browser here.
 */
export function browserUnavailableNote(
  harness: Pick<Harness, "browser" | "browserUnavailable">,
): string | null {
  if (harness.browser) return null;
  switch (harness.browserUnavailable) {
    case "harness":
      return "This harness can't use a browser.";
    case "provisioner":
      return "Not available with this deployment's runner.";
    case "image":
      return "This deployment has no browser set up.";
    default:
      return "This deployment can't give this agent a browser.";
  }
}

/**
 * What a new agent is sent: the switch as left, but only when the form offered it. A switch turned
 * on and then held off by a harness without a browser would otherwise still be sent as on.
 */
export function createBrowserEnabled(
  switchedOn: boolean,
  form: { offered: boolean; canGrant: boolean },
): boolean {
  return form.offered && form.canGrant && switchedOn;
}
