// Size classes as pure functions: the RYPH_RUN_SIZES grammar, the default a run falls back to,
// and the resolution a stale name degrades through. The HTTP half (who may set a class, and
// which class a run gets) lives in size_classes_test.ts.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  DEFAULT_RUN_SIZES,
  defaultRunSize,
  memoryMebibytes,
  parseRunSizes,
  quantityBytes,
  quantityCores,
  resolveRunSize,
  runSizesFromEnv,
  SIZE_CLASS_NAME,
  unappliedSizeFields,
} from "../src/core/run_sizes.ts";

const failing = (message: string): never => {
  throw new Error(message);
};
const envOf = (vars: Record<string, string>) => (name: string) => vars[name];

test("unset, there is one class — the size a run pod always had — and it is the default", () => {
  const sizes = runSizesFromEnv(envOf({}), failing);
  assertEquals(sizes, DEFAULT_RUN_SIZES);
  assertEquals(sizes.defaultName, "standard");
  assertEquals(sizes.classes, [{
    name: "standard",
    cpu: "4",
    memory: "8Gi",
    ephemeralStorage: "10Gi",
    workVolume: null,
  }]);
});

test("Docker defaults to bare standard, Kubernetes stays sized, and explicit classes win", () => {
  assertEquals(runSizesFromEnv(envOf({ RYPH_PROVISIONER: "docker" }), failing), {
    defaultName: "standard",
    classes: [{
      name: "standard",
      cpu: null,
      memory: null,
      ephemeralStorage: null,
      workVolume: null,
    }],
  });
  assertEquals(
    runSizesFromEnv(envOf({ RYPH_PROVISIONER: "kubernetes" }), failing),
    DEFAULT_RUN_SIZES,
  );
  const configured = {
    RYPH_RUN_SIZES: "small:cpu=2;large:memory=4Gi",
    RYPH_RUN_SIZE_DEFAULT: "large",
  };
  assertEquals(
    runSizesFromEnv(envOf({ ...configured, RYPH_PROVISIONER: "docker" }), failing),
    runSizesFromEnv(envOf(configured), failing),
  );
});

test("an example parses: two classes, one with a work volume", () => {
  const sizes = runSizesFromEnv(
    envOf({
      RYPH_RUN_SIZES: "standard:cpu=4,memory=8Gi,ephemeral-storage=10Gi;" +
        "large:cpu=8,memory=16Gi,ephemeral-storage=10Gi,work-volume=50Gi",
      RYPH_RUN_SIZE_DEFAULT: "standard",
    }),
    failing,
  );
  assertEquals(sizes.classes.map((c) => c.name), ["standard", "large"]);
  assertEquals(sizes.classes[1], {
    name: "large",
    cpu: "8",
    memory: "16Gi",
    ephemeralStorage: "10Gi",
    workVolume: "50Gi",
  });
});

test("whitespace and a trailing separator are forgiven; a bare name is an unconstrained class", () => {
  const parsed = parseRunSizes(" small : cpu = 500m ; tiny ; ", undefined);
  assert(parsed.ok);
  assertEquals(parsed.sizes.classes.map((c) => [c.name, c.cpu]), [["small", "500m"], [
    "tiny",
    null,
  ]]);
  // Unset, the default is the first class listed.
  assertEquals(parsed.sizes.defaultName, "small");
});

test("a bad spec is refused at boot, naming the variable and what was wrong", () => {
  const cases: Array<[string, string]> = [
    ["", "defines no class"],
    ["Standard:cpu=4", "lowercase slug"],
    // It names `ryph-reserve-<class>` and a label value, which may not end in "-".
    ["large-:cpu=4", 'does not end in "-"'],
    ["9large:cpu=4", "starts with a letter"],
    [`${"a".repeat(33)}:cpu=4`, "at most 32"],
    ["a:cpu=4;a:cpu=2", "defined twice"],
    ["a:cpu", "key=value"],
    ["a:gpu=1", '"gpu"'],
    ["a:cpu=4,cpu=2", "cpu twice"],
    ["a:cpu=0", "cores or millicores"],
    ["a:cpu=four", "cores or millicores"],
    ["a:memory=8gb", "a quantity like 8Gi"],
    ["a:work-volume=0Gi", "a quantity like 8Gi"],
  ];
  for (const [spec, words] of cases) {
    const err = assertThrows(
      () => runSizesFromEnv(envOf({ RYPH_RUN_SIZES: spec }), failing),
      Error,
    );
    assertStringIncludes(err.message, "RYPH_RUN_SIZES", spec);
    assertStringIncludes(err.message, words, spec);
  }
});

test("a class name is one character to thirty-two, ending in a letter or digit", () => {
  for (const name of ["a", "x2", "gpu-large", `a${"-b".repeat(15)}1`.slice(0, 32)]) {
    assert(SIZE_CLASS_NAME.test(name), name);
    assert(parseRunSizes(`${name}:cpu=1`, undefined).ok, name);
  }
  for (const name of ["", "-a", "a-", "a--", "A", `${"a".repeat(33)}`]) {
    assert(!SIZE_CLASS_NAME.test(name), name);
  }
  // At the longest, its placeholder's name is still a DNS label.
  assert(`ryph-reserve-${"a".repeat(32)}`.length <= 63);
});

test("a default the classes do not define is refused, listing the ones they do", () => {
  const err = assertThrows(
    () =>
      runSizesFromEnv(
        envOf({ RYPH_RUN_SIZES: "a:cpu=1;b:cpu=2", RYPH_RUN_SIZE_DEFAULT: "c" }),
        failing,
      ),
    Error,
  );
  assertStringIncludes(err.message, "RYPH_RUN_SIZE_DEFAULT");
  assertStringIncludes(err.message, "a, b");
});

test("a run gets its subject's class, the default when none, and the default for a stale name", () => {
  const parsed = parseRunSizes("standard:cpu=4;large:cpu=8", "standard");
  assert(parsed.ok);
  const sizes = parsed.sizes;
  assertEquals(resolveRunSize(sizes, "large"), { size: sizes.classes[1], stale: null });
  assertEquals(resolveRunSize(sizes, null), { size: defaultRunSize(sizes), stale: null });
  // Renamed away by the operator: the run is not refused, and the caller is told which name.
  assertEquals(resolveRunSize(sizes, "huge"), { size: defaultRunSize(sizes), stale: "huge" });
});

test("quantities translate the way every backend needs them", () => {
  assertEquals(quantityCores("4"), 4);
  assertEquals(quantityCores("1.5"), 1.5);
  assertEquals(quantityCores("250m"), 0.25);
  assertEquals(quantityBytes("512Mi"), 512 * 2 ** 20);
  assertEquals(quantityBytes("1G"), 1e9);
  assertThrows(() => quantityBytes("lots"), Error, "lots");
  // A fraction of a byte rounds up, as the API server rounds a request, and exactly: a decimal
  // whose float product lands a hair above a whole number is still that number.
  assertEquals(quantityBytes("0.1Ki"), 103);
  assertEquals(quantityBytes("1000.5"), 1001);
  assertEquals(quantityBytes("1.1G"), 1_100_000_000);
  assertEquals(quantityBytes("1.1Ti"), 1_209_462_790_554);
  assertEquals(quantityBytes("0.3M"), 300_000);
  // Rounded UP: a cap below what the operator wrote is a run that dies earlier than promised.
  assertEquals(memoryMebibytes("8Gi"), 8192);
  assertEquals(memoryMebibytes("1G"), 954);
});

test("what a backend leaves alone is named in RYPH_RUN_SIZES' own spelling", () => {
  const large = {
    name: "large",
    cpu: "8",
    memory: "16Gi",
    ephemeralStorage: "10Gi",
    workVolume: "50Gi",
  };
  assertEquals(unappliedSizeFields(large, ["cpu", "memory"]), [
    "ephemeral-storage",
    "work-volume",
  ]);
  // A field the class does not set is not "unapplied" — there was nothing to apply.
  assertEquals(unappliedSizeFields({ ...large, workVolume: null }, ["cpu", "memory"]), [
    "ephemeral-storage",
  ]);
  assertEquals(
    unappliedSizeFields(large, ["cpu", "memory", "ephemeralStorage", "workVolume"]),
    [],
  );
});
