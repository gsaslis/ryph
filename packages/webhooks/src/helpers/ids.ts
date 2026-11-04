// Hook ids: path- and slug-safe, the same shape as every other ryph id (`r-01jb7k3m9x4q8zt2vw6hn5c0fe`).

import { mintId } from "@ryph/sealed";

/** e.g. "wh-01jb7k3m9x4q8zt2vw6hn5c0fe" */
export function mintHookId(): string {
  return mintId("wh");
}

/** Registration ids ride URLs; hold them to the same slug shape as agent handles. */
export const REGISTRATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}$/;
