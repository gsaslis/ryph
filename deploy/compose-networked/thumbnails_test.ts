// Assert the Compose security boundary as parsed data, without starting Docker.
/* oxlint-disable typescript/no-explicit-any */
import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import profile from "../../packages/host/src/thumbnail_seccomp.json" with { type: "json" };

for (const [directory, backend] of [["compose", "ryph"], ["compose-networked", "control-plane"]]) {
  test(`${directory}: thumbnail sandbox works without granting network or blocking publication`, async () => {
    const manifest = new URL(`../${directory}/compose.yaml`, import.meta.url);
    const { services } = Bun.YAML.parse(await readFile(manifest, "utf8")) as any;
    const renderer = services["artifact-thumbnails"];
    assertEquals(renderer.network_mode, "none");
    // Not RYPH_BROWSER_IMAGE, which is `off` where agents have no browser.
    assertEquals(renderer.image.includes("RYPH_BROWSER_IMAGE"), false);
    assertEquals(renderer.image.startsWith("${RYPH_ARTIFACT_THUMBNAIL_IMAGE:-"), true);
    assertEquals(renderer.networks, undefined);
    assertEquals(renderer.ports, undefined);
    assertEquals(renderer.user, "1994:1994");
    assertEquals(renderer.read_only, true);
    assertEquals(renderer.cap_drop, ["ALL"]);
    assertEquals(renderer.cap_add, undefined);
    assertEquals(renderer.privileged ?? false, false);
    assertEquals(renderer.security_opt.includes("no-new-privileges:true"), true);
    const profiles = renderer.security_opt.filter((option: string) =>
      option.startsWith("seccomp=")
    );
    assertEquals(profiles.length, 1);
    const path = new URL(profiles[0].slice("seccomp=".length), manifest);
    assertEquals(
      fileURLToPath(path),
      fileURLToPath(new URL("../../packages/host/src/thumbnail_seccomp.json", import.meta.url)),
    );
    assertEquals(JSON.parse(await readFile(path, "utf8")), profile);
    assertEquals(renderer.environment.RYPH_THUMBNAIL_SANDBOX, "required");
    assertEquals(renderer.env_file, undefined);
    for (const variable of ["HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY", "NO_PROXY"]) {
      assertEquals(renderer.environment[variable], "");
      assertEquals(renderer.environment[variable.toLowerCase()], "");
    }
    // Thumbnails are optional; their health must never gate the publishing backend's startup.
    const dependencies = services[backend].depends_on ?? {};
    if (Array.isArray(dependencies)) {
      assertEquals(dependencies.includes("artifact-thumbnails"), false);
    } else {
      const thumbnailDependency = dependencies["artifact-thumbnails"];
      assertEquals(
        thumbnailDependency === undefined || thumbnailDependency.required === false,
        true,
      );
    }
  });
}

// Namespace/chroot allows and clone3's ENOSYS fallback are pinned in
// packages/host/tests/artifact_thumbnail_test.ts. Both manifests above must use that exact file.
