import { describe, expect, it } from "vitest";
import { personInitials } from "./avatar";

describe("personInitials", () => {
  it("takes the first letter of the first two names", () => {
    expect(personInitials("Max Member")).toBe("MM");
    expect(personInitials("ada lovelace byron")).toBe("AL");
    expect(personInitials("Ada")).toBe("A");
  });

  it("ignores stray whitespace and keeps a letter outside the BMP whole", () => {
    expect(personInitials("  Grace   Hopper ")).toBe("GH");
    expect(personInitials("𝔄da")).toBe("𝔄");
    expect(personInitials("   ")).toBe("");
  });
});
