# The default image — ryph-agent — the universal environment with the harness layer on top: what
# every run launches on until its repo has an environment image of its own, and what
# `RYPH_AGENT_IMAGE` names. One container is one run.
#
# It is the same shape an environment build produces, minus the checkout: the machine first, the
# harness last, so the layer is `/opt/ryph` and nothing else, and upgrading it never touches the
# machine below. Every harness kind we ship is in the layer (harness.json lists them), so the
# kind picks a harness inside the runner, never an image.
#
# The environment at spawn carries only the orchestrator address and the run credentials (the
# full contract lives in images/README.md); the runner fetches its work item and context on boot,
# the Result JSON prints on stdout, logs on stderr. `docker stop` sends SIGTERM, which is the
# runner's graceful-cancel path — committed work still ships — so give it a generous stop timeout.
#
# Both inputs are images, named by build argument, so the same file builds against a local
# `ryph-harness:dev`, a registry tag, or a digest:
#   bun run agent-image                        # universal, harness, then this, into every store
#   docker build --platform linux/amd64 -f images/agent/Dockerfile \
#     --build-arg UNIVERSAL_IMAGE=ryph-universal:dev --build-arg HARNESS_IMAGE=ryph-harness:dev \
#     -t ryph-agent:dev .

ARG UNIVERSAL_IMAGE=quay.io/ryph/ryph-universal:1
ARG HARNESS_IMAGE=ryph-harness:dev

FROM ${HARNESS_IMAGE} AS harness

FROM ${UNIVERSAL_IMAGE}
USER root
COPY --from=harness /opt/ryph /opt/ryph
# The layer's three requirements of any base, checked where a wrong base fails the build.
RUN /opt/ryph/lib/check-base.sh

# The layer owns the user, the working directory and the entrypoint, whatever the base said:
# uid 1994 is what every backend runs as (Kubernetes pins it by number), and the home is the
# universal image's. Nothing above the checkout root may carry a context file (an AGENTS.md in
# $HOME) — the harness walks its ancestors for one — and this image keeps that true.
USER 1994:1994
WORKDIR /home/runner
# Init reaps orphaned job descendants and forwards signals to the runner, not its whole group.
# -s keeps it reaping when it is not PID 1 (docker --init, a shared process namespace), and
# RYPH_INIT tells the runner it is under init, so it ignores the stray signals tini forwards.
ENV RYPH_INIT=tini
# No command: an orchestrator launch appends no args, so the work item and context are fetched on
# boot. A caller may still append the runner's CLI flags (--work-item, --context) to override.
ENTRYPOINT ["/opt/ryph/bin/tini", "-s", "--", "/opt/ryph/bin/ryph-runner"]
