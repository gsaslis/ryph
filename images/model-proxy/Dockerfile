# The model-proxy image — @ryph/model-proxy as its own process, serving BOTH of its listeners:
# the data plane agent containers dial as their "provider" (RYPH_MODEL_PROXY_PORT), and the
# control plane carrying provider-key CRUD and the internal credential surface the orchestrator
# reaches (RYPH_MODEL_PROXY_CONTROL_PORT).
#
# Publish them differently. The data plane must be reachable from the RUN network — the least
# trusted network in the deployment, since every agent container is on it. The control plane must
# not be: it manages the keys those containers are deliberately never given.
#
# This is the one process that holds RYPH_SECRETS_KEY, and after the master-key split it is the
# only one: the control plane seals its OAuth tokens under its own RYPH_OAUTH_KEY and cannot
# open a provider secret at all. State is Postgres — point RYPH_DB at the proxy's own database
# (`ryph_keys`), which nothing else connects to.
#
# The schema is provisioned separately, as a one-shot job before the replicas roll. drizzle-kit is
# one of the package's dependencies, so the job runs in this image
# (`bun --no-env-file node_modules/drizzle-kit/bin.cjs migrate`, the installed copy, never `bunx`,
# which downloads the latest release when it finds none); the service probes its database at boot
# and exits naming the fix if the schema is absent.
#
# The Bun version mirrors the mise.toml pin; bump both together.
# Built from the workspace root (the lockfile lives there):
#   docker build -f images/model-proxy/Dockerfile -t ryph-model-proxy .

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

# Not `proxy`: Debian ships that as a system user (uid 13), and useradd refuses the name.
RUN useradd --create-home modelproxy
WORKDIR /app

# Everything under /app stays root-owned (installed and copied as root, before USER below): the
# service reads and runs its own code and its dependencies but can never rewrite either, so a
# write bug cannot turn hostile input into code that executes on the next boot. This process
# unseals every provider key in the deployment, which makes it the surface most worth locking
# down.
#
# Every member's manifest first, since bun wants each workspace a package names on disk (test-only
# ones included); then the production dependencies of this service and the members it imports,
# from the lockfile, and nothing else.
COPY package.json bun.lock bunfig.toml ./
COPY --parents packages/*/package.json ./
RUN bun install --frozen-lockfile --production --filter @ryph/model-proxy

# The workspace members the proxy imports, directly or transitively (auth is a
# leaf: the JWKS verifier that gates key CRUD), then only their production dependencies from the
# lockfile. bun skips the workspace members whose manifests are not here.
COPY packages/logger/src/ packages/logger/src/
COPY packages/service/src/ packages/service/src/
COPY packages/db/src/ packages/db/src/
COPY packages/sealed/src/ packages/sealed/src/
COPY packages/shared/src/ packages/shared/src/
COPY packages/auth/src/ packages/auth/src/
COPY packages/model-proxy/src/ packages/model-proxy/src/
COPY packages/model-proxy/drizzle.config.ts packages/model-proxy/
COPY packages/model-proxy/drizzle/ packages/model-proxy/drizzle/
COPY packages/model-proxy/scripts/ packages/model-proxy/scripts/

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

USER modelproxy
WORKDIR /app/packages/model-proxy
EXPOSE 7420 7421
COPY --chmod=0755 images/model-proxy/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
