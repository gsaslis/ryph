import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Child, command } from "@ryph/process";
import {
  artifactThumbnailFromEnv,
  type ArtifactThumbnailRenderer,
  browserImage,
} from "@ryph/orchestrator";
import { defaultImage } from "./images.ts";
import seccomp from "./thumbnail_seccomp.json" with { type: "json" };

const MAX_HTML = 24 * 1024 * 1024;
const MAX_PNG = 4 * 1024 * 1024;

export interface DockerThumbnailOptions {
  image: string;
  runtime?: string;
  /** Injectable executable for tests; arguments never pass through a shell. */
  docker?: string;
  timeoutMs?: number;
  cleanupMs?: number;
  /** Tests can skip image warming; production pulls independently of render deadlines. */
  prefetch?: boolean;
  warn?: (message: string) => void;
}

export interface ManagedThumbnailRenderer extends ArtifactThumbnailRenderer {
  shutdown(): Promise<void>;
}

/** Endpoint overrides always win; a source checkout without a browser image stays opt-in. */
export function localArtifactThumbnail(
  env: (name: string) => string | undefined,
  provisioner: string,
  browserDefault: string | null = defaultImage("browser"),
  warn?: (message: string) => void,
): {
  renderer: ArtifactThumbnailRenderer | null;
  shutdown: () => Promise<void>;
} {
  if (
    env("RYPH_ARTIFACT_THUMBNAIL_URL") !== undefined ||
    env("RYPH_ARTIFACT_THUMBNAIL_SOCKET") !== undefined
  ) {
    return {
      renderer: artifactThumbnailFromEnv(env),
      shutdown: () => Promise.resolve(),
    };
  }
  const configured = env("RYPH_ARTIFACT_THUMBNAIL_IMAGE")?.trim();
  const image = configured?.toLowerCase() === "off"
    ? null
    : configured || browserImage(env("RYPH_BROWSER_IMAGE")) || browserDefault;
  if (provisioner !== "docker" || !image) {
    return { renderer: null, shutdown: () => Promise.resolve() };
  }
  const renderer = dockerArtifactThumbnail({
    image,
    runtime: env("RYPH_DOCKER_RUNTIME"),
    warn,
  });
  return { renderer, shutdown: () => renderer.shutdown() };
}

function kill(child: Child | undefined): void {
  try {
    child?.kill("SIGKILL");
  } catch {
    // Already exited.
  }
}

async function bytes(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > cap) {
      throw new Error("artifact thumbnail output exceeds byte limit");
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * One disposable, credential-free container per document, not a host socket or an interactive
 * browser sidecar. The vendored Playwright seccomp policy permits Chromium's user namespaces
 * without SYS_ADMIN or unconfined seccomp. Host kernel/LSM policy can still deny them: fail
 * closed, never retry without Chromium's sandbox. No caller environment is passed to the image.
 */
export function dockerArtifactThumbnail(
  opts: DockerThumbnailOptions,
): ManagedThumbnailRenderer {
  const docker = opts.docker ?? "docker";
  const active = new Map<AbortController, Promise<Uint8Array>>();
  let closed = false;
  const warned = new Set<string>();
  function warn(message: string): void {
    if (warned.has(message)) return;
    warned.add(message);
    opts.warn?.(message);
  }
  let pull: Promise<void> | undefined;
  let pullChild: Child | undefined;
  let ready = opts.prefetch === false;
  // A cold image can take minutes. Its pull must not be killed by a thumbnail's short deadline;
  // requests fail cheaply until warming completes, and later requests retry a failed pull.
  function warm(): void {
    if (closed || pull || ready) return;
    pull = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      const exec = async (args: string[]) => {
        pullChild = await command(docker, {
          args,
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).spawn();
        if (closed || expired) kill(pullChild);
        return await pullChild.status;
      };
      try {
        await Promise.race([
          (async () => {
            const inspected = await exec(["image", "inspect", opts.image]);
            if (!inspected.success) {
              if (closed || expired) throw new Error("image warming stopped");
              const pulled = await exec(["pull", opts.image]);
              if (!pulled.success) {
                throw new Error("artifact thumbnail image pull failed");
              }
            }
            ready = true;
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              expired = true;
              reject(new Error("image pull timed out"));
            }, 300_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        kill(pullChild);
        pullChild = undefined;
      }
    })().catch(() => {
      if (!closed) {
        warn(
          "artifact thumbnail image pull failed; check RYPH_ARTIFACT_THUMBNAIL_IMAGE and Docker registry access; later requests retry",
        );
      }
    }).finally(() => {
      pull = undefined;
    });
  }
  warm();

  async function remove(name: string, reconcile: boolean): Promise<void> {
    let child: Child | undefined;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          do {
            child = await command(docker, {
              args: ["rm", "--force", name],
              stdin: "null",
              stdout: "null",
              stderr: "null",
            }).spawn();
            if (expired) kill(child);
            const status = await child.status;
            // A successful removal acknowledges this unique name existed and was removed.
            // After cancellation a not-found response may precede daemon-side creation: keep
            // reconciling across the bounded window, not just one early removal attempt.
            if (status.success || !reconcile || expired) return;
            await new Promise((resolve) => setTimeout(resolve, 100));
          } while (!expired);
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            resolve();
          }, opts.cleanupMs ?? 3000);
        }),
      ]);
    } catch {
      // Daemon unavailable, or container already auto-removed. Cleanup is best-effort and bounded.
    } finally {
      clearTimeout(timer);
      kill(child);
    }
  }

  async function run(
    html: string,
    controller: AbortController,
  ): Promise<Uint8Array> {
    const input = new TextEncoder().encode(html);
    if (input.byteLength > MAX_HTML) {
      throw new Error("artifact thumbnail HTML exceeds 24 MiB");
    }
    const signal = controller.signal;
    signal.throwIfAborted();
    const name = `ryph-thumbnail-${crypto.randomUUID()}`;
    let child: Child | undefined;
    let completed = false;
    let directory: string | undefined;
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error("artifact thumbnail aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // Cancellation can arrive during filesystem setup, before the final race attaches.
    void aborted.catch(() => {});
    const timer = setTimeout(
      () => controller.abort(new Error("artifact thumbnail render timed out")),
      opts.timeoutMs ?? 30_000,
    );
    try {
      // Imported JSON is embedded by the binary build. Docker reads this on the CLIENT, so
      // unlike a bind-mounted Unix socket this works with Docker Desktop and remote daemons.
      directory = await mkdtemp(join(tmpdir(), "ryph-thumbnail-"));
      const profile = join(directory, "seccomp.json");
      await writeFile(profile, JSON.stringify(seccomp), { mode: 0o600 });
      signal.throwIfAborted();
      child = await command(docker, {
        args: [
          "run",
          "--pull",
          "never",
          "--rm",
          "-i",
          "--name",
          name,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--security-opt",
          `seccomp=${profile}`,
          "--user",
          "1994:1994",
          "--memory",
          "512m",
          "--memory-swap",
          "512m",
          "--cpus",
          "1",
          "--pids-limit",
          "128",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,nodev,size=256m,uid=1994,gid=1994,mode=1770",
          "--shm-size",
          "128m",
          "--env",
          "HOME=/tmp",
          "--env",
          "RYPH_THUMBNAIL_SANDBOX=required",
          // Docker's client config automatically injects proxy env (potentially with auth).
          // Explicit empty values override that without discarding registry credentials used
          // by the host-side CLI. No proxy credential belongs in the offline container.
          ...["HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY", "NO_PROXY"]
            .flatMap((name) => ["--env", `${name}=`, "--env", `${name.toLowerCase()}=`]),
          ...(opts.runtime ? ["--runtime", opts.runtime] : []),
          "--entrypoint",
          "bun",
          opts.image,
          "--no-env-file",
          "src/thumbnail_cli.ts",
        ],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      signal.throwIfAborted();
      const running = child;
      const work = Promise.all([
        bytes(running.stdout, MAX_PNG),
        bytes(running.stderr, 64 * 1024),
        running.status,
        (async () => {
          const writer = running.stdin.getWriter();
          try {
            await writer.write(input);
            await writer.close();
          } finally {
            writer.releaseLock();
          }
        })(),
      ]).then(([png, _stderr, status]) => {
        if (!status.success) {
          // An image can be pruned after warming. Reinspect on the next request, pulling only
          // when absent and outside render deadlines. No-prefetch smoke tests never pull.
          if (opts.prefetch !== false) ready = false;
          // Do not log renderer stderr: it can contain arbitrary document text.
          const message =
            `artifact thumbnail container exited ${status.code}; Chromium sandbox is required ` +
            "(check image availability, Docker runtime, kernel unprivileged user namespaces " +
            "and AppArmor policy; never disable the sandbox to fix this)";
          warn(message);
          throw new Error(message);
        }
        if (
          png.length < 8 ||
          ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => png[i] === v)
        ) {
          throw new Error("artifact thumbnail renderer did not return a PNG");
        }
        return png;
      });
      const result = await Promise.race([work, aborted]);
      completed = true;
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      // Killing docker's attach client does NOT stop its container. Explicitly remove it by
      // unique name as well, on success, error, cancellation, deadline and host shutdown.
      kill(child);
      await remove(name, !completed);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  return {
    render(html, signal) {
      if (closed) {
        return Promise.reject(
          new Error("artifact thumbnail renderer is shut down"),
        );
      }
      if (signal?.aborted) return Promise.reject(signal.reason);
      warm();
      if (!ready) {
        return Promise.reject(
          new Error("artifact thumbnail image is warming; retry shortly"),
        );
      }
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      const task = run(html, controller).finally(() => {
        signal?.removeEventListener("abort", abort);
        active.delete(controller);
      });
      active.set(controller, task);
      return task;
    },
    async shutdown() {
      closed = true;
      kill(pullChild);
      for (const controller of active.keys()) {
        controller.abort(new Error("host shutting down"));
      }
      await Promise.allSettled([...active.values(), ...(pull ? [pull] : [])]);
    },
  };
}
