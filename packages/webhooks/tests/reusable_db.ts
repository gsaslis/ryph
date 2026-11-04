import { reusableDbSuite as sharedSuite } from "@ryph/db/testing";
import * as schema from "../src/adapters/store/db/schema.ts";
import { makeTestDb } from "./db.ts";

export function reusableDbSuite(name: string) {
  return sharedSuite(name, { open: makeTestDb, schema });
}
