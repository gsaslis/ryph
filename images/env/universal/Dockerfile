# The universal image — quay.io/ryph/ryph-universal — the environment of every repo that declares
# none, and the recommended `FROM` of every `.ryph/Dockerfile`. It aims at "the mainstream just
# works", not "everything installed": the build tools a crate or a native npm module links against,
# the everyday tools a repo's own hooks call, and one current version of each mainstream toolchain
# behind a version manager that installs whatever version a repo pins, on first use.
#
# It carries NO harness. The runner, pi and the runtimes they need live under /opt/ryph and are
# layered on last (images/harness, images/agent), so nothing here is ours to keep in step with a
# deployment, and a repo's `node` is never pi's `node`.
#
# Layers go from biggest and least volatile to smallest and most volatile — apt, then Rust, then
# the mise-managed runtimes — because every environment built `FROM` this image shares them, and a
# node pulls a shared layer once. The budget is 4 GB compressed, checked by the image's own CI job
# (.github/workflows/universal-image.yml); the size is a budget, not an accident.
#
# Pins are honoured without configuration, and that is what the version managers are for:
# `rustup` reads rust-toolchain.toml on the first `cargo` call, and mise's shims install what
# `.tool-versions`, `mise.toml`, `.nvmrc` or `.python-version` ask for on first use. Both install
# AT RUN TIME, as the run user, which is why every toolchain home is owned by uid 1994.
#
# Every version below is pinned; bump them deliberately, together with the tag the image
# publishes as (`1` moves only when a bump is compatible for the repos building FROM it).
#
#   docker build --platform linux/amd64 -f images/env/universal/Dockerfile -t ryph-universal:dev .
#
# Published for amd64 only: GKE is amd64, and a multi-arch universal image is a later, cheap step.
# The file itself builds for arm64 too, which is what `bun run agent-image` does on an Apple
# silicon laptop, so the local backends run it natively instead of under emulation.

FROM ubuntu:24.04

ARG MISE_VERSION=2026.9.11
ARG MISE_SHA256_AMD64=6e39ee1ffa926a1f64814efbf1d26c3f617255e2a6ba6152e3c8a5135fa5a35f
ARG MISE_SHA256_ARM64=80ad6e9589d3c4483fd67a4a97f07e28330964dde64ca8cad15d5cb56134a54d
ARG RUST_VERSION=1.98.1
ARG NODE_VERSION=24.21.0
ARG DENO_VERSION=2.9.7
ARG BUN_VERSION=1.4.4
ARG PYTHON_VERSION=3.12
ARG UV_VERSION=0.12.17
ARG GO_VERSION=1.27.1
ARG PNPM_VERSION=10.34.5
ARG YARN_VERSION=1.22.22

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# The run user — uid and gid 1994, the number every backend launches runs as (Kubernetes pins it
# with RYPH_K8S_RUN_USER; the harness layer's final `USER 1994:1994` pins it everywhere else).
# Ubuntu's own `ubuntu` user (1000) goes: nothing here runs as it, and a second home in the image
# is a second place an ancestor-walking harness could find a stray context file.
RUN userdel --remove ubuntu \
  && groupadd --gid 1994 runner \
  && useradd --uid 1994 --gid 1994 --create-home --home-dir /home/runner --shell /bin/bash runner

# git from the git-core PPA, not Ubuntu's: noble's 2.43 does not understand
# `git checkout --end-of-options <ref>`, which the runner uses on every clone (measured — every
# run failed in `cloning`). The PPA is the git maintainers' own Ubuntu build. Its key is fetched by
# full fingerprint, and apt checks every package against it.
ARG GIT_PPA_KEY=F911AB184317630C59970973E363C90F8F1B6217
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL -o /etc/apt/keyrings/git-core.asc \
       "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x${GIT_PPA_KEY}" \
  && echo "deb [signed-by=/etc/apt/keyrings/git-core.asc] https://ppa.launchpadcontent.net/git-core/ppa/ubuntu noble main" \
       > /etc/apt/sources.list.d/git-core.list \
  && rm -rf /var/lib/apt/lists/*

# Base and everyday tools. git and bash are two of the harness layer's three requirements (glibc
# is the third); the compilers, pkg-config and the -dev headers are what a vendored C dependency
# (libgit2, sqlite, openssl) needs to link. `fd` is Debian's `fdfind`, linked under the name
# everyone types.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       build-essential pkg-config cmake clang libclang-dev libssl-dev \
       git openssh-client curl ca-certificates unzip xz-utils zstd sqlite3 \
       ripgrep fd-find jq just shellcheck \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

# No container tooling ships here, on purpose: setup steps and the agent are repo- and
# model-authored shell, and a docker CLI on a host socket is root on the node. A repo that needs
# a database declares it in .ryph/services.yml, and the platform runs it beside the run.

# Rust, through rustup, so rust-toolchain.toml is honoured on the first cargo call. The homes sit
# outside $HOME (the layout the official rust images use) and belong to the run user, because a
# pinned toolchain installs there at run time.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --profile minimal \
        --default-toolchain "${RUST_VERSION}" --component clippy,rustfmt \
  && chown -R 1994:1994 "${RUSTUP_HOME}" "${CARGO_HOME}"

# mise, for everything else. Its data dir (installs and shims) belongs to the run user for the
# same reason as the Rust homes; its system config (/etc/mise/config.toml) names the preinstalled
# versions, so a repo that pins nothing gets exactly these.
ENV MISE_DATA_DIR=/usr/local/share/mise \
    MISE_CACHE_DIR=/usr/local/share/mise/cache \
    MISE_YES=1 \
    COREPACK_HOME=/usr/local/share/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) arch=x64; sum="${MISE_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum="${MISE_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSL -o /usr/local/bin/mise \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${arch}" \
  && echo "${sum}  /usr/local/bin/mise" | sha256sum -c - \
  && chmod 0755 /usr/local/bin/mise

# The settings are the point of this image, so each one says why:
# - not_found_auto_install: a shim for a version the repo pins but nobody installed installs it,
#   rather than failing — how `.nvmrc` works with zero config. On by default; stated so a future
#   mise default cannot turn it off silently.
# - idiomatic_version_file_enable_tools: `.nvmrc`, `.python-version`, `.go-version` and friends
#   are opt-in in current mise; these are the files repos actually carry.
# - trusted_config_paths: a repo's own mise.toml is untrusted by default and every shim would
#   refuse to run in its checkout. Trusting it adds nothing the run did not already have — the
#   run executes the repo's code and its setup.yml as this same user.
RUN mkdir -p /etc/mise && cat > /etc/mise/config.toml <<EOF
[tools]
node = "${NODE_VERSION}"
deno = "${DENO_VERSION}"
bun = "${BUN_VERSION}"
python = "${PYTHON_VERSION}"
uv = "${UV_VERSION}"
go = "${GO_VERSION}"

[settings]
not_found_auto_install = true
idiomatic_version_file_enable_tools = ["node", "python", "go", "deno", "bun"]
trusted_config_paths = ["/"]
EOF

# Installed as root, then handed over; corepack puts pnpm and yarn beside node, and a reshim
# makes shims for them. `corepack install -g` caches the two package managers in COREPACK_HOME so
# a repo on either does not download one on its first command.
RUN mise install \
  && mise exec -- corepack enable \
  && mise exec -- corepack install -g "pnpm@${PNPM_VERSION}" "yarn@${YARN_VERSION}" \
  && mise reshim \
  && rm -rf "${MISE_CACHE_DIR}" \
  && mkdir -p "${MISE_CACHE_DIR}" \
  && chown -R 1994:1994 "${MISE_DATA_DIR}" "${COREPACK_HOME}"

# Shims first: a pinned version wins over the preinstalled one, and the repo's `node` is always
# mise's. Cargo's bin dir next, then the system.
ENV PATH=/usr/local/share/mise/shims:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# The fixed checkout root an environment build bakes each repo into (/ryph/work/<path>), and the
# run adopts. Owned by the run user, like everything a run writes.
RUN mkdir -p /ryph/work && chown -R 1994:1994 /ryph

USER runner
WORKDIR /home/runner

# Fail the build, not the first run, if a preinstalled toolchain does not answer as the run user.
RUN set -e; \
    git --version; rustc --version; cargo --version; cargo clippy --version; cargo fmt --version; \
    node --version; pnpm --version; yarn --version; deno --version; bun --version; \
    python3 --version; uv --version; go version; \
    rg --version; fd --version; jq --version; just --version; shellcheck --version
