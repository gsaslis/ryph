// The GitHub App's subscriptions against the README's tables: what is missing, at which level,
// and what is merely extra.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  type AppSubscriptions,
  covers,
  describeGap,
  REQUIRED_EVENTS,
  subscriptionReports,
} from "../src/core/app_subscriptions.ts";

const ALL_EVENTS = REQUIRED_EVENTS.map((e) => e.name);
const ALL_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  metadata: "read",
  checks: "write",
  statuses: "read",
  members: "read",
  email_addresses: "read",
};

/** An App with everything, and one org installation that accepted all of it. */
function complete(): AppSubscriptions {
  return {
    app: { events: [...ALL_EVENTS], permissions: { ...ALL_PERMISSIONS } },
    installations: [{
      id: "7",
      account: "acme",
      accountType: "Organization",
      events: [...ALL_EVENTS],
      // An installation never lists account permissions: those are the App's alone.
      permissions: Object.fromEntries(
        Object.entries(ALL_PERMISSIONS).filter(([name]) => name !== "email_addresses"),
      ),
    }],
  };
}

test("an App with everything, accepted everywhere, reports nothing", () => {
  const subs = complete();
  assertEquals(subscriptionReports(subs), []);
});

test("a missing push on the App is a required gap, reported once under app", () => {
  const subs = complete();
  subs.app.events = subs.app.events.filter((e) => e !== "push");
  subs.installations[0].events = subs.installations[0].events.filter((e) => e !== "push");
  const reports = subscriptionReports(subs);
  assertEquals(reports.length, 1);
  assertEquals(reports[0].scope, "app");
  assertEquals(reports[0].gaps.map((g) => [g.kind, g.name, g.required]), [
    ["event", "push", true],
  ]);
});

test("what the App has and an installation lacks is that installation's gap", () => {
  const subs = complete();
  subs.installations[0].permissions.checks = "read";
  subs.installations[0].events = subs.installations[0].events.filter((e) => e !== "check_run");
  const reports = subscriptionReports(subs);
  assertEquals(reports.map((r) => r.scope), ["installation 7 (acme)"]);
  assertEquals(reports[0].gaps.map((g) => [g.name, g.required, g.have ?? null]), [
    ["check_run", true, null],
    ["checks", false, "read"],
  ]);
});

test("a lower level is a gap, a higher one covers", () => {
  assertEquals(covers("read", "write"), false);
  assertEquals(covers("write", "write"), true);
  assertEquals(covers("admin", "read"), true);
  assertEquals(covers(undefined, "read"), false);
  assertEquals(covers("bogus", "read"), false);

  const subs = complete();
  subs.app.permissions.contents = "read";
  subs.app.permissions.issues = "admin";
  const [app] = subscriptionReports(subs).filter((r) => r.scope === "app");
  assertEquals(app.gaps.map((g) => describeGap(g)), [
    "contents: write (has read) — fetching bases and pushing a run's branch",
  ]);
});

test("extra events are listed on the App only, never as a gap", () => {
  const subs = complete();
  subs.app.events.push("pull_request_review", "pull_request_review_thread");
  subs.installations[0].events.push("pull_request_review");
  assertEquals(subscriptionReports(subs), [{
    scope: "app",
    gaps: [],
    extraEvents: ["pull_request_review", "pull_request_review_thread"],
  }]);
});

test("an org permission is not asked of a personal installation", () => {
  const subs = complete();
  subs.installations = [{
    id: "8",
    account: "ada",
    accountType: "User",
    events: [...ALL_EVENTS],
    permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
  }];
  const reports = subscriptionReports(subs);
  assertEquals(reports.length, 1);
  assertEquals(reports[0].gaps.map((g) => g.name), ["checks", "statuses"]);
  assertEquals(reports[0].gaps.every((g) => !g.required), true);
});
