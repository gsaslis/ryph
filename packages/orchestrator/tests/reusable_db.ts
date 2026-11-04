// Package binding for the shared, opt-in CRUD fixture. Session and migration tests use db.ts.
import { reusableDbSuite as sharedSuite, ReusableTestDb as SharedTestDb } from "@ryph/db/testing";
import * as schema from "../src/adapters/store/db/schema.ts";
import { makeTestDb } from "./db.ts";

export class ReusableTestDb extends SharedTestDb<typeof schema> {
  constructor(open = makeTestDb, reuse = !process.env.RYPH_TEST_DB) {
    super({ open, schema, reuse });
  }
}

export function reusableDbSuite(name: string) {
  return sharedSuite(name, { open: makeTestDb, schema, reuse: !process.env.RYPH_TEST_DB });
}
