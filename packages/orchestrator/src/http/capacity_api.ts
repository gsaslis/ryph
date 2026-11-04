// The reserved capacity surface: how many warm slots each size class holds, and an admin moving
// them (core/reserved_capacity.ts).
//
// Invariants:
// - both routes take `resources:manage`, the capability that already gates size classes because
//   they spend the operator's money; a slot spends it whether or not a run ever uses it
// - unsupported is an answer, not an error: a provisioner without the capability reads as
//   `supported: false`, and a save there is a 409 that stores nothing, so nobody is shown a
//   setting that would silently do nothing
// - the cluster's view is best-effort and bounded. A status read that fails or hangs answers
//   `ready: null` on every class; the saved setting is still read and still
//   saveable, because a dead API server is exactly when an admin needs to see what was asked for
// - a class reads as what one slot holds: the class, and room for `services` service containers
// - a save is a full replace normalised against the configuration: only configured classes above
//   zero are stored, so a class an operator removed falls out of the row on the next save

import {
  MAX_RESERVED_SLOTS,
  reservable,
  reservedCapacityRefusal,
  slotsOf,
} from "../core/reserved_capacity.ts";
import type { ReservationStatus } from "../ports/provisioner.ts";
import { ReservedCapacitySchema } from "../schema.ts";
import type { WiredDeps } from "./app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, parseBody, type Route, route } from "@ryph/shared/http";

/** How long a page load waits on the cluster before it answers without it. */
const STATUS_TIMEOUT_MS = 10_000;

export function capacityRoutes(deps: WiredDeps): Route[] {
  /** The status, or null when it could not be had in time. Never throws. */
  const observe = async (): Promise<ReservationStatus[] | null> => {
    const capacity = deps.capacity ?? null;
    if (capacity === null) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        capacity.status(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), STATUS_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      deps.diag.warn("capacity.status_failed", { err: String(err) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const view = async (): Promise<Record<string, unknown>> => {
    const { classes, defaultName } = deps.config.runSizes;
    const [saved, status] = await Promise.all([deps.store.getReservedCapacity(), observe()]);
    const ready = new Map((status ?? []).map((s) => [s.sizeClass, s.ready]));
    const capacity = deps.capacity ?? null;
    return {
      supported: capacity !== null,
      maxSlots: MAX_RESERVED_SLOTS,
      classes: classes.map((size) => ({
        ...size,
        default: size.name === defaultName,
        reservable: reservable(size),
        // What a slot holds beyond the class: room for this many services, at the most each can
        // get. The class's own fields stay the class's, as the size pickers show them.
        services: capacity === null || !reservable(size) ? 0 : capacity.servicesHeld(size),
        // What the reconciler holds (planReservations): an unreservable class is held at 0
        // whatever an older row says, and the next save drops it from the row.
        slots: saved === null || !reservable(size) ? 0 : slotsOf(saved.slots, size.name),
        ready: status === null ? null : ready.get(size.name) ?? 0,
      })),
      updatedAt: saved?.updatedAt ?? null,
      updatedBy: saved?.updatedBy ?? null,
    };
  };

  return [
    route("GET", "/v1/reserved-capacity", async (req) => {
      const caller = await deps.authenticate(req);
      if (caller instanceof Response) return caller;
      const denied = refuseUnless(caller, "resources:manage", "reading reserved capacity");
      if (denied) return denied;
      return json(200, await view());
    }),

    route("PUT", "/v1/reserved-capacity", async (req) => {
      const caller = await deps.authenticate(req);
      if (caller instanceof Response) return caller;
      const denied = refuseUnless(caller, "resources:manage", "changing reserved capacity");
      if (denied) return denied;
      const body = await parseBody(req, ReservedCapacitySchema);
      if (!body.ok) return body.res;
      const capacity = deps.capacity ?? null;
      if (capacity === null) {
        return json(409, {
          error: "this deployment's provisioner cannot reserve capacity",
          code: "capacity_unsupported",
        });
      }
      const { runSizes } = deps.config;
      const refusal = reservedCapacityRefusal(runSizes, body.data.slots);
      if (refusal !== null) return json(400, { error: refusal });
      const slots: Record<string, number> = {};
      for (const size of runSizes.classes) {
        const count = slotsOf(body.data.slots, size.name);
        if (count > 0) slots[size.name] = count;
      }
      await deps.store.saveReservedCapacity({
        slots,
        updatedAt: deps.now().toISOString(),
        // Break-glass has no identity to record, and saying so beats inventing one.
        updatedBy: caller.kind === "break-glass" ? null : caller.userId,
      });
      // The holder's next reaper tick sees the row move and applies it, whichever replica
      // holds; `ready` in the answer will usually lag.
      return json(200, await view());
    }),
  ];
}
