import { apiCall } from "./call";
import { type ReservedCapacity, reservedCapacitySchema } from "./types";

/**
 * The slots held for each size class, and how many of them the cluster has ready. Takes
 * `resources:manage`, like picking a size class, because both spend the operator's money.
 */
export async function getReservedCapacity(f = fetch): Promise<ReservedCapacity> {
  return reservedCapacitySchema.parse(await apiCall(f, "/v1/reserved-capacity"));
}

/**
 * The same, or null when it could not be read. The Platform page must still open when the
 * control plane does not answer this one route; the section then says it could not load.
 */
export async function getReservedCapacityOrNull(f = fetch): Promise<ReservedCapacity | null> {
  try {
    return await getReservedCapacity(f);
  } catch {
    return null;
  }
}

/**
 * Replaces the whole setting: a class left out holds nothing. The API refuses a class the
 * deployment does not define, more than `maxSlots`, and any save on a provisioner that cannot
 * reserve (409). Answers the stored state, whose `ready` counts usually lag the save.
 */
export async function putReservedCapacity(
  slots: Record<string, number>,
  f = fetch,
): Promise<ReservedCapacity> {
  const res = await apiCall(f, "/v1/reserved-capacity", {
    method: "PUT",
    body: JSON.stringify({ slots }),
  });
  return reservedCapacitySchema.parse(res);
}
