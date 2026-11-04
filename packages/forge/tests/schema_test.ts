// The ingest boundary refuses what it must: unknown keys, unbounded strings, refs git would
// choke on — and passes the one payload the key resolve actually carries.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  isRepoRef,
  MAX_REVIEW_REMARKS,
  OAuthExchangeSchema,
  OrgMembershipRequestSchema,
  RunGrantSchema,
  SubmitReviewArgsSchema,
} from "../src/schema.ts";
import { MAX_BODY_BYTES } from "../src/http/tools.ts";

const MEMBER = {
  connectedRepoId: "cr-1",
  provider: "github" as const,
  repoRef: "acme/app",
  url: "https://example.com/repo.git",
  ref: "main",
  branchNamespace: "ryph/ada/r-3f9a0c12e4",
  tenantId: "161110166",
};
const GOOD = { runId: "r-3f9a0c12e4", repos: [MEMBER] };

test("the largest review the schema calls legal still fits what the surface will read", () => {
  // Otherwise the refusal is an HTTP 413 — a status, not a tool answer — so the model cannot
  // read why, and its natural next move is to send the same oversized review again.
  const remark = (body: string) => ({ path: "src/scheduler.ts", line: 3, body });
  const review = (over: Record<string, unknown>) =>
    SubmitReviewArgsSchema.safeParse({ repo: "acme/app", thread: "9", body: "ok", ...over });

  assert(review({ comments: [remark("x".repeat(4_096))] }).success);
  assertEquals(review({ comments: [remark("x".repeat(4_097))] }).success, false);

  const biggest = JSON.stringify({
    repo: "acme/app",
    thread: "9",
    body: "y".repeat(16_384),
    comments: Array.from({ length: MAX_REVIEW_REMARKS }, () => remark("x".repeat(4_096))),
  });
  assert(review(JSON.parse(biggest)).success, "and it is legal");
  const size = new TextEncoder().encode(biggest).byteLength;
  assert(size < MAX_BODY_BYTES, `${size} bytes must fit under ${MAX_BODY_BYTES}`);
});

test("accepts the grant the orchestrator answers with", () => {
  const parsed = RunGrantSchema.safeParse(GOOD);
  assert(parsed.success);
  assertEquals(parsed.data, GOOD);
});

test("a null tenant is an anonymous fetch, not a rejected grant", () => {
  const parsed = RunGrantSchema.safeParse({ ...GOOD, repos: [{ ...MEMBER, tenantId: null }] });
  assert(parsed.success);
  assertEquals(parsed.data.repos[0].tenantId, null);
});

test("a tenant id can never walk out of the API path it is interpolated into", () => {
  // It reaches `/app/installations/<id>/access_tokens` — anything but digits could steer it.
  for (const tenantId of ["../../repos/acme/app", "1/2", "abc", "", "1 2", "-1"]) {
    assert(
      !RunGrantSchema.safeParse({ ...GOOD, repos: [{ ...MEMBER, tenantId }] }).success,
      tenantId,
    );
  }
});

test("refuses unknown keys rather than passing them through", () => {
  assert(!RunGrantSchema.safeParse({ ...GOOD, extra: "smuggled" }).success);
  assert(
    !RunGrantSchema.safeParse({ ...GOOD, repos: [{ ...MEMBER, installation: 7 }] }).success,
  );
});

test("refuses refs git refuses, and flag-shaped values", () => {
  for (const ref of ["-rf", "a..b", "a b", "x.lock", "end/"]) {
    assert(!RunGrantSchema.safeParse({ ...GOOD, repos: [{ ...MEMBER, ref }] }).success, ref);
  }
  assert(
    !RunGrantSchema.safeParse({ ...GOOD, repos: [{ ...MEMBER, branchNamespace: "-evil" }] })
      .success,
  );
});

test("a grant names at least one repo, and each one once", () => {
  assert(!RunGrantSchema.safeParse({ ...GOOD, repos: [] }).success);
  assert(!RunGrantSchema.safeParse({ ...GOOD, repos: [MEMBER, MEMBER] }).success);
  assert(
    RunGrantSchema.safeParse({ ...GOOD, repos: [MEMBER, { ...MEMBER, connectedRepoId: "cr-2" }] })
      .success,
  );
});

test("a check candidate is a bundle's head or a forge's, never both", () => {
  const sha = "a".repeat(40);
  const withCandidate = (candidate: unknown) =>
    RunGrantSchema.safeParse({ ...GOOD, repos: [{ ...MEMBER, candidate }] }).success;
  const branchName = "ryph/ada/r-a/work";
  assert(withCandidate({ headSha: sha, branchName, bundleKey: `r-a/cr-1/${sha}.bundle` }));
  assert(withCandidate({ headSha: sha, branchName, fetchRef: "refs/pull/42/head" }));
  assert(withCandidate({ headSha: sha, branchName, fetchRef: null }));
  assert(
    !withCandidate({ headSha: sha, branchName }),
    "a forge candidate says whether it has a ref",
  );
  assert(
    !withCandidate({ headSha: sha, fetchRef: null }),
    "a candidate names the branch it is served as",
  );
  assert(
    !withCandidate({
      headSha: sha,
      branchName,
      bundleKey: `r-a/cr-1/${sha}.bundle`,
      fetchRef: null,
    }),
  );
  for (const fetchRef of ["pull/42/head", "refs/tags/v1", "refs/pull/../head", "-x"]) {
    assert(!withCandidate({ headSha: sha, branchName, fetchRef }), fetchRef);
  }
});

test("a GitLab address is a nested path that cannot walk the API path it rides", () => {
  assert(isRepoRef("gitlab", "group/project"));
  assert(isRepoRef("gitlab", "group/sub/deeper/project.js"));
  assert(!isRepoRef("gitlab", "project"), "a project lives in a namespace");
  assert(!isRepoRef("gitlab", "group/../project"));
  assert(!isRepoRef("gitlab", "group/./project"));
  assert(!isRepoRef("gitlab", "group//project"));
  assert(!isRepoRef("gitlab", `${"a/".repeat(20)}b`), "at most 20 segments");
  assert(isRepoRef("gitlab", `${"a".repeat(240)}/project`), "up to 255 characters");
  assert(!isRepoRef("gitlab", `${"a".repeat(250)}/project`));
});

test("an OAuth exchange names its forge, and a GitLab one its redirect URI", () => {
  assert(OAuthExchangeSchema.safeParse({ provider: "github", code: "c" }).success);
  assert(!OAuthExchangeSchema.safeParse({ code: "c" }).success);
  assert(!OAuthExchangeSchema.safeParse({ provider: "gitlab", code: "c" }).success);
  assert(
    OAuthExchangeSchema.safeParse({
      provider: "gitlab",
      code: "c",
      redirectUri: "https://ryph.example/gitlab/callback",
      codeVerifier: "a".repeat(43),
    }).success,
  );
});

test("a GitHub membership question needs its installation; a GitLab one has none", () => {
  assert(
    OrgMembershipRequestSchema.safeParse({ provider: "github", installationId: "1", login: "a" })
      .success,
  );
  assert(!OrgMembershipRequestSchema.safeParse({ provider: "github", login: "a" }).success);
  // GitLab's is asked about an account id on an instance, never a username.
  assert(
    OrgMembershipRequestSchema.safeParse({
      provider: "gitlab",
      accountId: "1001@https://gitlab.example",
    }).success,
  );
  assert(!OrgMembershipRequestSchema.safeParse({ provider: "gitlab", login: "grace.h" }).success);
  assert(!OrgMembershipRequestSchema.safeParse({ provider: "gitlab", accountId: "1001" }).success);
  assert(
    !OrgMembershipRequestSchema.safeParse({
      provider: "github",
      installationId: "1",
      accountId: "1@x",
    })
      .success,
  );
});
