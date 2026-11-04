import { test } from "bun:test";
import { assert } from "@std/assert";
import { permitted } from "../src/mod.ts";

const own = `https://${"0".repeat(32)}.preview.ryph-previews.example`;

test("the request gate: own origin, same-origin fetches, and top-level navigations", () => {
  assert(permitted({}, own, false));
  assert(permitted({ origin: own, "sec-fetch-site": "same-origin" }, own, false));
  assert(permitted({ "sec-fetch-site": "none", "sec-fetch-mode": "navigate" }, own, false));
  // Opening the link from ryph: a cross-site top-level navigation.
  assert(
    permitted(
      {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
      own,
      false,
    ),
  );
  // A sibling preview is same-site: its fetches, frames and forms are refused.
  assert(!permitted({ "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" }, own, false));
  assert(
    !permitted(
      { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
      own,
      false,
    ),
  );
  // A foreign page framing it is a navigation, but not a top-level one.
  assert(
    !permitted(
      { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
      own,
      false,
    ),
  );
  assert(
    !permitted({ origin: `https://${"f".repeat(32)}.preview.ryph-previews.example` }, own, false),
  );
  assert(!permitted({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" }, own, false));
  // Upgrades need the preview's own Origin, always.
  assert(permitted({ origin: own, "sec-fetch-site": "same-origin" }, own, true));
  assert(!permitted({}, own, true));
  assert(!permitted({ origin: "https://foreign.example" }, own, true));
});

test("the request gate: an upgrade without Origin only where the caller allows one", () => {
  const options = { originlessUpgrade: true };
  assert(permitted({}, own, true, options));
  // A present Origin is still held to the preview's own, and a cross-site upgrade still refused.
  assert(!permitted({ origin: "https://foreign.example" }, own, true, options));
  assert(
    !permitted(
      { "sec-fetch-site": "cross-site", "sec-fetch-mode": "websocket" },
      own,
      true,
      options,
    ),
  );
  assert(
    !permitted(
      { "sec-fetch-site": "same-site", "sec-fetch-mode": "websocket" },
      own,
      true,
      options,
    ),
  );
});
