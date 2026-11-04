# The mcp-gateway image — @ryph/mcp-gateway as its own process, serving BOTH of its listeners:
# the data plane agent containers dial as "the MCP server" (RYPH_MCP_GATEWAY_PORT), and the
# control plane carrying MCP server CRUD, the probe, the usage trail, and the internal credential
# surface the orchestrator reaches (RYPH_MCP_GATEWAY_CONTROL_PORT).
#
# Publish them differently, exactly as the model-proxy's. The data plane must be reachable from
# the RUN network — the least trusted network in the deployment. The control plane must not be:
# it manages the credentials those containers are deliberately never given, and its internal
# surface mints the tokens that stand in for them.
#
# This is the one process that holds RYPH_MCP_KEY. It is a third master key beside the
# model-proxy's RYPH_SECRETS_KEY and the control plane's RYPH_OAUTH_KEY, one per secret class,
# so a compromise of one process opens one class. State is Postgres — point RYPH_DB at the
# gateway's own database (`ryph_mcp`), which nothing else connects to.
#
# The schema is provisioned separately, as a one-shot job before the replicas roll. drizzle-kit is
# installed below so the job can run in this image; the service probes its database at boot and
# exits naming the fix if the schema is absent.
#
# The Bun version mirrors the mise.toml pin; bump both together.
# Built from the workspace root (the lockfile lives there):
#   docker build -f images/mcp-gateway/Dockerfile -t ryph-mcp-gateway .

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

RUN useradd --create-home mcpgateway
WORKDIR /app

# Everything under /app stays root-owned (installed and copied as root, before USER below): the
# service reads and runs its own code and its dependencies but can never rewrite either, so a
# write bug cannot turn hostile input into code that executes on the next boot. This process
# unseals every MCP credential in the deployment and forwards to operator-named upstreams, which
# makes it a surface worth locking down twice.
#
# Every member's manifest first, since bun wants each workspace a package names on disk (test-only
# ones included); then the production dependencies of this service and the members it imports,
# from the lockfile, and nothing else.
COPY package.json bun.lock bunfig.toml ./
COPY --parents packages/*/package.json ./
RUN bun install --frozen-lockfile --production --filter @ryph/mcp-gateway

# The workspace members the gateway imports, directly or transitively (auth is a leaf: the JWKS
# verifier that gates server CRUD; process spawns the docker tool host's CLI).
COPY packages/logger/src/ packages/logger/src/
COPY packages/service/src/ packages/service/src/
COPY packages/db/src/ packages/db/src/
COPY packages/sealed/src/ packages/sealed/src/
COPY packages/shared/src/ packages/shared/src/
COPY packages/auth/src/ packages/auth/src/
COPY packages/process/src/ packages/process/src/
COPY packages/mcp-gateway/src/ packages/mcp-gateway/src/
# The hosted-server catalogue. Whether this gateway can RUN one depends on RYPH_TOOL_HOST: unset
# it hosts nothing and serves the catalogue with the reason, so the Add dialog still shows what
# exists and why it cannot run here; `=kubernetes` and it launches each entry as a Deployment in
# the tools namespace (see src/main.ts). Validated at boot either way: a bad entry fails it.
COPY packages/mcp-gateway/catalogue/ packages/mcp-gateway/catalogue/
COPY packages/mcp-gateway/drizzle.config.ts packages/mcp-gateway/
COPY packages/mcp-gateway/drizzle/ packages/mcp-gateway/drizzle/
COPY packages/mcp-gateway/scripts/ packages/mcp-gateway/scripts/

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

USER mcpgateway
WORKDIR /app/packages/mcp-gateway
EXPOSE 7430 7431
COPY --chmod=0755 images/mcp-gateway/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
