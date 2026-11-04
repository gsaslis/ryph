# The web image — @ryph/web as its own process for the networked deployment: the platform's
# `web__search` and `web__fetch`, on their own socket. It is the only ryph service with NO state
# at all — no database, no schema, no migration job, nothing on disk — so it scales, restarts and
# redeploys freely.
#
# ONE credential meets it: the gateway's RYPH_WEB_GATEWAY_TOKEN on the MCP data route agent runs
# reach through the gateway. There is no user surface. A search key (RYPH_WEB_SEARCH_KEY) is
# spent on the provider and never leaves this process; without one the service still serves
# `web__fetch` and says at boot that it offers no search.
#
# The second service that dials the public internet by design (chat is the other), and the only
# one that dials an address an AGENT chose — which is why src/core/addresses.ts refuses every
# non-public address on every redirect hop, and why this pod's NetworkPolicy excepts every
# private range from its egress (deploy/helm/ryph/templates/networkpolicies.yaml). Both layers, because a
# name can answer differently between the check and the connection.
#
# The three npm libraries the conversion needs (linkedom, @mozilla/readability, turndown) are
# plain JavaScript — no native addon, nothing fetched at runtime — and are cached into the image
# at build. The conversion itself runs in a WORKER (src/adapters/convert/convert_worker.ts), so
# that a page which takes too long can be terminated rather than blocking the service; the whole
# of src/ is copied below, which is what puts that module in the image. (The single binary has to
# say so explicitly instead — see packages/ryph/scripts/compile.ts.)
#
# The Bun version mirrors the mise.toml pin; bump both together.
# Built from the workspace root (the lockfile lives there):
#   docker build -f images/web/Dockerfile -t ryph-web .

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

RUN useradd --create-home web
WORKDIR /app

# Everything under /app stays root-owned (installed and copied as root, before USER below): the
# service reads its code and dependencies and can never rewrite either.
#
# Every member's manifest first, since bun wants each workspace a package names on disk (test-only
# ones included); then the production dependencies of this service and the members it imports,
# from the lockfile, and nothing else.
COPY package.json bun.lock bunfig.toml ./
COPY --parents packages/*/package.json ./
RUN bun install --frozen-lockfile --production --filter @ryph/web

# The workspace members web imports. A short list on purpose: this service has no store, no auth
# surface and no schema, so it reaches @ryph/logger, @ryph/service and @ryph/sealed and stops.
# Their manifests first, then only their production dependencies from the lockfile, laid out into
# node_modules at BUILD, so the container fetches nothing from a registry at boot.
COPY packages/logger/src/ packages/logger/src/
COPY packages/service/src/ packages/service/src/
COPY packages/sealed/src/ packages/sealed/src/
COPY packages/shared/src/ packages/shared/src/
COPY packages/web/src/ packages/web/src/

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

USER web
WORKDIR /app/packages/web
COPY --chmod=0755 images/web/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
