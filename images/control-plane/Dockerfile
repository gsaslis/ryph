# The control-plane image — @ryph/orchestrator with @ryph/auth mounted, and nothing else. The
# control plane owns run state, agents, policy, and the user surface's identity; the transcript
# firehose, the model data plane, and git transfers each ship as their own image.
#
# This replaces the old images/host/, which packaged the WHOLE single-process composition —
# orchestrator, auth, model proxy, and historian in one container on one database. That shape had
# no honest N: every replica ran its own reaper, its own historian listener map, and its own
# proxy. The single-process deployment is now the `ryph` binary (packages/ryph), which is
# where one-of-everything belongs; this image is one of six, and is meant to scale past one.
#
# State is Postgres only — point RYPH_DB at a postgres:// server. A pglite: data directory
# would work and is deliberately not the shape here: it is a file on a volume, so it caps this
# image at one replica, which is the thing the split exists to undo.
#
# The schema is provisioned separately, as a one-shot job before the replicas roll — N replicas
# migrating at boot race each other. drizzle-kit is one of the orchestrator's dependencies, so the
# job runs in this image; the service probes its database at boot and exits naming the fix if the
# schema is absent.
#
# The image carries no docker CLI and never mounts the docker socket, which is root on the
# machine and must not sit beside the OAuth master key. RYPH_PROVISIONER=kubernetes speaks
# to its platform's API over the network; =docker speaks to the docker launcher
# (RYPH_LAUNCHER_URL, images/launcher), the one container that holds the socket, and refuses to
# boot without one. The artifact sanitizer's process per publish is
# started by a supervisor in a container of its own, as its own uid, holding no secret, and runs
# under Node 26's permission model (sanitizer.sh).
#
# The Bun version mirrors the mise.toml pin, and the Node major the sanitizer runs on mirrors its
# node pin; bump them together.
# Built from the workspace root (the lockfile lives there):
#   docker build -f images/control-plane/Dockerfile -t ryph-control-plane .

# Node, for the artifact sanitizer alone: `node --permission` is what confines the process that
# parses untrusted HTML (packages/orchestrator/docs/artifacts.md). 25 is the first with every
# scope it denies; this is the official image's binary, pinned by digest, copied on its own.
FROM node:26-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS node

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

# Two users: `control` runs the control plane, `sanitizer` (1995, the uid the Kubernetes sidecar
# runs as too) runs the artifact sanitizer supervisor in a container of its own (sanitizer.sh), so
# a sanitizer process can never signal the control plane. The control user is in the sanitizer
# group, which is what lets it open the supervisor's socket; nothing else is.
RUN groupadd --gid 1995 sanitizer \
  && useradd --uid 1995 --gid 1995 --no-create-home --home-dir /opt/ryph-sanitizer \
    --shell /usr/sbin/nologin sanitizer \
  && useradd --create-home --groups sanitizer control
WORKDIR /app

# Root-owned, read-only to the control user, and named outright: the sanitizer runs under THIS
# node or not at all, so a node the control plane could replace, or a missing one, can never
# leave it running unconfined (it refuses every publish instead).
# It links libatomic, which the bun base does not carry.
COPY --from=node /usr/local/bin/node /opt/node/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 \
  && rm -rf /var/lib/apt/lists/* \
  && /opt/node/bin/node --version
ENV RYPH_ARTIFACT_SANITIZER_NODE=/opt/node/bin/node

# Everything under /app stays root-owned (installed and copied as root, before USER below): the
# service reads and runs its own code and its dependencies but can never rewrite either, so a
# write bug cannot turn hostile input into code that executes on the next boot. This process holds
# the control plane's database credentials and the OAuth master key, so it gets the forge image's
# boundary. The same holds for what the sanitizer loads — its three modules and parse5 with
# entities, which `node --permission` lets it read and nothing else: the control plane, running as
# a uid that may write wherever it can, cannot rewrite them before a start.
#
# Every member's manifest first, since bun wants each workspace a package names on disk (test-only
# ones included); then the production dependencies of the orchestrator and the members it
# imports, from the lockfile, and nothing else.
COPY package.json bun.lock bunfig.toml ./
COPY --parents packages/*/package.json ./
RUN bun install --frozen-lockfile --production --filter @ryph/orchestrator

# Every workspace member the control plane imports, directly or transitively.
COPY packages/logger/src/ packages/logger/src/
COPY packages/service/src/ packages/service/src/
COPY packages/process/src/ packages/process/src/
COPY packages/db/src/ packages/db/src/
COPY packages/sealed/src/ packages/sealed/src/
COPY packages/shared/src/ packages/shared/src/
COPY packages/auth/src/ packages/auth/src/
# The orchestrator reads @ryph/model-proxy for the provider registry and the ModelAccess
# shapes (the sealed-secret format is @ryph/sealed's, above). It does NOT run the proxy: that
# is its own image, and this process never holds RYPH_SECRETS_KEY.
COPY packages/model-proxy/src/ packages/model-proxy/src/
# Likewise @ryph/mcp-gateway — but only its LEAF: the control plane imports the tool allowlist
# grammar from `@ryph/mcp-gateway/tool-scope`, never the barrel, so the gateway's data plane,
# store and db factory stay out of this process. The whole src/ still lands; nothing here runs
# it, and this process never holds RYPH_MCP_KEY.
COPY packages/mcp-gateway/src/ packages/mcp-gateway/src/
# And @ryph/forge, for its LEAF alone: `@ryph/forge/patch-store`, the object store environment
# build logs are filed in beside the patches. The forge's service, its git cache and its
# credentials stay in the forge image; this process only ever puts and gets a log.
COPY packages/forge/src/ packages/forge/src/
COPY packages/orchestrator/src/ packages/orchestrator/src/
# The service catalogue: which database images this deployment will run beside a run, and the
# capability set each one's entrypoint actually needs. Read at boot through import.meta.url,
# and ONLY when RYPH_SERVICES is on — but copied unconditionally, because an image that can
# be switched on and then fails to boot is worse than a few kilobytes of JSON.
COPY packages/orchestrator/catalogue/ packages/orchestrator/catalogue/
# The ryph skills catalogue: what every run is told about .ryph/ and its formats. Read at every
# boot through import.meta.url, so an image without it does not start.
COPY packages/orchestrator/skills/ packages/orchestrator/skills/
COPY packages/orchestrator/drizzle.config.ts packages/orchestrator/
COPY packages/orchestrator/drizzle/ packages/orchestrator/drizzle/

# The supervisor's HOME: root-owned and empty, so nothing it finds there (an ~/.npmrc, say) was
# written by anyone but the image. Bun (1.4.2 and 1.4.4) reads bunfig.toml only from the working
# directory, which is root-owned here, not from HOME.
RUN install -d -m 0555 /opt/ryph-sanitizer
# Where the supervisor's socket lives: the volume both containers mount. Compose seeds a fresh
# named volume from this directory, ownership and mode included; Kubernetes mounts an emptyDir.
RUN install -d -o sanitizer -g sanitizer -m 0750 /run/ryph-sanitizer
ENV RYPH_ARTIFACT_SANITIZER_SOCKET=/run/ryph-sanitizer/s/supervisor.sock
# A sanitizer that cannot be confined refuses every publish rather than running unconfined.
ENV RYPH_ARTIFACT_SANITIZER_CONFINED=required

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

USER control
WORKDIR /app/packages/orchestrator

EXPOSE 7411
# Root-owned and world-executable: the control user runs it but cannot rewrite it. The sanitizer
# container runs the same image with /sanitizer.sh as its entrypoint, as the sanitizer user.
COPY --chmod=0755 images/control-plane/entrypoint.sh /entrypoint.sh
COPY --chmod=0755 images/control-plane/sanitizer.sh /sanitizer.sh
ENTRYPOINT ["/entrypoint.sh"]
