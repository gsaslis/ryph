# The memory image — @ryph/memory as its own process for the networked deployment: the canon,
# the inbox and the signal log on its OWN database, its routes on their own socket. State is
# Postgres: point RYPH_MEMORY_DB at a postgres:// server, or at a pglite: data directory on a
# persistent volume. The schema is provisioned separately — the entrypoint does not apply it.
# Three credentials meet it: user bearers on the management surface, verified against the same
# JWKS the control plane uses (RYPH_AUTH_URL); the orchestrator's RYPH_MEMORY_TOKEN on the
# internal surface (briefs and outcomes); the gateway's RYPH_MEMORY_GATEWAY_TOKEN on the MCP
# data route agent runs reach through the gateway.
#
# EMBEDDINGS. This image is where memory embeds in-process: the ONNX runtime and bge-small-en-v1.5's
# int8 weights are fetched at BUILD, into the image, so the service never reaches out for them at
# runtime and RYPH_MEMORY_EMBEDDINGS=local works
# offline, and the weights are checked against recorded digests (packages/memory/scripts/
# fetch_model.ts) so a moved branch or a swapped CDN object fails the build.
#
# THIS IS THE EXPENSIVE LAYER, and not by a little: the weights are ~34 MB but the runtime that
# reads them is not. onnxruntime-node ships prebuilt native libraries for every platform it
# supports (~200 MB on its own) and sharp comes along with it, so the node_modules tree this
# step writes is measured in hundreds of megabytes. Resident memory is the smaller number,
# ~270 MB; request it in the deployment. Do not quote a size here without measuring it.
#
# The Bun version mirrors the mise.toml pin; bump both together.
# Built from the workspace root (the lockfile lives there):
#   docker build -f images/memory/Dockerfile -t ryph-memory .

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

RUN useradd --create-home memory
WORKDIR /app

# Everything under /app stays root-owned (installed and copied as root, before USER below): the
# service reads its code and dependencies and can never rewrite either.
#
# Every member's manifest first, since bun wants each workspace a package names on disk (test-only
# ones included); then the production dependencies of this service and the members it imports,
# from the lockfile, and nothing else.
COPY package.json bun.lock bunfig.toml ./
COPY --parents packages/*/package.json ./
RUN bun install --frozen-lockfile --production --filter @ryph/memory

# The workspace members memory imports, directly or transitively (auth is a leaf; web is the URL
# ingest's address rule and its HTML conversion worker).
COPY packages/logger/src/ packages/logger/src/
COPY packages/service/src/ packages/service/src/
COPY packages/db/src/ packages/db/src/
COPY packages/sealed/src/ packages/sealed/src/
COPY packages/shared/src/ packages/shared/src/
COPY packages/auth/src/ packages/auth/src/
COPY packages/web/src/ packages/web/src/
COPY packages/memory/src/ packages/memory/src/
COPY packages/memory/scripts/ packages/memory/scripts/
COPY packages/memory/drizzle.config.ts packages/memory/
COPY packages/memory/drizzle/ packages/memory/drizzle/

# The embeddings runtime and the model weights, baked in. The runtime is loaded dynamically by
# src/adapters/embed/local.ts at its pinned TRANSFORMERS_VERSION (3.8.1); it is deliberately in no
# workspace package.json, so it is installed as a project of its own under /opt/embeddings (bun
# refuses to add a package inside a workspace whose other members are not on disk) and linked in
# where memory's bare import finds it. Its own lockfile (images/memory/embeddings) pins every
# transitive version; bump it with `bun install` there. The script warms it up once and checks the
# weights against their recorded digests, so a broken fetch fails the build.
COPY images/memory/embeddings/package.json images/memory/embeddings/bun.lock /opt/embeddings/
RUN cd /opt/embeddings \
  && bun install --frozen-lockfile --production \
  && mkdir -p /app/packages/memory/node_modules/@huggingface \
  && ln -s /opt/embeddings/node_modules/@huggingface/transformers \
    /app/packages/memory/node_modules/@huggingface/transformers
WORKDIR /app/packages/memory
RUN bun --no-env-file scripts/fetch_model.ts /app/models
ENV RYPH_MEMORY_MODEL_DIR=/app/models

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

USER memory
WORKDIR /app/packages/memory
COPY --chmod=0755 images/memory/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
