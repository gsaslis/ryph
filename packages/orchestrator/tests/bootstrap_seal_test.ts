import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  decryptSecret,
  deriveSealingKey,
  importMasterKey,
  mintToken,
  sha256Hex,
} from "@ryph/sealed";
import { openBootstrap, sealBootstrap } from "../src/core/bootstrap.ts";

test("bootstrap sealing: authentication digest is not the encryption key", async () => {
  const token = mintToken();
  const env = { RYPH_RUN_TOKEN: "run-secret", RYPH_GIT_TOKEN: "git-secret" };
  const sealed = await sealBootstrap(token, "r-1", env);
  assert(sealed.startsWith("v2."));
  assert(!sealed.includes("run-secret") && !sealed.includes("git-secret"));
  assertEquals(await openBootstrap(token, "r-1", sealed), env);
  await assertRejects(() => openBootstrap(mintToken(), "r-1", sealed));
  // Bound to its run: the same bundle under another run's id opens nothing.
  await assertRejects(() => openBootstrap(token, "r-2", sealed));
  const persistedDigest = await deriveSealingKey(
    await importMasterKey(await sha256Hex(token)),
    "runner-bootstrap",
  );
  await assertRejects(() => decryptSecret(persistedDigest, sealed, { runId: "r-1" }));
});
