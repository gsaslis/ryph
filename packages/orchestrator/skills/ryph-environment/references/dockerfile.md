# .ryph/Dockerfile reference

The repository's machine, in ordinary Dockerfile syntax, built by the platform with BuildKit. The
repository never sees the Dockerfile the platform wraps around it.

## What the platform does with it

1. Builds `.ryph/Dockerfile` on its own, with the repository at the built commit as the build
   context. `.ryph/Dockerfile.dockerignore`, BuildKit's per-Dockerfile ignore file, is honoured.
2. Checks the result has what every run needs: a glibc C library, `/bin/bash` and `git`. A base that
   lacks one fails the build, naming it. A base with no home for uid 1994 gets one.
3. Copies the clone (with `.git`) to `/ryph/work/<path>` and runs `.ryph/setup.yml` there as uid
   1994, with `RYPH_SETUP_PHASE=image`. Records the versions of `rustc`, `cargo`, `node`, `deno`,
   `bun`, `python3`, `go` and `uv` found on `PATH`.
4. Lays the platform's harness on top, last, and sets the user (uid 1994), the working directory,
   `ENTRYPOINT` and `CMD`, whatever the repository's Dockerfile said.

A repository without `.ryph/Dockerfile` gets the universal image as its machine; steps 2 to 4 are
the same.

## The universal image

`FROM quay.io/ryph/ryph-universal:1` is the recommended start. The platform maps that name to its
own pinned copy, so the same Dockerfile builds on a laptop against the public image.

| Group            | Contents                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Base             | Ubuntu 24.04, build-essential, pkg-config, cmake, clang, libclang-dev, libssl-dev, git, openssh-client, curl, unzip, xz-utils, zstd, sqlite3 |
| Everyday tools   | ripgrep, fd, jq, just, shellcheck                                                                                                            |
| Version managers | rustup; mise, with its shims on `PATH`                                                                                                       |
| Preinstalled     | Rust stable with clippy and rustfmt, Node 24 with corepack (pnpm, yarn), Deno 2, Bun, Python 3.12 with uv, Go                                |
| User             | `runner`, uid and gid 1994, home `/home/runner`; the toolchain homes belong to it                                                            |

Pins are honoured without configuration: rustup reads `rust-toolchain.toml` on the first `cargo`,
and mise's shims install what `.tool-versions`, `mise.toml`, `.nvmrc` or `.python-version` ask for
on first use. `setup.yml` runs at image build as the run user, so a step that touches the toolchain
installs it into the image without a Dockerfile. A repository needs a Dockerfile only for what its
own steps cannot or should not provide: OS packages (root), CLI tools that are not project
dependencies (`setup.yml` reruns at every run start), another base.

## Rules

- **The machine, not the checkout.** No `COPY .` of the repository and no build of the project: the
  platform clones it into the image after this file, and `setup.yml` installs and builds there. That
  split is what keeps later builds incremental.
- **Lockfile-keyed layers are fine.** The context is the repository, so copying one pin or manifest
  to key a layer works as in any CI, and the layer cache makes it free until the file changes:

  ```dockerfile
  COPY rust-toolchain.toml /tmp/toolchain/
  RUN cd /tmp/toolchain && rustup toolchain install
  ```
- **Root for packages, the run user for the rest.** The universal image ends as `runner`. Switch to
  `USER root` for `apt-get install -y --no-install-recommends …` (and remove `/var/lib/apt/lists/*`
  in the same `RUN`), then back to `USER runner` before installing toolchains or CLI tools, so the
  run user can update them.
- **Leave `ENTRYPOINT`, `CMD` and the final user to the platform.** They are replaced.
- **No secrets.** Builds get no credentials and no build secrets. Downloads go through the
  deployment's egress proxy, which allows the mainstream package registries and toolchain hosts the
  operator chose. Prefer package managers and official release hosts over arbitrary URLs.
- **Never turn certificate checks off in `ENV`.** The platform's runner and setup step run inside
  the image with its environment and refuse to start under `NODE_TLS_REJECT_UNAUTHORIZED` set to
  anything but `1`, `BUN_OPTIONS`, `BUN_BE_BUN`, `BUN_CONFIG_VERBOSE_FETCH` or any `BUN_INSPECT*`:
  every run then fails at boot, the build at the setup step. Behind a TLS-intercepting proxy, add
  its CA instead (`COPY` the PEM in and set `ENV NODE_EXTRA_CA_CERTS=/path/to/ca.pem`).
- **Another base** works when it passes the checks above: glibc (not Alpine or another musl base),
  bash and git. A language image such as `rust:1` or a browser-testing image built on Ubuntu is
  fine.

## Workspaces and standalone runs

A workspace builds only its environment repository's Dockerfile, which must supply the machine
requirements of every member's setup and checks. The other members' Dockerfiles are ignored in that
workspace build, but used when those repositories run independently. Give each member a Dockerfile
when its own requirements exceed the universal image and what its setup steps should provide; do not
rely on the workspace's extra tools being available standalone. Duplication of required machine
dependencies between that Dockerfile and the environment repository's is intentional.

## Builds and caching

- A build of the default branch writes the layer cache; a branch build reads it and writes only its
  own. A branch build never seeds what the default branch picks up.
- Anything under `.ryph/` changing is a new environment, except `checks.yml`, `services.yml` and
  `environment.md`, which no build reads. The default branch builds when such a change lands; a
  patch that changes `.ryph/` builds once it reaches the forge as a branch, and its result is posted
  to the run that submitted it. A branch that only fell behind a default branch whose `.ryph/` moved
  changed nothing, and runs on the default branch's machine.
- A run waits for a build only when the image it would otherwise get is the wrong machine (its
  branch's `.ryph/Dockerfile` differs). An image that is merely older is used at once, because the
  run fetches its own commit and runs `setup.yml` again anyway.

## Example

```dockerfile
FROM quay.io/ryph/ryph-universal:1

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends codespell protobuf-compiler \
 && rm -rf /var/lib/apt/lists/*
USER runner

COPY rust-toolchain.toml /tmp/toolchain/
RUN cd /tmp/toolchain && rustup toolchain install
RUN cargo install --locked cargo-nextest typos-cli
```
