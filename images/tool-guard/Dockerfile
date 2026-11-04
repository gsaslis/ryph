# The tool guard — the one entry point onto the tools network, fronting every hosted MCP server
# (see main.ts beside this file).
#
# The gateway launches it at boot with the posture every tool container gets — non-root,
# read-only root filesystem, no capabilities, no mounts — so the image is built for that: one
# TypeScript file on a distroless Node base, nothing to write, nothing to shell into. It imports
# nothing but Node's built-ins, so the build needs neither the lockfile nor the network beyond
# the base image.
#
# Node's permission model, not Bun: `--permission` takes away every file read and write, every
# child process, worker and native addon, and `--allow-net` hands back the network alone — the
# posture `deno compile --allow-net --allow-env` gave it (Node does not gate the environment). A
# compiled Bun binary would run with every right of its uid. Node runs main.ts as it is,
# stripping its types.
#
# The base's Node major (26) is past 25, the first with `--allow-net`. Bump it by digest.
# Built from the workspace root, like every image here — `bun run agent-image` builds it into
# docker's store:
#   docker build -f images/tool-guard/Dockerfile -t ryph-tool-guard:dev .

# Node and glibc, and nothing else: no shell, no package manager.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:a3bb283a564754266646d6029c5b6aa4f760b9415dae1398db8d7f8142ee1375
# Root-owned and read-only to 65534. The guard reads no files.
COPY images/tool-guard/main.ts /app/main.ts
# The base's workdir is /home/nonroot, mode 700 for uid 65532 — and the gateway runs every tool
# container as 65534.
WORKDIR /
# The gateway launches every tool container as 65534 (`nobody`) whatever the image says; saying
# it here too keeps a hand-run guard in the same posture.
USER 65534:65534
EXPOSE 8080
# --allow-net is still marked experimental and says so on every start; the warning is the only
# thing silenced.
ENTRYPOINT ["/nodejs/bin/node", "--permission", "--allow-net", "--disable-warning=ExperimentalWarning", "/app/main.ts"]
