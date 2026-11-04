// Only a deployment-configured renderer is dialled, never an author-supplied URL. The renderer
// must live in a separate, credential-free container with network egress denied
// (deploy/helm/ryph/templates/artifact-thumbnails.yaml).
import { readCappedBytes } from "@ryph/shared/http";
import { isThumbnail, THUMBNAIL_MAX_BYTES } from "../../core/artifact_thumbnails.ts";
import type { ArtifactThumbnailRenderer } from "../../ports/artifact_thumbnail.ts";

export function httpArtifactThumbnail(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
  socket?: string,
): ArtifactThumbnailRenderer {
  const url = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search ||
    url.hash
  ) {
    throw new Error(
      "RYPH_ARTIFACT_THUMBNAIL_URL must be an HTTP(S) URL without credentials, query or fragment",
    );
  }
  const endpoint = new URL("render", url.href.endsWith("/") ? url : new URL(`${url.href}/`));
  return {
    async render(html, signal) {
      const body = new TextEncoder().encode(html);
      if (body.byteLength > 24 * 1024 * 1024) throw new Error("thumbnail document is too large");
      const response = await fetcher(endpoint, {
        ...(socket === undefined ? {} : { unix: socket }),
        method: "POST",
        headers: { "content-type": "text/html; charset=utf-8" },
        body,
        redirect: "error",
        signal: signal === undefined
          ? AbortSignal.timeout(20_000)
          : AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "image/png") {
        await response.body?.cancel();
        throw new Error("thumbnail renderer unavailable");
      }
      const result = await readCappedBytes(
        response,
        THUMBNAIL_MAX_BYTES,
        AbortSignal.timeout(5_000),
      );
      if (!result.ok || !isThumbnail(result.bytes)) throw new Error("invalid thumbnail response");
      return result.bytes;
    },
  };
}

export function artifactThumbnailFromEnv(
  env: (name: string) => string | undefined,
): ArtifactThumbnailRenderer | null {
  const url = env("RYPH_ARTIFACT_THUMBNAIL_URL");
  const socket = env("RYPH_ARTIFACT_THUMBNAIL_SOCKET");
  if (socket !== undefined) {
    if (url !== undefined || !socket.startsWith("/") || socket.includes("\0")) {
      throw new Error(
        "Set either RYPH_ARTIFACT_THUMBNAIL_URL or an absolute RYPH_ARTIFACT_THUMBNAIL_SOCKET",
      );
    }
    // Bun's HTTP client over a Unix socket: Compose gives the renderer no network at all.
    return httpArtifactThumbnail("http://localhost", fetch, socket);
  }
  return url === undefined ? null : httpArtifactThumbnail(url);
}
