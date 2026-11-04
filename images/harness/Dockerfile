# The harness layer — ryph-harness — everything a run needs that is OURS, under /opt/ryph and
# nowhere else, so it can be layered last onto any environment:
#
#   /opt/ryph/
#     bin/tini          static init, pinned: forwards signals, reaps orphaned job descendants
#     bin/ryph-runner   the runner, `bun build --compile`d: no Bun install, no node_modules, no /app
#     bin/ryph-bake     the build-time setup baker, compiled on its own (packages/runner/src/bake.ts)
#     bin/pi            a wrapper: exec pi on the layer's own Node
#     node/             pi's own Node — never on the agent's PATH
#     lib/pi/           @earendil-works/pi-coding-agent, pinned with its whole tree (pi/package-lock.json)
#     lib/check-base.sh refuses a base the layer cannot run on
#     pi-mcp/           the ryph MCP and images extensions, at their fixed path
#     harness.json      what this layer carries: runner, pi, Node and tini versions, harness kinds,
#                       when it was built
#
# The final stage holds /opt/ryph and nothing else. It is not meant to be run; it is what
# `COPY --from=<this image> /opt/ryph /opt/ryph` reads, in images/agent/Dockerfile and in every
# environment build's last stage.
#
# Its runtimes never leak: /opt/ryph/bin is never put on PATH (the runner spawns pi by absolute
# path), so a repo's `node`, `bun` and `cargo` come from the environment, and a repo on Node 20
# and pi on Node 24 never meet. Everything here is root-owned and read-only to the run user — `-e`
# loads the MCP extension without a trust gate, which is exactly why its path is the layer's and
# never the workspace's.
#
# pi is pinned, and for a reason beyond reproducibility: the tool wiring depends on `-e <path>`
# being honoured alongside `--no-extensions` (verified by hand on this version). A pi that changed
# that would keep starting normally and run with no tools at all — the one failure in this path
# that would not be loud — so the version moves deliberately, with that behaviour re-checked.
# The Bun version mirrors the mise.toml pin; bump both together.
#
# Built from the workspace root (the lockfile lives there), for amd64:
#   docker build --platform linux/amd64 -f images/harness/Dockerfile \
#     --build-arg RYPH_VERSION=$(git rev-parse --short=12 HEAD) -t ryph-harness:dev .
# or with `bun run agent-image`, which builds it between the universal image and ryph-agent.

ARG NODE_VERSION=24.21.0

# ── tini, the run's PID 1 ─────────────────────────────────────────────────────────────────────
# The upstream static release, pinned by checksum: the harness tag hashes this file, so the
# version and both sums here are what decides whether the layer's init changed. To move the pin,
# change all three; the build's test-init.sh re-checks the new binary.
ARG TINI_VERSION=0.19.0
FROM scratch AS tini-amd64
ARG TINI_VERSION
ADD --checksum=sha256:c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee \
  https://github.com/krallin/tini/releases/download/v${TINI_VERSION}/tini-static-amd64 /tini
FROM scratch AS tini-arm64
ARG TINI_VERSION
ADD --checksum=sha256:eae1d3aa50c48fb23b8cbdf4e369d0910dfc538566bfd09df89a774aa84a48b9 \
  https://github.com/krallin/tini/releases/download/v${TINI_VERSION}/tini-static-arm64 /tini
FROM tini-${TARGETARCH} AS tini

# ── The runner and the baker, compiled ───────────────────────────────────────────────────────
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS compile
WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
# The manifests of the workspace members the runner imports, which are all bun needs on disk to
# install its production dependencies from the lockfile; absent members are skipped. Named one by
# one rather than by glob, so the paths this layer depends on can be read off this file.
COPY packages/logger/package.json packages/logger/
COPY packages/process/package.json packages/process/
COPY packages/service/package.json packages/service/
COPY packages/sealed/package.json packages/sealed/
COPY packages/shared/package.json packages/shared/
COPY packages/tunnel/package.json packages/tunnel/
COPY packages/runner/package.json packages/runner/
RUN bun install --frozen-lockfile --production --filter @ryph/runner
COPY packages/logger/src/ packages/logger/src/
COPY packages/process/src/ packages/process/src/
COPY packages/service/src/ packages/service/src/
COPY packages/sealed/src/ packages/sealed/src/
COPY packages/shared/src/ packages/shared/src/
COPY packages/tunnel/src/ packages/tunnel/src/
COPY packages/runner/src/ packages/runner/src/

# Each binary bundles only what its entry reaches, and the bun runtime for this platform, with
# the real `ws` bundled in and .env / bunfig autoload off (images/harness/compile.ts).
#
# Bun has no permission flags to bake in. Under Deno the runner could spawn only git, ssh-keygen,
# bash and pi; now it has every right of the run uid, which the agent beside it already has
# (docs/runtime.md, What we lose). The baker runs repo-authored shell by definition.
COPY images/harness/compile.ts /src/images/harness/compile.ts
WORKDIR /src/packages/runner
RUN bun --no-env-file /src/images/harness/compile.ts

# ── pi, on its own Node ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS assemble
ARG RYPH_VERSION=dev
ARG TINI_VERSION

# A run needs a real PID 1: the runner waits for its own children, but cannot reap orphaned
# grandchildren from repo commands. Keep init in the harness, not the repo's base, and use the
# static binary so it adds no libc requirement. Images start it as `tini -s --`: -s keeps it a
# subreaper when something else is PID 1. Signals go only to the runner (no -g): it owns
# graceful cancellation and must stop jobs before finalizing and shipping the checkout.
COPY --from=tini --chmod=0755 /tini /opt/ryph/bin/tini
RUN /opt/ryph/bin/tini --version

COPY images/harness/test-init.sh /tmp/test-init.sh
RUN bash /tmp/test-init.sh /opt/ryph/bin/tini && rm /tmp/test-init.sh

# The official Node build, which targets an old glibc on purpose — so it runs on any mainstream
# base the layer lands on. Only the binary: pi needs no npm at run time.
RUN mkdir -p /opt/ryph/node/bin /opt/ryph/lib/pi /opt/ryph/bin \
  && cp /usr/local/bin/node /opt/ryph/node/bin/node

# pi's version and every dependency under it come from images/harness/pi/package-lock.json: pi
# stopped publishing a shrinkwrap in 1.0.1, so a bare `npm install` would resolve its tree afresh
# on each build, under a harness tag that only hashes what is copied in. Bump pi with
# `npm install --package-lock-only` in that directory, on the Node above.
WORKDIR /opt/ryph/lib/pi
COPY images/harness/pi/package.json images/harness/pi/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# The runner reads pi's model catalogue to learn whether a run's model sees images, at one of
# these two paths (packages/runner/src/adapters/harness/pi_vision.ts `piCatalogueFiles`). A pi
# that moves it would leave every text-only model "seeing", so the build fails here instead.
RUN data=@earendil-works/pi-ai/dist/providers/data/anthropic.json \
  && { test -f "node_modules/@earendil-works/pi-coding-agent/node_modules/${data}" \
       || test -f "node_modules/${data}" \
       || { echo "pi's model catalogue is not where the runner reads it (pi_vision.ts piCatalogueFiles)" >&2; exit 1; }; }

# The ryph MCP extension, with its own npm dependencies beside it: pi loads extensions through
# jiti and resolves their imports from the nearest node_modules. The images extension (no
# dependencies) sits beside it; the runner finds it there.
COPY packages/pi-mcp/package.json packages/pi-mcp/package-lock.json packages/pi-mcp/index.ts packages/pi-mcp/images.ts /opt/ryph/pi-mcp/
RUN cd /opt/ryph/pi-mcp && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY --from=compile /opt/ryph/bin/ /opt/ryph/bin/
COPY images/harness/check-base.sh /opt/ryph/lib/check-base.sh

# The wrapper names pi's entry from its own package.json (read as a file: the package's exports
# map does not export it), so a pi that moves its bin still gets a
# wrapper pointing at it. bash, because bash is one of the three things the layer requires.
# harness.json keeps the contract's three keys (the runner reads harnessKinds) plus what else
# is useful to someone asking what a layer carries.
RUN pi_version="$(node -p 'require("./node_modules/@earendil-works/pi-coding-agent/package.json").version')" \
  && entry="$(node -p 'JSON.parse(require("fs").readFileSync("node_modules/@earendil-works/pi-coding-agent/package.json")).bin.pi')" \
  && printf '#!/bin/bash\nexec /opt/ryph/node/bin/node /opt/ryph/lib/pi/node_modules/@earendil-works/pi-coding-agent/%s "$@"\n' \
       "${entry#./}" > /opt/ryph/bin/pi \
  && chmod 0755 /opt/ryph/bin/pi /opt/ryph/lib/check-base.sh \
  && printf '{\n  "runner": "%s",\n  "harnessKinds": ["pi", "echo"],\n  "builtAt": "%s",\n  "pi": "%s",\n  "node": "%s",\n  "tini": "%s"\n}\n' \
       "${RYPH_VERSION}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${pi_version}" "$(/opt/ryph/node/bin/node --version)" \
       "${TINI_VERSION}" \
       > /opt/ryph/harness.json \
  && chown -R root:root /opt/ryph \
  && chmod -R go-w /opt/ryph \
  && /opt/ryph/bin/pi --version

# ── The layer ───────────────────────────────────────────────────────────────────────────────
FROM scratch
COPY --from=assemble /opt/ryph /opt/ryph
