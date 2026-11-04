import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import Page from "./+page.svelte";
import { retryOf } from "./notice";

const ID = "a".repeat(32);
const at = (query: string) => new URL(`https://ryph.test/previews/unavailable${query}`);

describe("/previews/unavailable", () => {
  it("tries the same open again, with the path it had", () => {
    expect(retryOf(at(`?id=${ID}`))).toBe(`/previews/${ID}`);
    const path = "/nodes/x?y=1";
    expect(retryOf(at(`?id=${ID}&path=${encodeURIComponent(path)}`))).toBe(
      `/previews/${ID}?path=${encodeURIComponent(path)}`,
    );
  });

  it("offers nothing to try for what is not a preview id", () => {
    for (const query of ["", "?id=", `?id=${ID.toUpperCase()}`, "?id=../x", `?id=${ID}0`]) {
      expect(retryOf(at(query))).toBeNull();
    }
  });

  it("says why in a line, and offers a way back to the app, and to try again when it can", () => {
    const page = (retry: string | null) =>
      render(Page, { props: { data: { retry }, params: {} } as never }).body;
    const once = page(`/previews/${ID}`);
    expect(once).toContain("This preview isn't available");
    expect(once).toContain("Its run may have ended");
    expect(once).toMatch(/href="\/"[^>]*>[\s\S]*?Back to Ryph/);
    expect(once).toContain(`href="/previews/${ID}"`);
    expect(once).toContain("Try again");
    const none = page(null);
    expect(none).toContain("Back to Ryph");
    expect(none).not.toContain("Try again");
  });
});
