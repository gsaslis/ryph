// The platform's resolver, in the shape the upstream guard wants: every address a name has, or
// [] when it has none. Both record types are asked; a name with only one kind is normal, so a
// failed lookup on the other side is not an error.

import { resolve4, resolve6 } from "node:dns/promises";

export async function systemResolve(hostname: string): Promise<string[]> {
  const results = await Promise.allSettled([
    resolve4(hostname),
    resolve6(hostname),
  ]);
  return results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
}
