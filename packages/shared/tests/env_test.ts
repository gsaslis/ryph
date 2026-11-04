// The environment a ryph process refuses to start under (src/env.ts).

import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { hostileEnvironment, hostileVariables } from "../src/env.ts";

test("BUN_OPTIONS, BUN_BE_BUN, BUN_INSPECT*, BUN_CONFIG_VERBOSE_FETCH and a NODE_TLS_REJECT_UNAUTHORIZED but 1 are refused", () => {
  assertEquals(hostileEnvironment({ PATH: "/bin", BUN_INSTALL: "/x" }), null);
  assertEquals(hostileEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "1" }), null);
  assertEquals(hostileEnvironment({ BUN_OPTIONS: undefined }), null);
  for (
    const env of [
      { BUN_OPTIONS: "--preload=/tmp/x.js" },
      { BUN_OPTIONS: "" },
      { BUN_BE_BUN: "1" },
      { BUN_INSPECT: "127.0.0.1:9229" },
      { BUN_INSPECT_CONNECT_TO: "ws://127.0.0.1:9229" },
      { BUN_INSPECT_PRELOAD: "/tmp/x.js" },
      { BUN_CONFIG_VERBOSE_FETCH: "curl" },
      { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      { NODE_TLS_REJECT_UNAUTHORIZED: "" },
    ]
  ) {
    const name = Object.keys(env)[0]!;
    const found = hostileEnvironment(env);
    assertEquals(found?.name, name);
    assertStringIncludes(found?.message ?? "", name);
  }
});

test("every offender is named, so a caller can tell the TLS variable is the only one", () => {
  const env = { NODE_TLS_REJECT_UNAUTHORIZED: "0", BUN_INSPECT: "x", BUN_OPTIONS: "" };
  assertEquals(hostileVariables(env).map((v) => v.name), [
    "BUN_OPTIONS",
    "BUN_INSPECT",
    "NODE_TLS_REJECT_UNAUTHORIZED",
  ]);
  assertEquals(
    hostileVariables({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }).map((v) => v.name),
    ["NODE_TLS_REJECT_UNAUTHORIZED"],
  );
});

test("from an environment image, the message says how to fix the image", () => {
  assertEquals(
    hostileEnvironment({ BUN_OPTIONS: "--smol" }, { fromImage: true })?.message,
    "BUN_OPTIONS is set; unset it (from an environment image: remove its ENV BUN_OPTIONS) to run this",
  );
  assertStringIncludes(
    hostileEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { fromImage: true })?.message ?? "",
    "NODE_EXTRA_CA_CERTS",
  );
  assertEquals(
    hostileEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "0" })?.message,
    "NODE_TLS_REJECT_UNAUTHORIZED=0 would turn off certificate checks; unset it",
  );
});
