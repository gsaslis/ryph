// The service declaration, end to end as a pure function: YAML in, either a launchable spec or
// a refusal a repo author can act on. This file IS the specification of `.ryph/services.yml`.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { parseServicesYaml } from "../src/helpers/services.ts";
import {
  DEFAULT_SERVICE_POLICY,
  forRuns,
  largerMemory,
  matchesPrefix,
  normalizeImage,
  resolveServices,
  type ServiceCatalogueEntry,
  type ServicePolicy,
  servicePolicyFromEnv,
  servicesRef,
} from "../src/core/services.ts";
import type { ConnectedRepo } from "../src/core/types.ts";

const POSTGRES: ServiceCatalogueEntry = {
  id: "postgres",
  name: "PostgreSQL",
  description: "",
  docs: "https://example.test",
  versions: { "18": `postgres:18@sha256:${"a".repeat(64)}` },
  defaultPort: 5432,
  capabilities: ["CHOWN", "SETGID", "SETUID"],
  memory: "512m",
  env: ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"],
};
const REDIS: ServiceCatalogueEntry = {
  id: "redis",
  name: "Redis",
  description: "",
  docs: "https://example.test",
  versions: { "8": `redis:8@sha256:${"b".repeat(64)}` },
  defaultPort: 6379,
  capabilities: ["CHOWN", "SETGID", "SETPCAP", "SETUID"],
  memory: "256m",
  env: [],
};
const CATALOGUE = [POSTGRES, REDIS];
const ON: ServicePolicy = { ...DEFAULT_SERVICE_POLICY, enabled: true };

/** The motivating repo's declaration: a test suite that needs Postgres and Redis. */
const MOTIVATING = `services:
  db:
    uses: postgres@18
    command: ["postgres", "-p", "5433", "-c", "fsync=off"]
    env:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: password
      POSTGRES_DB: app_test
    port: 5433
  redis:
    uses: redis@8
    command: ["redis-server", "--port", "6382"]
    port: 6382
`;

const refusal = (yaml: string, policy = ON, catalogue = CATALOGUE): string => {
  const resolved = resolveServices(parseServicesYaml(yaml), catalogue, policy);
  assertEquals(resolved.kind, "refused", `expected a refusal, got ${JSON.stringify(resolved)}`);
  return resolved.kind === "refused" ? resolved.error : "";
};

test("the motivating declaration resolves to two digest-pinned, confined containers", () => {
  const resolved = resolveServices(parseServicesYaml(MOTIVATING), CATALOGUE, ON);
  assert(resolved.kind === "ok");
  assertEquals(resolved.services.map((s) => s.name), ["db", "redis"]);

  const [db, redis] = resolved.services;
  // The repo named `postgres@18`; the CATALOGUE named the bytes.
  assertEquals(db.image, POSTGRES.versions["18"]);
  assertEquals(db.port, 5433);
  assertEquals(db.env, {
    POSTGRES_USER: "user",
    POSTGRES_PASSWORD: "password",
    POSTGRES_DB: "app_test",
  });
  // Measured, not guessed: redis needs SETPCAP where postgres does not, because its entrypoint
  // drops privileges with setpriv and that shrinks the bounding set. This difference is the
  // entire argument for a catalogue over a registry-prefix allowlist.
  assertEquals(db.security.capabilities, ["CHOWN", "SETGID", "SETUID"]);
  assertEquals(redis.security.capabilities, ["CHOWN", "SETGID", "SETPCAP", "SETUID"]);
  assertEquals(db.security.allowPrivilegeEscalation, false);
  // The operator's cap, not the repo's ask — the field does not exist in the declaration.
  assertEquals(db.resources, { cpus: "1", memory: "1g" });
});

test("a service gets the larger of the entry's floor and the operator's allowance", () => {
  // The entry's memory is what the image needs to come up — measured beside its capability
  // set — so an operator tightening RYPH_SERVICE_MEMORY must not silently start an image
  // under it and have it OOM at entrypoint. Before this the field was never read at all.
  const big: ServiceCatalogueEntry = { ...POSTGRES, memory: "2g" };
  const declaration = "services:\n  db:\n    uses: postgres@18\n    port: 5432\n";

  const tight = resolveServices(parseServicesYaml(declaration), [big], {
    ...ON,
    memory: "256m",
  });
  assert(tight.kind === "ok");
  assertEquals(tight.services[0].resources.memory, "2g");

  // And the operator's allowance wins when it is the larger of the two.
  const generous = resolveServices(parseServicesYaml(declaration), [big], {
    ...ON,
    memory: "4g",
  });
  assert(generous.kind === "ok");
  assertEquals(generous.services[0].resources.memory, "4g");

  assertEquals(largerMemory("512m", "1g"), "1g");
  assertEquals(largerMemory("2g", "1024m"), "2g");
  // The escape hatch has no reviewed floor, so the allowance is all there is.
  assertEquals(largerMemory(null, "1g"), "1g");
});

test("a repo cannot widen its own confinement", () => {
  // Even with a capability the allowlist would grant: under `uses`, the set is the entry's.
  assertStringIncludes(
    refusal(`services:
  db:
    uses: postgres@18
    capabilities: ["SETFCAP"]
    port: 5432
`),
    "only an operator-allowlisted",
  );
});

test("the parser is strict, and every refusal names the fix", () => {
  const cases: Array<[string, string]> = [
    ["service:\n  db: {}\n", "unknown key `service`"],
    ["services:\n  db:\n    uses: postgres@18\n", ".port: required"],
    ["services:\n  db:\n    port: 5432\n", "needs `uses`"],
    ["services:\n  DB:\n    uses: postgres@18\n    port: 5432\n", "DNS label"],
    ["services:\n  db:\n    uses: postgres\n    port: 5432\n", "catalogue entry and version"],
    [
      'services:\n  db:\n    uses: postgres@18\n    command: "postgres -p 5433"\n    port: 5432\n',
      "must be a list of arguments",
    ],
    [
      "services:\n  db:\n    uses: postgres@18\n    port: 5432\n    shm_size: 1g\n",
      "unknown key `shm_size`",
    ],
    [
      "services:\n  db:\n    uses: postgres@18\n    env:\n      not-a-name: x\n    port: 5432\n",
      "not an environment variable name",
    ],
    [
      "services:\n  db:\n    uses: postgres@18\n    port: 5432\n    checks_only: yes\n",
      "checks_only: must be true or false",
    ],
    [
      'services:\n  db:\n    uses: postgres@18\n    port: 5432\n    checks_only: "true"\n',
      "checks_only: must be true or false",
    ],
    [
      "services:\n  db:\n    uses: postgres@18\n    port: 5432\n    checks-only: true\n",
      "unknown key `checks-only`",
    ],
  ];
  for (const [yaml, expected] of cases) {
    const err = assertThrows(() => parseServicesYaml(yaml), Error);
    assertStringIncludes(err.message, expected, `for:\n${yaml}`);
  }
});

test("a checks-only service is the checks' alone; a run's list leaves it out", () => {
  const declarations = parseServicesYaml(`services:
  db:
    uses: postgres@18
    port: 5432
    checks_only: true
  cache:
    uses: redis@8
    port: 6379
    checks_only: false
  queue:
    uses: redis@8
    port: 6380
`);
  // Carried only when true, so a declaration without the key is exactly what it always was.
  assertEquals(declarations.map((d) => [d.name, d.checksOnly]), [
    ["db", true],
    ["cache", undefined],
    ["queue", undefined],
  ]);
  assertEquals(forRuns(declarations).map((d) => d.name), ["cache", "queue"]);

  // Otherwise the same service wherever it is started: the catalogue's image, the catalogue's
  // confinement, the operator's policy.
  const resolved = resolveServices(declarations, CATALOGUE, ON);
  assert(resolved.kind === "ok");
  const db = resolved.services.find((s) => s.name === "db")!;
  assertEquals(db.image, POSTGRES.versions["18"]);
  assertEquals(db.security.capabilities, ["CHOWN", "SETGID", "SETUID"]);
  assertStringIncludes(
    refusal("services:\n  db:\n    uses: postgres@18\n    port: 5432\n    checks_only: true\n", {
      ...ON,
      enabled: false,
    }),
    "RYPH_SERVICES is off",
  );

  // Every service checks-only: a run's list is empty, which resolves to nothing even with the
  // feature off — the same answer as a repo with no services.yml.
  const only = forRuns(parseServicesYaml(
    "services:\n  db:\n    uses: postgres@18\n    port: 5432\n    checks_only: true\n",
  ));
  assertEquals(only, []);
  assertEquals(resolveServices(only, CATALOGUE, DEFAULT_SERVICE_POLICY), {
    kind: "ok",
    services: [],
  });
});

test("an empty or comments-only file declares nothing, and is not an error", () => {
  assertEquals(parseServicesYaml(""), []);
  assertEquals(parseServicesYaml("# nothing yet\n"), []);
  assertEquals(parseServicesYaml("services:\n"), []);
});

test("anchors are refused; an ampersand inside an ordinary value is not", () => {
  assertStringIncludes(
    assertThrows(() =>
      parseServicesYaml(`services:
  db: &base
    uses: postgres@18
    port: 5432
  other:
    <<: *base
`), Error).message,
    "anchors and aliases",
  );
  // Every spelling the parser accepts as an anchor, not just the tidy ones: a name is any run of
  // non-space, non-flow-indicator characters, and it may sit behind a tag.
  for (
    const [yaml, found] of [
      ["services:\n  db: &-base\n    uses: postgres@18\n", "&-base"],
      ["services:\n  db:\n    <<: *.base\n", "*.base"],
      ["services:\n  db: !!map &a\n    uses: postgres@18\n", "&a"],
      ["services:\n  db: !<tag:yaml.org,2002:map> &a\n    port: 1\n", "&a"],
      ["services:\n  db:\n    command: [sh, *x]\n", "*x"],
      ["services:\n  db:\n    command:\n      - &x sh\n", "&x"],
      ["? &k db\n: x\n", "&k"],
      ["--- &doc\nservices:\n", "&doc"],
    ]
  ) {
    assertStringIncludes(
      assertThrows(() => parseServicesYaml(yaml), Error).message,
      `found \`${found}\``,
    );
  }
  // The false positive worth guarding: these are values people really write.
  const fine = parseServicesYaml(`services:
  db:
    uses: postgres@18
    command: ["sh", "-c", "a && b", "find . -name *.log"]
    env:
      POSTGRES_PASSWORD: p&ssword
    port: 5432
`);
  assertEquals(fine[0].env.POSTGRES_PASSWORD, "p&ssword");
});

test("the platform's own names and the runner's control port are taken", () => {
  assertStringIncludes(
    refusal("services:\n  forge:\n    uses: postgres@18\n    port: 5432\n"),
    "already answers to something the run can reach",
  );
  assertStringIncludes(
    refusal("services:\n  db:\n    uses: postgres@18\n    port: 8080\n"),
    "the runner's own control port",
  );
});

test("a service may not be named after the host a run reaches the platform at", () => {
  // Not in the static list, and not hypothetical: a deployment whose runners dial
  // `http://orchestrator:7411` would otherwise let a service called `orchestrator` answer the
  // runner's authenticated spec and heartbeat requests.
  const addresses = {
    RYPH_ORCHESTRATOR_URL: "http://orchestrator:7411",
    RYPH_GIT_ORIGIN: null,
    RYPH_HISTORY_URL: "http://history.internal:7413",
  };
  const decl = (name: string) =>
    parseServicesYaml(`services:\n  ${name}:\n    uses: postgres@18\n    port: 5432\n`);
  const shadowing = resolveServices(decl("orchestrator"), CATALOGUE, ON, addresses);
  assert(shadowing.kind === "refused");
  assertStringIncludes(shadowing.error, "RYPH_ORCHESTRATOR_URL (http://orchestrator:7411)");
  // A dotted host cannot be shadowed by a label, and an address that is not set shadows nothing.
  assertEquals(resolveServices(decl("history"), CATALOGUE, ON, addresses).kind, "ok");
  assertEquals(resolveServices(decl("db"), CATALOGUE, ON, addresses).kind, "ok");
});

test("two services on one port is refused — they share one address space", () => {
  assertStringIncludes(
    refusal(`services:
  db:
    uses: postgres@18
    port: 5432
  cache:
    uses: redis@8
    port: 5432
`),
    "already taken by",
  );
});

test("off, over the max, and off-catalogue each refuse by naming the switch or the list", () => {
  assertStringIncludes(
    refusal("services:\n  db:\n    uses: postgres@18\n    port: 5432\n", DEFAULT_SERVICE_POLICY),
    "RYPH_SERVICES is off",
  );
  assertStringIncludes(
    refusal(MOTIVATING, { ...ON, max: 1 }),
    "RYPH_SERVICE_MAX",
  );
  assertStringIncludes(
    refusal("services:\n  db:\n    uses: elastic@9\n    port: 9200\n"),
    "this deployment offers: postgres, redis",
  );
  assertStringIncludes(
    refusal("services:\n  db:\n    uses: postgres@17\n    port: 5432\n"),
    'has no version "17"',
  );
  assertStringIncludes(
    refusal(
      "services:\n  db:\n    uses: postgres@18\n    env:\n      PGUSER: x\n    port: 5432\n",
    ),
    "takes no such setting",
  );
});

test("the escape hatch is off by default, and anchored when on", () => {
  const declaration = `services:
  odd:
    image: ghcr.io/acme/thing:1
    capabilities: []
    port: 9000
`;
  assertStringIncludes(refusal(declaration), "catalogue entries only");
  assertStringIncludes(
    refusal(declaration, { ...ON, imageAllowlist: ["ghcr.io/other"] }),
    "not under any prefix",
  );

  const allowed = resolveServices(
    parseServicesYaml(declaration),
    CATALOGUE,
    { ...ON, imageAllowlist: ["ghcr.io/acme"] },
  );
  assert(allowed.kind === "ok");
  assertEquals(allowed.services[0].image, "ghcr.io/acme/thing:1");
  assertEquals(allowed.services[0].security.capabilities, []);

  // Naming the image is what the hatch allows; restoring what `drop: ALL` removed is not. An
  // allowlist, because NET_RAW is only one road to the run's tokens: NET_ADMIN is another, and
  // ALL is every road at once.
  for (const cap of ["ALL", "NET_RAW", "SYS_ADMIN", "NET_ADMIN", "DAC_READ_SEARCH"]) {
    assertThrows(
      () =>
        parseServicesYaml(
          `services:\n  odd:\n    image: ghcr.io/acme/thing:1\n    capabilities: ["${cap}"]\n` +
            "    port: 9000\n",
        ),
      Error,
      cap === "ALL" ? "every capability" : "never granted to a service container",
    );
  }
  assertEquals(
    parseServicesYaml(
      'services:\n  odd:\n    image: ghcr.io/acme/thing:1\n    capabilities: ["CHOWN"]\n' +
        "    port: 9000\n",
    )[0].capabilities,
    ["CHOWN"],
  );

  // No catalogue reviewed it, so somebody has to say. An omitted list must never quietly mean
  // "the runtime default" — that is CAP_NET_RAW in the run's network namespace.
  assertStringIncludes(
    refusal(
      "services:\n  odd:\n    image: ghcr.io/acme/thing:1\n    port: 9000\n",
      { ...ON, imageAllowlist: ["ghcr.io/acme"] },
    ),
    "must declare the capabilities",
  );
});

test("an allowlist prefix matches only at a path boundary", () => {
  assertEquals(normalizeImage("postgres:18"), "docker.io/library/postgres:18");
  assertEquals(normalizeImage("acme/thing"), "docker.io/acme/thing");
  assertEquals(normalizeImage("ghcr.io/acme/thing"), "ghcr.io/acme/thing");
  assertEquals(normalizeImage("localhost:5000/thing"), "localhost:5000/thing");

  // The walk-past this closes: `evil/postgres` under a rule for `postgres`.
  assertEquals(matchesPrefix(normalizeImage("evil/postgres"), "postgres"), false);
  assertEquals(matchesPrefix(normalizeImage("postgres:18"), "postgres"), true);
  assertEquals(matchesPrefix(normalizeImage("postgresql:18"), "postgres"), false);
  assertEquals(matchesPrefix(normalizeImage("ghcr.io/acme-evil/x"), "ghcr.io/acme"), false);
  assertEquals(matchesPrefix(normalizeImage("ghcr.io/acme/x"), "ghcr.io/acme/*"), true);
});

test("a bare registry host allows that registry, and only that registry", () => {
  // Normalized as a Docker Hub image, `ghcr.io/*` became `docker.io/library/ghcr.io` and
  // matched nothing — a documented allowlist spelling that silently allowed no image at all.
  assertEquals(matchesPrefix(normalizeImage("ghcr.io/acme/thing:1"), "ghcr.io/*"), true);
  assertEquals(matchesPrefix(normalizeImage("ghcr.io/acme/thing:1"), "ghcr.io"), true);
  assertEquals(matchesPrefix(normalizeImage("localhost:5000/thing"), "localhost:5000/*"), true);
  assertEquals(matchesPrefix(normalizeImage("localhost/thing"), "localhost"), true);
  // Anchored at the host boundary, and nowhere else.
  assertEquals(matchesPrefix(normalizeImage("ghcr.io.evil.test/x"), "ghcr.io"), false);
  assertEquals(matchesPrefix(normalizeImage("quay.io/acme/thing"), "ghcr.io/*"), false);
  assertEquals(matchesPrefix(normalizeImage("localhost:5001/thing"), "localhost:5000"), false);
  // No dot, not localhost: still an image, as docker reads it.
  assertEquals(matchesPrefix(normalizeImage("redis:7"), "redis"), true);
  assertEquals(matchesPrefix(normalizeImage("acme/redis"), "redis"), false);
});

test("servicesRef reads a branch of the connected repo, and the default branch otherwise", () => {
  const repo = {
    url: "https://github.com/acme/app.git",
    defaultBranch: "main",
  } as ConnectedRepo;
  // Today's only shape: a branch of the connected repo, which needed write access to create.
  assertEquals(servicesRef(repo, { url: repo.url, ref: "feature/x" }), "feature/x");
  assertEquals(
    servicesRef(repo, { url: repo.url, ref: "refs/heads/feature/x" }),
    "refs/heads/feature/x",
  );
  // The shape the rule exists for: a PR head is fetched FROM the base repo but its content is
  // the fork's, so it must not choose what the platform launches.
  assertEquals(servicesRef(repo, { url: repo.url, ref: "refs/pull/42/head" }), "main");
  assertEquals(servicesRef(repo, { url: "https://elsewhere/x.git", ref: "trunk" }), "main");
});

test("the policy reads off by default and refuses a spelling it cannot honour", () => {
  const of = (vars: Record<string, string>) =>
    servicePolicyFromEnv((n) => vars[n], (m) => {
      throw new Error(m);
    });
  assertEquals(of({}), DEFAULT_SERVICE_POLICY);
  assertEquals(of({ RYPH_SERVICES: "on" }).enabled, true);
  assertEquals(
    of({ RYPH_SERVICE_IMAGES: "ghcr.io/acme, docker.io/library/postgres" }).imageAllowlist,
    ["ghcr.io/acme", "docker.io/library/postgres"],
  );
  // Kubernetes' spelling means 1 GiB to a kubelet and nothing to docker; refused rather than
  // silently capping one backend differently from the other.
  assertStringIncludes(
    assertThrows(() => of({ RYPH_SERVICE_MEMORY: "1Gi" }), Error).message,
    "docker's spelling",
  );
  assertStringIncludes(
    assertThrows(() => of({ RYPH_SERVICES: "yes" }), Error).message,
    '"on" or "off"',
  );
  // Zero is no cap to docker and a zero quantity to a kubelet: a constraint that removes itself.
  for (const cpu of ["0", "0.0", "9".repeat(400)]) {
    assertStringIncludes(
      assertThrows(() => of({ RYPH_SERVICE_CPU: cpu }), Error).message,
      "above zero",
    );
  }
  assertEquals(of({ RYPH_SERVICE_CPU: "0.5" }).cpus, "0.5");
});

test("a service name leaves room for the svc- prefix its kubernetes container carries", () => {
  // A 63-character label is valid DNS, and `svc-` makes it a 67-character container name the
  // API server refuses — at launch, long after the declaration looked fine.
  const declare = (name: string) =>
    parseServicesYaml(`services:\n  ${name}:\n    uses: redis@8\n    port: 6382\n`);
  assertEquals(declare(`a${"b".repeat(58)}`)[0].name.length, 59);
  assertStringIncludes(
    assertThrows(() => declare(`a${"b".repeat(59)}`), Error).message,
    "at most 59 characters",
  );
});
