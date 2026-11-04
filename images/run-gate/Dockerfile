# The run gate — the one door out of a confined docker run network, onto ryph's own ports and
# nothing else (see main.ts beside this file, and the docker provisioner's header).
#
# The egress proxy's posture, for the same reasons: it holds no credential, reads no files, and
# nothing about it needs a shell. One TypeScript file on a distroless Node base, importing only
# Node's built-ins, so the build needs neither the lockfile nor the network beyond the base image.
#
# Node's permission model, not Bun: `--permission` takes away every file read and write, every
# child process, worker and native addon, and `--allow-net` hands back the network alone — the
# posture `deno compile --allow-net` gave it. A compiled Bun binary would run with every right of
# its uid. Node runs main.ts as it is, stripping its types.
#
# The base's Node major (26) is past 25, the first with `--allow-net`. Bump it by digest.
# Built from the workspace root, like every image here — `bun run agent-image` builds it into
# docker's store, the only backend that launches it:
#   docker build -f images/run-gate/Dockerfile -t ryph-run-gate:dev .

# Node and glibc, and nothing else: no shell, no package manager.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:a3bb283a564754266646d6029c5b6aa4f760b9415dae1398db8d7f8142ee1375
# Root-owned and read-only to 65534, which runs it.
COPY images/run-gate/main.ts /app/main.ts
# The egress proxy's reason: the base's workdir is 700 for another uid, and this reads no files.
WORKDIR /
USER 65534:65534
# --allow-net is still marked experimental and says so on every start; the warning is the only
# thing silenced. The provisioner's command line (the routes) follows main.ts.
ENTRYPOINT ["/nodejs/bin/node", "--permission", "--allow-net", "--disable-warning=ExperimentalWarning", "/app/main.ts"]
