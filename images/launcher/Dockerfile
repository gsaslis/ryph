# The docker launcher — @ryph/launcher, the one process of a compose deployment that runs the
# docker CLI. It is the only container that mounts the docker
# socket, which is root on the machine, and it holds no platform secret: no master key, no
# database, no provider key. The control plane (runs, checks, environment builds, image prefetch),
# the MCP gateway (hosted servers) and the `ryph` binary in deploy/compose reach it over HTTP with
# a service token each.
#
# What it runs is the docker adapters whole, so its image carries what they shell out to: the
# docker CLI and its buildx plugin (copied from the official image, the same pin as images/ryph
# had), and for the environment builder, which clones on this side and hands buildx local
# contexts, an OCI layout and a local cache: git, bash and tar.
#
# Not root. The socket is root:docker (root:root on Docker Desktop), mode 660, and membership of
# its group is what lets this process use it: compose adds that group with `group_add`
# (DOCKER_GID). Holding the socket is root-equivalent whatever uid holds it, so the point of the
# non-root user is narrower: nothing else in the container runs as root, and the code it runs is
# not its own to rewrite.
#
# The Bun version mirrors the mise.toml pin; bump it with the other images. Built from the
# workspace root (the lockfile lives there):
#   docker build -f images/launcher/Dockerfile -t ryph-launcher .

FROM docker:29.4.0-cli@sha256:2efe7c8e806b35050def6ba1ba0ddad67b521a0a6d37f4910b3d88f11b495d03 AS docker

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

# git, bash and tar for the environment builder's clone and its layouts; ca-certificates for a
# clone over https (a git gateway behind TLS).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git bash tar ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
RUN docker --version && docker buildx version && git --version

WORKDIR /app
# Everything under /app stays root-owned (installed and copied as root, before USER below), as in
# every service image: the launcher reads and runs its own code but can never rewrite it.
#
# Every member's manifest first, since bun wants each workspace a package names on disk; then the
# production dependencies of the launcher and the members it imports, from the lockfile.
COPY package.json bun.lock bunfig.toml ./
COPY --parents packages/*/package.json ./
RUN bun install --frozen-lockfile --production --filter @ryph/launcher

# Every workspace member the launcher imports, directly or transitively. From the orchestrator and
# the gateway it imports only their docker leaves (@ryph/orchestrator/docker,
# @ryph/mcp-gateway/tool-host): no store, no routes, no schema runs here. Their whole src/ still
# lands, as in the control-plane image.
COPY packages/logger/src/ packages/logger/src/
COPY packages/service/src/ packages/service/src/
COPY packages/process/src/ packages/process/src/
COPY packages/sealed/src/ packages/sealed/src/
COPY packages/shared/src/ packages/shared/src/
COPY packages/orchestrator/src/ packages/orchestrator/src/
COPY packages/mcp-gateway/src/ packages/mcp-gateway/src/
COPY packages/launcher/src/ packages/launcher/src/

# uid 1996, its own, and four directories it owns, each a volume in compose (a fresh named volume
# is seeded from the image's directory, ownership included):
# - HOME, where the docker CLI keeps buildx's builder state (~/.docker)
# - the environment builder's layer cache (RYPH_ENV_CACHE_DIR) and a build's temp files: the
#   clones, the generated Dockerfiles, the OCI layouts (RYPH_ENV_TEMP_DIR)
# - /run/ryph-launcher, where deploy/compose has it mint its two tokens into a volume its caller
#   mounts read-only
RUN groupadd --gid 1996 launcher \
  && useradd --uid 1996 --gid 1996 --no-create-home --home-dir /var/lib/ryph-launcher \
    --shell /usr/sbin/nologin launcher \
  && install -d -o launcher -g launcher -m 0700 /var/lib/ryph-launcher \
    /var/cache/ryph-launcher /var/tmp/ryph-launcher \
  && install -d -o launcher -g launcher -m 0755 /run/ryph-launcher
ENV RYPH_ENV_CACHE_DIR=/var/cache/ryph-launcher RYPH_ENV_TEMP_DIR=/var/tmp/ryph-launcher

# Nothing the service user can rewrite, and the build fails on anything left world-writable
# (sticky directories such as /tmp aside).
RUN chmod -R go-w /app /usr/local /root \
  && bad=$(find / -xdev -perm -0002 ! -type l ! \( -type d -perm -1000 \)) \
  && if [ -n "$bad" ]; then echo "world-writable: $bad" >&2; exit 1; fi

# PATH without the base image's /usr/local/bun-node-fallback-bin, as in the control-plane image.
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ENV HOME=/var/lib/ryph-launcher
USER launcher
WORKDIR /app/packages/launcher
EXPOSE 7470
# --no-env-file: the configuration is the container's environment and nothing in a directory.
ENTRYPOINT ["bun", "--no-env-file", "src/main.ts"]
