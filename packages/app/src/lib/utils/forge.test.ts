import { describe, expect, it } from "vitest";
import {
  changeRequestNoun,
  deliveredAs,
  forgeRepoLabel,
  isDid,
  isRid,
  localRepoName,
  providerOfRepoRef,
  providerOfThread,
  reposReach,
  repoThreadLabel,
  shortenDid,
  shortenRid,
  subjectLabel,
  threadLabel,
} from "./forge";

const RID = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";

describe("isRid", () => {
  it("takes a rad: address in base58btc", () => {
    expect(isRid(RID)).toBe(true);
    expect(isRid(`  ${RID}  `)).toBe(true);
  });

  it("refuses anything else", () => {
    // The base58btc alphabet has no 0, O, I or l — a typo'd RID is caught before the round trip.
    expect(isRid("rad:z0OIl")).toBe(false);
    expect(isRid("rad:3gqcJUo")).toBe(false);
    expect(isRid("acme/app")).toBe(false);
    expect(isRid("")).toBe(false);
  });
});

describe("isDid", () => {
  it("takes a did:key", () => {
    expect(isDid("did:key:z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM")).toBe(true);
  });

  it("refuses a bare NID or another DID method", () => {
    expect(isDid("z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM")).toBe(false);
    expect(isDid("did:web:example.com")).toBe(false);
  });
});

describe("providerOfRepoRef", () => {
  it("reads the forge off the address", () => {
    expect(providerOfRepoRef(RID)).toBe("radicle");
    expect(providerOfRepoRef("acme/app")).toBe("github");
    expect(providerOfRepoRef("/home/ada/app")).toBe("local");
    // A GitLab path reads as GitHub's `owner/name`: a GitLab row must carry its provider.
    expect(providerOfRepoRef("acme/web/app")).not.toBe("gitlab");
  });
});

describe("providerOfThread", () => {
  it("tells a number, an object id and a branch name apart", () => {
    expect(providerOfThread("12")).toBe("github");
    expect(providerOfThread("abc1234def5678900000000000000000000000ff")).toBe("radicle");
    expect(providerOfThread("abc1234")).toBe("radicle");
    expect(providerOfThread("ryph/fix-login")).toBe("local");
    expect(providerOfThread("mr-7")).not.toBe("gitlab");
    expect(providerOfThread("issue-12")).not.toBe("gitlab");
  });
});

describe("localRepoName", () => {
  it("is the folder's own name", () => {
    expect(localRepoName("/home/ada/code/app")).toBe("app");
    expect(localRepoName("/home/ada/code/app/")).toBe("app");
    expect(localRepoName("/")).toBe("/");
  });
});

describe("reposReach", () => {
  it("says how repos reach agents for each mix of providers", () => {
    expect(reposReach(["github"], false)).toBe("through the GitHub App");
    expect(reposReach(["radicle"], false)).toBe("through Ryph's Radicle node");
    expect(reposReach(["github", "radicle"], false)).toBe(
      "through the GitHub App or Ryph's Radicle node",
    );
    expect(reposReach(["local"], false)).toBe("on this machine");
    expect(reposReach(["github", "local"], false)).toBe(
      "through the GitHub App, or on this machine",
    );
  });

  it("names GitLab among the forges", () => {
    expect(reposReach(["gitlab"], false)).toBe("through GitLab");
    expect(reposReach(["github", "gitlab", "radicle", "local"], false)).toBe(
      "through the GitHub App, GitLab or Ryph's Radicle node, or on this machine",
    );
  });

  it("names no App in GitHub user mode", () => {
    expect(reposReach(["github"], true)).toBe("through GitHub");
    expect(reposReach(["github", "local"], true)).toBe("through GitHub, or on this machine");
    expect(reposReach(["radicle", "local"], true, true)).toBe(
      "through this machine's Radicle node, or on this machine",
    );
  });
});

describe("deliveredAs", () => {
  it("lists what work becomes", () => {
    expect(deliveredAs(["github"])).toBe("pull requests");
    expect(deliveredAs(["github", "radicle"])).toBe("pull requests and patches");
    expect(deliveredAs(["github", "radicle", "local"])).toBe(
      "pull requests, patches and branches",
    );
    expect(deliveredAs(["gitlab", "local"])).toBe("merge requests and branches");
  });

  it("falls back to changes when no provider is known", () => {
    expect(deliveredAs([])).toBe("changes");
  });
});

describe("shortening", () => {
  it("keeps the ends of a RID and drops the middle", () => {
    expect(shortenRid(RID)).toBe("rad:z3gq…azv5");
  });

  it("leaves a short value alone", () => {
    expect(shortenRid("rad:z3gq")).toBe("rad:z3gq");
    expect(shortenDid("did:key:z6Mk")).toBe("did:key:z6Mk");
  });

  it("shortens a DID from its distinctive front", () => {
    expect(shortenDid("did:key:z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM"))
      .toBe("did:key:z6MkireR…3voM");
  });

  it("is the subject as given on a local repo, which has no identities", () => {
    expect(subjectLabel("local", "ada")).toBe("ada");
  });
});

describe("forgeRepoLabel", () => {
  it("uses the address itself on GitHub", () => {
    expect(forgeRepoLabel({ provider: "github", repoRef: "acme/app" })).toBe("acme/app");
  });

  it("names a Radicle repo when the forge gave a name, and shortens the RID either way", () => {
    expect(forgeRepoLabel({ provider: "radicle", repoRef: RID, name: "heartwood" })).toBe(
      `heartwood (${shortenRid(RID)})`,
    );
    expect(forgeRepoLabel({ provider: "radicle", repoRef: RID, name: null })).toBe(shortenRid(RID));
  });

  it("uses the nested path on GitLab", () => {
    expect(forgeRepoLabel({ provider: "gitlab", repoRef: "acme/web/app" })).toBe("acme/web/app");
  });

  it("uses the path on a local repo", () => {
    expect(forgeRepoLabel({ provider: "local", repoRef: "/home/ada/app" })).toBe("/home/ada/app");
  });
});

describe("threadLabel", () => {
  it("numbers a GitHub thread and prefixes a Radicle one", () => {
    expect(threadLabel("github", "issue", "12")).toBe("#12");
    expect(threadLabel("github", "change_request", "12")).toBe("#12");
    expect(threadLabel("radicle", null, "abc1234def5678900000000000000000000000ff")).toBe(
      "abc1234",
    );
  });

  it("writes a GitLab issue as #12 and a merge request as !7", () => {
    expect(threadLabel("gitlab", "issue", "issue-12")).toBe("#12");
    expect(threadLabel("gitlab", "change_request", "mr-7")).toBe("!7");
    // The ref spells its own kind; the caller's is the fallback for a bare number only.
    expect(threadLabel("gitlab", null, "mr-7")).toBe("!7");
    expect(threadLabel("gitlab", "change_request", "7")).toBe("!7");
    expect(threadLabel("gitlab", "issue", "12")).toBe("#12");
    expect(threadLabel("gitlab", null, "12")).toBe("12");
  });

  it("names a local delivery as the branch it is", () => {
    expect(threadLabel("local", null, "ryph/fix-login")).toBe("branch ryph/fix-login");
  });

  it("leaves a thread already given as a prefix alone", () => {
    expect(threadLabel("radicle", null, "abc1234")).toBe("abc1234");
  });
});

describe("repoThreadLabel", () => {
  it("joins the two the way each forge writes them", () => {
    expect(repoThreadLabel({ provider: "github", repoRef: "acme/app" }, null, "12")).toBe(
      "acme/app#12",
    );
    expect(repoThreadLabel({ provider: "gitlab", repoRef: "acme/web/app" }, null, "mr-7")).toBe(
      "acme/web/app!7",
    );
    expect(repoThreadLabel({ provider: "gitlab", repoRef: "acme/app" }, "issue", "issue-12"))
      .toBe("acme/app#12");
    expect(
      repoThreadLabel(
        { provider: "radicle", repoRef: RID, name: "heartwood" },
        "change_request",
        "abc1234def5678900000000000000000000000ff",
      ),
    ).toBe(`heartwood (${shortenRid(RID)}) abc1234`);
    expect(repoThreadLabel({ provider: "local", repoRef: "/home/ada/app" }, null, "ryph/x")).toBe(
      "/home/ada/app branch ryph/x",
    );
  });
});

describe("subjectLabel", () => {
  it("is a login on GitHub and GitLab and a shortened DID on Radicle", () => {
    expect(subjectLabel("github", "ada")).toBe("@ada");
    expect(subjectLabel("gitlab", "ada")).toBe("@ada");
    expect(subjectLabel("radicle", "did:key:z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM"))
      .toBe("did:key:z6MkireR…3voM");
  });

  it("is the subject as given on a local repo, which has no identities", () => {
    expect(subjectLabel("local", "ada")).toBe("ada");
  });
});

describe("changeRequestNoun", () => {
  it("calls a change request what its forge calls it", () => {
    expect(changeRequestNoun("github")).toBe("pull request");
    expect(changeRequestNoun("gitlab")).toBe("merge request");
    expect(changeRequestNoun("radicle")).toBe("patch");
    expect(changeRequestNoun("local")).toBe("branch");
  });
});
