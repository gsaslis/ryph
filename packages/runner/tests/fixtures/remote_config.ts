// What the agent can write into its checkout's config to steer a fetch made through `origin`:
// another origin, an upload-pack of its own, a fetch refspec of its own, and a proxy. The
// runner's fetches go by explicit URL into an explicit ref (src/helpers/fetch.ts), so none of it
// applies; tests plant all of it and check that nothing it names was used.

import { stat, writeFile } from "node:fs/promises";
import { serve } from "@ryph/service";
import { git } from "../../src/helpers/git_exec.ts";
import { makeThrowawayOrigin } from "./origin.ts";

export interface PlantedRemote {
  /** Whether the planted upload-pack ran. */
  uploadPackRan(): Promise<boolean>;
  /** The requests the planted proxy was sent. */
  proxied: string[];
  /** Whether a ref the planted fetch refspec names exists in the checkout. */
  decoyRefs(): Promise<string>;
  cleanup(): Promise<void>;
}

/**
 * Plants the config in the checkout at `dir`. `url` is the run's own URL for the repo: the proxy
 * keys scoped to it are planted too when it is an http one.
 */
export async function plantRemoteConfig(dir: string, url: string): Promise<PlantedRemote> {
  const decoy = await makeThrowawayOrigin({ files: { "decoy.txt": "not the run's origin\n" } });
  const proxied: string[] = [];
  const proxy = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    proxied.push(req.url);
    return new Response("no", { status: 502 });
  });
  const proxyUrl = `http://127.0.0.1:${proxy.addr.port}`;
  const marker = `${decoy.dir}/upload-pack-ran`;
  const uploadPack = `${decoy.dir}/upload-pack`;
  await writeFile(uploadPack, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
  const planted: Array<[string, string]> = [
    ["remote.origin.url", decoy.url],
    ["remote.origin.uploadpack", uploadPack],
    ["remote.origin.fetch", "+refs/heads/*:refs/remotes/decoy/*"],
    ["http.proxy", proxyUrl],
  ];
  if (/^https?:\/\//.test(url)) {
    planted.push([`http.${url}.proxy`, proxyUrl], [`remote.${url}.proxy`, proxyUrl]);
  }
  for (const [key, value] of planted) await git(dir, "config", "--replace-all", key, value);
  return {
    uploadPackRan: () => stat(marker).then(() => true, () => false),
    proxied,
    decoyRefs: () => git(dir, "for-each-ref", "--format=%(refname)", "refs/remotes/decoy/"),
    cleanup: async () => {
      await proxy.shutdown();
      await decoy.cleanup();
    },
  };
}
