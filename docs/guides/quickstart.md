# Quickstart

From nothing to a first run on your own machine, by hand. Each step says what you type and what you
should see; the details live in [the binary's README](../../packages/ryph/README.md). To have a
coding agent do this for you, hand it [setup with an agent](setup-with-an-agent.md) instead.

You need **docker** (Docker Desktop, or Docker Engine 28 or later on Linux) and **git**. Nothing
else: the binary carries its own database, migrations and web UI.

## 1. Install

```sh
curl -fsSL https://ryph.ai/install.sh | sh
```

It installs `ryph` into `~/.local/bin` and says so, with a line to add to your shell profile if that
directory is not on your `PATH`.

## 2. Sign in to your git host, if you use one

```sh
gh auth login      # GitHub; or glab auth login for GitLab
```

Optional. With a login in place, setup can use it, and nothing else about your git host needs
configuring. Repositories in a directory on this machine need no git host at all.

## 3. Setup

```sh
ryph setup
```

Four groups of questions, asked once and written to `~/.ryph/config.env`:

- **Master key**: mint one. It seals every provider key the deployment stores and lives in
  `~/.ryph/secrets.key`. Back that file up.
- **Agent runner**: docker, with a browser for agents, and how much internet a run gets.
  `allowlisted` is the default; `confined` is stronger where your docker can do it.
- **Repositories**: a directory on this machine, your GitHub or GitLab login, a Radicle identity, or
  skip for now.
- **Mail**: only asked for a multi-user instance.

`ryph config` afterwards shows what every setting resolved to and which layer decided it. Scripts
and agents answer the same questions with flags: `ryph setup --help`.

## 4. Start

```sh
ryph up
```

The status block shows the web UI, the agent runner and its image, model and tool access, and the
repositories it can reach. A first launch opens the browser signed in. The images download in the
background, agent image first; it is several gigabytes, and the first-run screen shows progress.

## 5. The welcome flow

The browser opens on five steps:

1. **Model**: paste a provider key (Anthropic, OpenAI, or an OpenAI-compatible endpoint), or connect
   a ChatGPT plan. Keys are entered here or on the Model keys page, and nowhere else.
2. **Agent**: your first agent, named Ada unless you rename it, with its model.
3. **Background model**: the model memory uses to turn what agents learn into notes for later.
4. **Repository**: connect one. On this machine, from the directory setup asked about; on GitHub or
   GitLab, from your login.
5. **Ready**: give the agent a task.

## 6. Set up the repository's environment

A run starts faster, and tests run at all, when the repo carries a `.ryph/` directory saying how to
install it and how to run its checks. You do not write that by hand: on the repo's page, **Set up
this repo's environment** starts a task in which an agent reads the repo's CI and lockfiles, writes
the files, and iterates until the environment builds
([environment setup](../../packages/runner/docs/environment-setup.md)).

## 7. A first task

On the new-task page, pick Ada and the repo and ask for something small: "Say hello, list the
top-level files, and finish. Change nothing." Watch the run page: the container starts, the agent
works, the run ends. A task that changes code ends in a patch, which you approve on its page, and
the platform pushes it as a branch or opens a pull request.

## 8. A first automation

On the Triggers page, create one. Pick a sender (Grafana, PagerDuty, Sentry and the rest, or a cron
schedule), an agent and a repo, and the instructions every fire runs. Start with the one that cannot
change anything: "An alert fired. Find the likely cause and report back; change nothing." The page
then shows the sender's own steps for connecting it, with every value to paste.

## Next

Fit the incident loop to your alerting tool, chat and forge:
[incident response](incident-response.md). Keep it running on a machine of its own:
[deploy/compose](../../deploy/compose/README.md). Everything the binary accepts:
[its README](../../packages/ryph/README.md).
