# The forge image — the service holding the git boundary: the read-only git gateway agents clone
# from (doors ① and ②) and, when GitHub App or GitLab credentials are configured, door ③'s API
# surface. It keeps the GitHub private key, the GitLab token and upstream tokens out of every other
# process by design. State lives under RYPH_FORGE_DATA: point it at a persistent volume — cache/ is
# disposable, but patches/ is the service's real output and must survive restarts.
#
# Configure via RYPH_FORGE_PORT (default 7412), RYPH_ORCHESTRATOR_URL, RYPH_FORGE_TOKEN
# (both required), and optionally the RYPH_GITHUB_* app credentials and the RYPH_GITLAB_* bot
# settings — see src/main.ts for the full contract.
#
# The Bun version mirrors the mise.toml pin; bump both together.
# Built from the workspace root (the lockfile lives there):
#   docker build -f images/forge/Dockerfile -t ryph-forge .

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

# git backs the gateway: bare clones, upload-pack, bundle intake
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home forge

# The data root, pre-created and forge-owned. Docker seeds a fresh NAMED volume from whatever is
# already at the mount point, ownership included, so `-v forge-data:/data` lands writable; without
# this the volume arrives root-owned and the non-root runtime cannot mkdir cache/ inside it. A BIND
# mount keeps the host's ownership instead, so that case still needs a matching uid on the host.
RUN install -d -o forge -g forge /data
ENV RYPH_FORGE_DATA=/data
# A networked forge never runs a shell command for its GitHub or GitLab token
# (RYPH_GITHUB_TOKEN_COMMAND, RYPH_GITLAB_TOKEN_COMMAND): with this set it refuses to start when
# one is configured, as it did under Deno's --deny-run.
ENV RYPH_FORGE_NO_TOKEN_COMMAND=1

WORKDIR /app

# Source and dependencies stay root-owned (installed and copied as root, before USER below): the
# forge user can read and run them but never rewrite them, so a write bug cannot turn hostile input
# into code that executes on the next boot. Unlike under Deno, nothing in the runtime enforces a
# write scope a second way; the root-owned tree and the volume are the boundary
# (docs/runtime.md, What we lose).
#
# Every member's manifest first, since bun wants each workspace a package names on disk (test-only
# ones included); then the production dependencies of this service and the members it imports,
# from the lockfile, and nothing else.
COPY package.json bun.lock bunfig.toml ./
COPY --parents packages/*/package.json ./
RUN bun install --frozen-lockfile --production --filter @ryph/forge

# The workspace members the forge imports, directly or transitively (webhooks
# brings its migrations, which the one-shot migrate-webhooks job applies from this image).
COPY packages/logger/src/ packages/logger/src/
COPY packages/service/src/ packages/service/src/
COPY packages/process/src/ packages/process/src/
COPY packages/sealed/src/ packages/sealed/src/
COPY packages/shared/src/ packages/shared/src/
COPY packages/db/src/ packages/db/src/
COPY packages/webhooks/src/ packages/webhooks/src/
COPY packages/webhooks/drizzle.config.ts packages/webhooks/
COPY packages/webhooks/drizzle/ packages/webhooks/drizzle/
COPY packages/webhooks/scripts/ packages/webhooks/scripts/
COPY packages/forge/src/ packages/forge/src/

# Nothing the service user can rewrite. bun install leaves some files world-writable (bin targets
# such as esbuild, drizzle-kit's bin.cjs and node-which come out 0777), which a root-owned tree
# alone does not stop, so the tree is made go-w and the build fails on anything left writable by
# everyone (sticky directories such as /tmp aside).
RUN chmod -R go-w /app /opt /root \
  && bad=$(find / -xdev -perm -0002 ! -type l ! \( -type d -perm -1000 \)) \
  && if [ -n "$bad" ]; then echo "world-writable: $bad" >&2; exit 1; fi

# PATH without the base image's /usr/local/bun-node-fallback-bin, whose `node` is bun itself:
# whatever looks for node on PATH (the artifact sanitizer did) must not find a bun posing as one.
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER forge

# Root-owned and world-executable: the forge user runs it but cannot rewrite it.
COPY --chmod=0755 images/forge/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
