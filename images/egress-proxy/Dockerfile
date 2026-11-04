# The egress proxy — the one way out of a run's network, and the only place a hostname
# allowlist can be enforced (see main.ts beside this file).
#
# Built for the posture the tool guard gets, and for the same reasons: it holds no credential it
# could be robbed of, it reads no files, and nothing about it needs a shell. One TypeScript file on
# a distroless Node base. It imports nothing but Node's built-ins, so the build needs neither the
# lockfile nor the network beyond the base image.
#
# Node's permission model, not Bun: `--permission` takes away every file read and write, every
# child process, worker and native addon, and `--allow-net` hands back the network (listening,
# dialling, DNS) alone. `deno compile --allow-net --allow-env --allow-sys=networkInterfaces` was
# the same posture; Node does not gate the environment or the interface list (`ownAddresses`
# reads it), so nothing else needs granting. A compiled Bun binary would run with every right of
# its uid. Node runs main.ts as it is, stripping its types.
#
# The base's Node major (26) is past 25, the first with `--allow-net`. Bump it by digest.
# Built from the workspace root, like every image here — `bun run agent-image` builds it into
# docker's store:
#   docker build -f images/egress-proxy/Dockerfile -t ryph-egress-proxy:dev .

# Node and glibc, and nothing else: no shell, no package manager.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:a3bb283a564754266646d6029c5b6aa4f760b9415dae1398db8d7f8142ee1375
# Root-owned and read-only to 65534, which runs it.
COPY images/egress-proxy/main.ts /app/main.ts
# The base's workdir is /home/nonroot, mode 700 for uid 65532, and this runs as 65534. This
# process reads no files.
WORKDIR /
USER 65534:65534
# 7461 is hosted MCP servers' listener, open only with RYPH_EGRESS_TOOL_KEY (main.ts's header).
EXPOSE 7460 7461
# --allow-net is still marked experimental and says so on every start; the warning is the only
# thing silenced.
ENTRYPOINT ["/nodejs/bin/node", "--permission", "--allow-net", "--disable-warning=ExperimentalWarning", "/app/main.ts"]
