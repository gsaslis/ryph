# The historian image — @ryph/historian as its own process for the networked deployment: its
# append-only transcript store on its OWN database, its routes on their own socket. State is
# Postgres: point RYPH_HISTORY_DB at a postgres:// server, or at a pglite: data directory on a
# persistent volume. The schema is provisioned separately — the entrypoint no longer applies it.
# It reads run tokens off the wire but owns no run rows — it verifies them against the
# orchestrator (RYPH_ORCHESTRATOR_URL)
# and reads are gated against the same JWKS the control plane uses (RYPH_AUTH_URL); both, plus the
# conclude signal, share RYPH_HISTORY_TOKEN.
#
# The Bun version mirrors the mise.toml pin; bump both together.
# Built from the workspace root (the lockfile lives there):
#   docker build -f images/historian/Dockerfile -t ryph-historian .

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

RUN useradd --create-home historian
WORKDIR /app

# Everything under /app stays root-owned (installed and copied as root, before USER below): the
# service reads its code and dependencies and can never rewrite either.
#
# Every member's manifest first, since bun wants each workspace a package names on disk (test-only
# ones included); then the production dependencies of this service and the members it imports,
# from the lockfile, and nothing else.
COPY package.json bun.lock bunfig.toml ./
COPY --parents packages/*/package.json ./
RUN bun install --frozen-lockfile --production --filter @ryph/historian

# The workspace members the historian imports, directly or transitively (auth is a leaf).
COPY packages/logger/src/ packages/logger/src/
COPY packages/service/src/ packages/service/src/
COPY packages/db/src/ packages/db/src/
COPY packages/sealed/src/ packages/sealed/src/
COPY packages/shared/src/ packages/shared/src/
COPY packages/auth/src/ packages/auth/src/
COPY packages/historian/src/ packages/historian/src/
COPY packages/historian/drizzle.config.ts packages/historian/
COPY packages/historian/drizzle/ packages/historian/drizzle/

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

USER historian
WORKDIR /app/packages/historian
COPY --chmod=0755 images/historian/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
