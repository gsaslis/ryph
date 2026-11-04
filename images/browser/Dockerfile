# The browser image — @ryph/browser, the sidecar a browser-enabled run gets beside its agent: one
# Bun process serving the run's Chromium over MCP on :7490 and streaming it live. It is not a
# service: the orchestrator launches it per run, as a native sidecar on Kubernetes and as a
# container in the agent's network namespace under docker, and finds it by the reference
# RYPH_BROWSER_IMAGE carries.
#
# It holds no credential at rest and reads no environment it needs to be secret: the runner hands
# it a bearer and the egress proxy's per-run credentials on POST /configure, once.
#
# Chromium is the HEADLESS SHELL only — no full Chrome, no Firefox, no WebKit, no ffmpeg — at the
# revision the pinned playwright-core expects, downloaded by playwright-core's own installer from
# node_modules, so the browser and the driver cannot drift. Its system libraries are the
# `chromium` list of Playwright's nativeDeps for debian13 (lib/coreBundle.js, `debian13-x64`),
# installed by hand rather than with `--with-deps`, which would add Playwright's "tools" too:
# Xvfb and five CJK/Thai/Unicode font families a headless shell does not need. Two font families
# stay: Liberation (metric-compatible with Arial, Times and Courier, so layouts measure as they
# would on a laptop) and Noto Color Emoji.
#
# One more cut, the largest: the headless shell LINKS libgbm.so.1, and debian13's libgbm1 drags in
# Mesa's gallium driver, LLVM 19 and Z3 (~180 MB) — but libgbm only loads that driver when a GBM
# device is opened on a GPU node (/dev/dri), which a pod never has; the headless shell renders in
# software (SwiftShader, bundled with it). So they are purged after the install, and Chromium
# launches, renders and screenshots the same. Measured with `docker images`: 562 MB on arm64,
# 543 MB on amd64 (the README quotes the same numbers).
#
# ffmpeg, which Playwright's installer fetches beside any Chromium, is only for video recording,
# which nothing here does; it is deleted too.
#
# Runs as uid 1994, the run uid, with no root at runtime. The Bun version mirrors the mise.toml
# pin and the other images (bump them together). Built from the workspace root:
#   docker build -f images/browser/Dockerfile -t ryph-browser .

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
    libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 \
    libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    fonts-liberation fonts-noto-color-emoji \
  && dpkg --purge --force-depends mesa-libgallium libllvm19 libz3-4 \
  && rm -rf /var/lib/apt/lists/*

# The browser goes outside HOME so a run's pod can mount an emptyDir over HOME without hiding it.
RUN groupadd --gid 1994 browser \
  && useradd --uid 1994 --gid 1994 --create-home browser \
  && mkdir -p /opt/ms-playwright \
  && install -d -o 1994 -g 1994 -m 0750 /run/ryph-thumbnails
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
WORKDIR /app

# Code, dependencies and the browser stay root-owned (installed and copied as root, before USER
# below): uid 1994 runs them and cannot rewrite them.
#
# Every member's manifest first, since bun wants each workspace a package names on disk (test-only
# ones included); then the production dependencies of this service and the members it imports,
# from the lockfile, and nothing else.
COPY package.json bun.lock bunfig.toml ./
COPY --parents packages/*/package.json ./
# Nothing is fetched from a registry at boot, and playwright-core's own CLI — the exact version
# just installed — downloads the headless shell.
RUN bun install --frozen-lockfile --production --filter @ryph/browser \
  && cd packages/browser \
  && bun node_modules/playwright-core/cli.js install chromium-headless-shell \
  && rm -rf /opt/ms-playwright/ffmpeg-* /tmp/*

# The workspace members the sidecar imports: the logger, the service scaffolding and the token
# helpers, nothing else.
COPY packages/logger/src/ packages/logger/src/
COPY packages/sealed/src/ packages/sealed/src/
COPY packages/shared/src/ packages/shared/src/
COPY packages/service/src/ packages/service/src/
COPY packages/browser/src/ packages/browser/src/

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

USER 1994
WORKDIR /app/packages/browser
COPY --chmod=0755 images/browser/entrypoint.sh /entrypoint.sh
# The same image can run the independent offline renderer instead of the sidecar:
# command: ["bun", "run", "src/thumbnail.ts"]. Deploy it in its own isolated network.
EXPOSE 7490 7491
ENTRYPOINT ["/entrypoint.sh"]
