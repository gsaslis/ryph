# The previews image — @ryph/previews as its own process for the networked deployment: the hosted
# end of `ryph__expose_port`. A browser opens a dev server an
# agent runs at `https://<id>.<RYPH_PREVIEWS_DOMAIN>`, and every request rides a WebSocket tunnel
# the run's runner dialled OUT to this process — a run pod takes no ingress, so the tunnel is the
# only way in.
#
# A listener per audience. :7490 is public (the Gateway, preview hostnames only); :7491 is the
# runners' (`/tunnel/<ticket>`); :7493 is the control plane's (`/internal/*`); with several
# replicas :7492 is the other previews pods'. None but :7490 is ever routed by the Gateway. ONE
# credential meets it, RYPH_PREVIEWS_TOKEN: the control plane's bearer on `/internal/*`, and the
# HMAC key for preview ids and viewer cookies. No database, no disk: its state is the open
# tunnels, in memory, so each run's previews live on one pod and a restart means its runners
# reconnect.
#
# With one replica it never dials anything. Every connection it holds was opened TO it — the
# browser's, the control plane's, the runner's tunnel — so its NetworkPolicy denies all egress;
# with several it dials its peers alone.
#
# The Bun version mirrors the mise.toml pin; bump both together.
# Built from the workspace root (the lockfile lives there):
#   docker build -f images/previews/Dockerfile -t ryph-previews .

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

RUN useradd --create-home previews
WORKDIR /app

# Everything under /app stays root-owned (installed and copied as root, before USER below): the
# service reads its code and dependencies and can never rewrite either.
COPY package.json bun.lock bunfig.toml ./
COPY --parents packages/*/package.json ./
RUN bun install --frozen-lockfile --production --filter @ryph/previews

# The workspace members previews imports, and no others: the logger, the service scaffolding, the
# timing-safe compare from sealed, and the tunnel protocol the runner speaks at the other end. No
# store, no auth, no schema. Everything it imports is installed at BUILD, so the container reaches
# no registry at boot — which it could not anyway, with no egress. Every member's manifest first,
# because bun wants each workspace a package names on disk, test-only ones included; then the
# production dependencies of this service and the members it imports, from the lockfile, and nothing
# else.
COPY packages/logger/src/ packages/logger/src/
COPY packages/service/src/ packages/service/src/
COPY packages/sealed/src/ packages/sealed/src/
COPY packages/shared/src/ packages/shared/src/
COPY packages/tunnel/src/ packages/tunnel/src/
COPY packages/previews/src/ packages/previews/src/

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

USER previews
WORKDIR /app/packages/previews
COPY --chmod=0755 images/previews/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
