import { command } from "@ryph/process";
import { stat } from "node:fs/promises";
import type { StackBackend } from "../backend.ts";
import { hostDatabases } from "../hostdb.ts";
import { probe } from "../probe.ts";
import { repoRoot, units } from "../stack.ts";
import { dim, green, red, yellow } from "../ui.ts";
import { envOf, wiringChecks } from "../wiring.ts";

/**
 * Preflight diagnostics: verifies the tools the CLI shells out to, each unit's .env file,
 * port ownership, and init state. Observes only; exit 0 means all clear.
 */
export async function doctor(backend: StackBackend): Promise<number> {
  let failures = 0;
  const ok = (label: string, note = "") => console.log(`  ${green("✓")} ${label} ${dim(note)}`);
  const note = (label: string, text: string) => console.log(`  ${dim("•")} ${label} ${dim(text)}`);
  const bad = (label: string, note: string) => {
    failures++;
    console.log(`  ${red("✗")} ${label} ${yellow(note)}`);
  };

  console.log("tools");
  const versionFlag: Record<string, string> = {
    tmux: "-V",
    docker: "--version",
    bun: "--version",
    mise: "--version",
    kubectl: "version --client",
  };
  // Two tools are optional. Without mise, scripts run on the ambient `bun` instead of the repo's
  // pin, which usually works and occasionally does not (toolchain.ts). Without kubectl, `remote`
  // is the one verb that cannot run; the local stack never needs it. Notes, not failures.
  const optional: Record<string, string> = {
    mise: "scripts will use the ambient bun, not the mise.toml pin",
    kubectl: "`./dev remote` has nothing to forward with",
  };
  for (const bin of ["tmux", "docker", "bun", "mise", "kubectl"]) {
    const required = !(bin in optional);
    try {
      const { success } = await command(bin, {
        args: versionFlag[bin].split(" "),
        stdout: "null",
        stderr: "null",
      }).output();
      if (success) ok(bin);
      else if (required) bad(bin, "exits non-zero — broken install?");
      else note(bin, `exits non-zero — ${optional[bin]}`);
    } catch {
      if (required) bad(bin, "not found on PATH");
      else note(bin, `absent — ${optional[bin]}`);
    }
  }

  // The boundary an agent container actually gets. Never a failure when unset — runc is docker's
  // default and every existing checkout is on it — but worth saying out loud, because from the
  // outside "isolated" and "a namespace on this machine's kernel" look identical.
  console.log("isolation");
  const hostEnv = await envOf("host");
  const kind = hostEnv.get("RYPH_PROVISIONER") ?? "manual";
  if (kind !== "docker") {
    note("agent containers", `provisioner=${kind} — nothing is launched from here`);
  } else {
    const runtime = hostEnv.get("RYPH_DOCKER_RUNTIME");
    const registered = await dockerRuntimes();
    if (!runtime) {
      note(
        "RYPH_DOCKER_RUNTIME",
        "unset — runc, on the shared kernel: an escaped run reaches the daemon and its " +
          "siblings. kata-runtime or runsc puts a second boundary in the way",
      );
    } else if (registered === null) {
      bad(`RYPH_DOCKER_RUNTIME=${runtime}`, "docker did not answer — cannot verify");
    } else if (registered.includes(runtime)) {
      ok(`RYPH_DOCKER_RUNTIME=${runtime}`, "registered with this docker");
    } else {
      bad(
        `RYPH_DOCKER_RUNTIME=${runtime}`,
        `not registered — every launch fails. this docker has: ${registered.join(", ")}`,
      );
    }
  }

  console.log("env files");
  for (const unit of units) {
    if (!unit.envFile) continue;
    if (await exists(unit.envFile)) ok(unit.name, rel(unit.envFile));
    else bad(unit.name, `missing ${rel(unit.envFile)} — ./dev init`);
  }

  console.log("ports");
  const panes = await backend.list();
  for (const unit of units) {
    if (!unit.port) continue;
    const pane = panes.get(unit.name);
    const answering = await probe(unit.port);
    if (pane && !pane.dead) {
      if (answering) {
        ok(`${unit.name} :${unit.port}`, "running and answering");
      } else {
        bad(`${unit.name} :${unit.port}`, "pane alive but port silent — still booting?");
      }
    } else if (answering) {
      bad(
        `${unit.name} :${unit.port}`,
        "answering outside the stack — foreign process",
      );
    } else if (pane?.dead) {
      bad(`${unit.name} :${unit.port}`, `pane dead — crashed; ./dev logs ${unit.name}`);
    } else ok(`${unit.name} :${unit.port}`, "free");
  }

  console.log("data");
  for (const db of await hostDatabases()) {
    // Nothing local to look at: an in-memory database, or a server this checkout does not own.
    if (db.dir === null) {
      ok(`host database (${db.key})`, db.url);
      continue;
    }
    const label = `host database ${rel(db.dir)}`;
    // Presence only, and deliberately. Whether the SCHEMA is applied is knowable just by opening
    // the database — and opening a PGlite data directory the host already holds is the one thing
    // @ryph/db warns about: both instances succeed and then silently stop seeing each other's
    // writes. A doctor that corrupts the stack to diagnose it is not a doctor. The host says so
    // itself at boot, loudly, and names the fix.
    if (await exists(db.dir)) ok(label, "present");
    else bad(label, `missing (${db.key}) — ./dev init`);
  }

  console.log(
    "wiring " +
      dim(
        "· a ─ VAR → b: a dials b via VAR, set in a's .env unless marked · a ⇄ b: must match",
      ),
  );
  const checks = await wiringChecks();
  const width = Math.max(...checks.map((c) => c.label.length));
  for (const check of checks) {
    const paint = check.status === "ok" ? green : check.status === "bad" ? red : dim;
    const label = check.label.padEnd(width).replace(/[─→⇄]/g, (arrow) => paint(arrow));
    if (check.status === "ok") ok(label, check.note);
    else if (check.status === "bad") bad(label, check.note);
    else console.log(`  ${dim("•")} ${label} ${dim(check.note)}`);
  }

  console.log(
    failures === 0 ? green("all clear") : red(`${failures} problem(s) found`),
  );
  return failures === 0 ? 0 : 1;
}

const rel = (path: string) => path.replace(`${repoRoot}/`, "");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The runtime names this docker daemon will accept, or null when it cannot be asked. */
async function dockerRuntimes(): Promise<string[] | null> {
  try {
    const { success, stdout } = await command("docker", {
      args: ["info", "--format", "{{json .Runtimes}}"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!success) return null;
    return Object.keys(JSON.parse(new TextDecoder().decode(stdout)));
  } catch {
    return null;
  }
}
