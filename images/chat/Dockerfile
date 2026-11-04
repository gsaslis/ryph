# The chat image — @ryph/chat as its own process for the networked deployment: chatrooms, the
# bindings from runs to rooms and the poller's cursors on its OWN database, its routes on their own
# socket. State is Postgres: point RYPH_CHAT_DB at a postgres:// server, or at a pglite: data
# directory on a persistent volume. The schema is provisioned separately — the entrypoint does not
# apply it. Three credentials meet it: user bearers on the management surface, verified against the
# same JWKS the control plane uses (RYPH_AUTH_URL); the orchestrator's RYPH_CHAT_TOKEN on the
# internal surface (bindings, commander checks, thread reads), which is also what this process
# presents back on the orchestrator's mention door (POST /v1/chat/mentions); the gateway's
# RYPH_CHAT_GATEWAY_TOKEN on the MCP data route agent runs reach through the gateway. Bot tokens and
# Zulip API keys seal under RYPH_CHAT_KEY, this process's own master key.
#
# The one service that dials the public internet by design: the Telegram Bot API and the Zulip
# organizations an admin named, long-polled.
#
# The Bun version mirrors the mise.toml pin; bump both together.
# Built from the workspace root (the lockfile lives there):
#   docker build -f images/chat/Dockerfile -t ryph-chat .

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

RUN useradd --create-home chat
WORKDIR /app

# Everything under /app stays root-owned (installed and copied as root, before USER below): the
# service reads its code and dependencies and can never rewrite either.
#
# Every member's manifest first, since bun wants each workspace a package names on disk (test-only
# ones included); then the production dependencies of this service and the members it imports,
# from the lockfile, and nothing else.
COPY package.json bun.lock bunfig.toml ./
COPY --parents packages/*/package.json ./
RUN bun install --frozen-lockfile --production --filter @ryph/chat

# The workspace members chat imports, directly or transitively (auth is a leaf).
COPY packages/logger/src/ packages/logger/src/
COPY packages/service/src/ packages/service/src/
COPY packages/db/src/ packages/db/src/
COPY packages/sealed/src/ packages/sealed/src/
COPY packages/shared/src/ packages/shared/src/
COPY packages/auth/src/ packages/auth/src/
COPY packages/chat/src/ packages/chat/src/
COPY packages/chat/scripts/ packages/chat/scripts/
COPY packages/chat/drizzle.config.ts packages/chat/
COPY packages/chat/drizzle/ packages/chat/drizzle/

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

USER chat
WORKDIR /app/packages/chat
COPY --chmod=0755 images/chat/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
