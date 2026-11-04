import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { findPublicDevSecrets, judgeDevSecrets, PUBLIC_DEV_SECRETS } from "../src/dev_secrets.ts";

test("a clean environment boots", () => {
  assertEquals(
    judgeDevSecrets({ RYPH_FORGE_TOKEN: crypto.randomUUID(), PATH: "/usr/bin" }),
    { kind: "clean" },
  );
});

test("every committed placeholder is refused", () => {
  for (const secret of PUBLIC_DEV_SECRETS) {
    assertEquals(judgeDevSecrets({ SOME_SECRET: secret }), {
      kind: "refused",
      names: ["SOME_SECRET"],
    });
  }
});

test("the postgres password is caught inside a database url", () => {
  assertEquals(
    findPublicDevSecrets({
      RYPH_DB: "postgres://ryph:dev-postgres-password@postgres:5432/ryph",
      RYPH_SECRETS_KEY: "deadbeef".repeat(8),
      RYPH_PORT: "7411",
    }),
    ["RYPH_DB", "RYPH_SECRETS_KEY"],
  );
});

test("RYPH_ALLOW_DEV_SECRETS=1 lets them through, and only 1 does", () => {
  const env = { RYPH_HISTORY_TOKEN: "dev-history-token" };
  assertEquals(judgeDevSecrets({ ...env, RYPH_ALLOW_DEV_SECRETS: "1" }), {
    kind: "allowed",
    names: ["RYPH_HISTORY_TOKEN"],
  });
  assertEquals(judgeDevSecrets({ ...env, RYPH_ALLOW_DEV_SECRETS: "true" }).kind, "refused");
});

test("a generated dev token that merely starts with dev- is fine", () => {
  // packages/devstack's init mints `dev-<uuid>` for the forge pair.
  assertEquals(judgeDevSecrets({ RYPH_FORGE_TOKEN: `dev-${crypto.randomUUID()}` }), {
    kind: "clean",
  });
});

// The environments @ryph/shared/env refuses (a Bun variable that changes what the runtime does,
// TLS verification turned off) refuse to boot every service, in a real process, since the
// refusal is an exit.
test("a hostile environment refuses to boot, and a verifying one boots", async () => {
  const { spawnSync } = await import("node:child_process");
  const boot = (extra: Record<string, string>) =>
    spawnSync(process.execPath, [
      "--no-env-file",
      "-e",
      `const { refusePublicDevSecrets } = await import(${
        JSON.stringify(new URL("../src/dev_secrets.ts", import.meta.url).pathname)
      }); refusePublicDevSecrets("probe"); console.log("booted");`,
    ], { env: { PATH: process.env.PATH ?? "", ...extra }, encoding: "utf8" });
  const envs: Record<string, string>[] = [
    { BUN_OPTIONS: "--smol" },
    { BUN_BE_BUN: "1" },
    { BUN_INSPECT_NOTIFY: "unix:///tmp/nowhere" },
    { BUN_INSPECT_CONNECT_TO: "ws://127.0.0.1:1" },
    { BUN_CONFIG_VERBOSE_FETCH: "1" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "false" },
  ];
  for (const env of envs) {
    const refused = boot(env);
    assertEquals(refused.status, 2, refused.stderr);
    assertEquals(refused.stdout, "");
    assert(refused.stderr.startsWith(`error: probe: ${Object.keys(env)[0]}`), refused.stderr);
  }
  const clean = boot({});
  assertEquals([clean.status, clean.stdout], [0, "booted\n"]);
  const verifying = boot({ NODE_TLS_REJECT_UNAUTHORIZED: "1" });
  assertEquals([verifying.status, verifying.stdout], [0, "booted\n"]);
});
