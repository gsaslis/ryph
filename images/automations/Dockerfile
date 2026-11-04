# The automations image — @ryph/automations as its own process for the networked deployment:
# user-created automations (webhook and cron triggers) on their OWN database, the mailroom
# mounted inside, fires delivered to the orchestrator's events door. State is Postgres: point
# RYPH_AUTOMATIONS_DB at a postgres:// server, or at a pglite: data directory on a persistent
# volume. The schema is provisioned separately by the one-shot migrate-automations job.
# CRUD is gated against the same JWKS the control plane serves (RYPH_AUTH_URL); fires present
# RYPH_AUTOMATIONS_TOKEN at the orchestrator (RYPH_ORCHESTRATOR_URL); a response's chatroom is
# looked up at the chat service (RYPH_CHAT_URL) with the caller's bearer.
#
# The Bun version mirrors the mise.toml pin; bump both together.
# Built from the workspace root (the lockfile lives there):
#   docker build -f images/automations/Dockerfile -t ryph-automations .

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

RUN useradd --create-home automations
WORKDIR /app

# Everything under /app stays root-owned (installed and copied as root, before USER below): the
# service reads its code and dependencies and can never rewrite either.
#
# Every member's manifest first, since bun wants each workspace a package names on disk (test-only
# ones included); then the production dependencies of this service and the members it imports,
# from the lockfile, and nothing else.
COPY package.json bun.lock bunfig.toml ./
COPY --parents packages/*/package.json ./
RUN bun install --frozen-lockfile --production --filter @ryph/automations

# The workspace members the automations service imports, directly or transitively.
COPY packages/logger/src/ packages/logger/src/
COPY packages/service/src/ packages/service/src/
COPY packages/db/src/ packages/db/src/
COPY packages/sealed/src/ packages/sealed/src/
COPY packages/shared/src/ packages/shared/src/
COPY packages/auth/src/ packages/auth/src/
COPY packages/webhooks/src/ packages/webhooks/src/
COPY packages/automations/src/ packages/automations/src/
COPY packages/automations/drizzle.config.ts packages/automations/
COPY packages/automations/drizzle/ packages/automations/drizzle/
COPY packages/automations/scripts/ packages/automations/scripts/

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

USER automations
WORKDIR /app/packages/automations
COPY --chmod=0755 images/automations/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
