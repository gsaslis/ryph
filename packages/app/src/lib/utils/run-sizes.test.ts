import { describe, expect, it } from "vitest";
import { runSizeLabel, sizeClassLabel, sizeSummary } from "./run-sizes";

const standard = {
  name: "standard",
  cpu: "4",
  memory: "8Gi",
  ephemeralStorage: "10Gi",
  workVolume: null,
  default: true,
};
const large = { ...standard, name: "large", cpu: "8", workVolume: "50Gi", default: false };

describe("sizeSummary", () => {
  it("names every quantity the class sets, and only those", () => {
    expect(sizeSummary(standard)).toBe("4 CPU · 8Gi memory · 10Gi disk");
    expect(sizeSummary(large)).toBe("8 CPU · 8Gi memory · 10Gi disk · 50Gi work volume");
  });

  it("describes unset CPU and memory without promising unlimited host resources", () => {
    expect(
      sizeSummary({
        name: "free",
        cpu: null,
        memory: null,
        ephemeralStorage: null,
        workVolume: null,
      }),
    ).toBe("No CPU or memory caps");
  });
});

it("keeps storage visible and does not call partially capped classes uncapped", () => {
  const uncapped = { ...standard, cpu: null, memory: null };
  expect(sizeSummary(uncapped)).toBe("No CPU or memory caps · 10Gi disk");
  expect(runSizeLabel(uncapped)).toBe("standard · uncapped");
  expect(runSizeLabel({ ...uncapped, cpu: "1" })).toBe("standard");
  expect(runSizeLabel({ ...uncapped, memory: "2Gi" })).toBe("standard");
  expect(sizeSummary({ ...uncapped, cpu: "1" })).toBe("1 CPU · 10Gi disk");
});

describe("sizeClassLabel", () => {
  it("spells out which class the default is", () => {
    expect(sizeClassLabel(null, [standard, large])).toBe("Default (standard)");
  });

  it("names a configured class plainly", () => {
    expect(sizeClassLabel("large", [standard, large])).toBe("large");
  });

  it("keeps a stale name visible, and says what runs get instead", () => {
    expect(sizeClassLabel("huge", [standard, large])).toBe(
      "huge (no longer configured — runs get the default)",
    );
  });
});
