#!/bin/sh
# Installs the `ryph` binary: curl -fsSL https://ryph.ai/install.sh | sh
#
# Downloads this platform's build from files.ryph.ai, checks SHA256SUMS against the release key's
# signature (ssh-keygen -Y verify, which ships with macOS and OpenSSH 8.1 or later), checks that
# the signed file names the release asked for, and the binary against it, then installs it.
# Published by packages/ryph/scripts/release.ts.
#
#   RYPH_VERSION      a release to install: a version (0.1.0, v0.1.0, 0.2.0-rc.1), `edge` for the
#                     newest build of main, or one build (sha-<12>); default: the latest release
#   RYPH_INSTALL_DIR  where to put `ryph`; default: ~/.local/bin
#
# Everything is inside main, called on the last line, so a download cut short runs nothing.

set -eu

BASE_URL="${RYPH_BASE_URL:-https://files.ryph.ai/releases}"
INSTALL_DIR="${RYPH_INSTALL_DIR:-$HOME/.local/bin}"
# The release key. Its private half signs every release's SHA256SUMS.
SIGNER="releases@ryph.ai"
PUBLIC_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFJyYvSI27UqzrLCGyg4pPzrmvE/X9lSmZL1OHS3ERYo"
NAMESPACE="ryph-release"

# Colour and the closing emoji only for a person at a terminal: NO_COLOR, a pipe or a CI log gets
# plain text (the ✓ marks stay).
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
  BOLD=$(printf '\033[1m') DIM=$(printf '\033[2m') RED=$(printf '\033[31m')
  GREEN=$(printf '\033[32m') YELLOW=$(printf '\033[33m') CYAN=$(printf '\033[36m')
  RESET=$(printf '\033[0m') FANCY=1
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" CYAN="" RESET="" FANCY=""
fi

say() { printf '%s\n' "$*"; }
step() { printf '%s→%s %s\n' "$CYAN" "$RESET" "$*"; }
ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
fail() {
  printf '%s✗ ryph install:%s %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || fail "needs $1, which is not installed"; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail "needs sha256sum or shasum"
  fi
}

main() {
  need curl
  need uname
  need ssh-keygen
  # OpenSSH before 8.1 has no -Y, and would otherwise read as a bad signature.
  if ssh-keygen -Y verify 2>&1 | grep -qi "illegal option\|unknown option\|invalid option"; then
    fail "needs OpenSSH 8.1 or later to check the release signature (ssh-keygen -Y)"
  fi

  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "no build for $os (macOS and Linux only)" ;;
  esac
  case "$arch" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) fail "no build for $arch (arm64 and x86_64 only)" ;;
  esac
  # A shell under Rosetta reports x86_64 on an Apple silicon Mac: install the native build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] &&
    [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  if [ "$os" = linux ]; then
    case "$arch" in
      arm64) loader=/lib/ld-linux-aarch64.so.1 ;;
      x64) loader=/lib64/ld-linux-x86-64.so.2 ;;
    esac
    [ -e "$loader" ] ||
      fail "no glibc loader at $loader (Alpine or another musl system?): ryph needs glibc"
  fi

  version="${RYPH_VERSION:-latest}"
  case "$version" in
    latest | edge)
      version=$(curl -fsSL "$BASE_URL/$version") || fail "could not reach files.ryph.ai"
      ;;
    v[0-9]*) version="${version#v}" ;;
  esac
  if ! printf '%s' "$version" |
    grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?|sha-[0-9a-f]{12}'; then
    fail "not a release: ${RYPH_VERSION:-$version}"
  fi

  file="ryph-$os-$arch"
  tmp=$(mktemp -d)
  staged=""
  trap 'rm -rf "$tmp" ${staged:+"$staged"}' EXIT INT TERM

  say ""
  step "Downloading ryph ${BOLD}$version${RESET} for $os/$arch"
  curl -fsSL -o "$tmp/SHA256SUMS" "$BASE_URL/$version/SHA256SUMS" ||
    fail "no release $version"
  curl -fsSL -o "$tmp/SHA256SUMS.sig" "$BASE_URL/$version/SHA256SUMS.sig" ||
    fail "release $version has no signature"
  # A progress bar for a person; a log gets only errors.
  if [ -n "$FANCY" ]; then progress=--progress-bar; else progress=-sS; fi
  curl -fL "$progress" -o "$tmp/$file" "$BASE_URL/$version/$file" ||
    fail "release $version has no build for $os/$arch"

  printf '%s %s\n' "$SIGNER" "$PUBLIC_KEY" >"$tmp/allowed_signers"
  if ! said=$(ssh-keygen -Y verify -f "$tmp/allowed_signers" -I "$SIGNER" -n "$NAMESPACE" \
    -s "$tmp/SHA256SUMS.sig" <"$tmp/SHA256SUMS" 2>&1); then
    fail "SHA256SUMS is not signed by the release key, not installing: $said"
  fi
  ok "Signed by $SIGNER"
  # The signed file names its release, so another release's files cannot stand in for this one.
  [ "$(awk '$1 == "release" { print $2 }' "$tmp/SHA256SUMS")" = "$version" ] ||
    fail "SHA256SUMS is signed for another release than $version: not installing"

  want=$(awk -v f="$file" '$2 == f { print $1 }' "$tmp/SHA256SUMS")
  [ -n "$want" ] || fail "SHA256SUMS lists no $file"
  [ "$(sha256 "$tmp/$file")" = "$want" ] || fail "$file does not match SHA256SUMS: not installing"
  ok "Checksum matches"

  # Copied beside the old binary, then renamed over it: a rename is atomic, and a running ryph
  # keeps its own copy.
  mkdir -p "$INSTALL_DIR"
  staged="$INSTALL_DIR/.ryph.$$.tmp"
  cp "$tmp/$file" "$staged" || fail "cannot write to $INSTALL_DIR (set RYPH_INSTALL_DIR)"
  chmod 755 "$staged"
  mv -f "$staged" "$INSTALL_DIR/ryph"
  ok "Installed ryph $("$INSTALL_DIR/ryph" --version 2>/dev/null || true) at $INSTALL_DIR/ryph"

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      case "${SHELL:-}" in
        */zsh) rc="~/.zshrc" ;;
        */bash) rc="~/.bashrc" ;;
        *) rc="~/.profile" ;;
      esac
      say ""
      warn "$INSTALL_DIR is not on your PATH. Add it to $rc, for example:"
      say "    ${BOLD}export PATH=\"$INSTALL_DIR:\$PATH\"${RESET}"
      ;;
  esac

  if ! command -v docker >/dev/null 2>&1; then
    say ""
    warn "Agents run in Docker, which is not installed. Install Docker Desktop (macOS) or"
    say "  Docker Engine 28 or later (Linux) before starting a run."
  fi

  say ""
  if [ -n "$FANCY" ]; then
    say "${GREEN}${BOLD}🎉 Ryph is installed!${RESET}"
  else
    say "Ryph is installed."
  fi
  say ""
  say "Next:"
  say "  ${BOLD}ryph setup${RESET}   ${DIM}a few questions, once${RESET}"
  say "  ${BOLD}ryph up${RESET}      ${DIM}start Ryph and open it in your browser${RESET}"
  say ""
  say "Or tell your coding agent: ${DIM}read${RESET}"
  say "  https://raw.githubusercontent.com/ryph-hq/ryph/main/docs/guides/setup-with-an-agent.md"
  say "  ${DIM}and set me up${RESET}"
  say ""
}

main "$@"
