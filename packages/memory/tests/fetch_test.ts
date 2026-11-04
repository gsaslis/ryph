// The fetchers: the URL fetcher's refusals (private addresses, redirects, size) and its HTML
// to text; the repo-file locator and the raw-URL rule.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { ConversionRefusedError } from "@ryph/web";
import { urlFetcher } from "../src/adapters/fetch/url.ts";
import {
  parseRepoFileLocator,
  rawUrlFor,
  repoFileFetcher,
} from "../src/adapters/fetch/repo_file.ts";
import { FetchRefusedError } from "../src/ports/fetcher.ts";

test("a bracketed mapped literal is refused before any fetch", async () => {
  let fetched = 0;
  const fetcher = urlFetcher({
    resolve: () => Promise.resolve(["93.184.216.34"]),
    fetch: (() => {
      fetched += 1;
      return Promise.resolve(new Response("x"));
    }) as unknown as typeof fetch,
  });
  for (
    const url of [
      "https://[::ffff:a9fe:a9fe]/computeMetadata/v1/",
      "https://[::ffff:10.0.0.1]/",
      "https://0xa9fea9fe/",
      "https://2852039166/",
    ]
  ) {
    await assertRejects(() => fetcher.fetch(url), FetchRefusedError, "non-public");
  }
  for (
    const url of [
      "https://[::ffff:7f00:1]/internal/v1/x",
      "https://[::ffff:127.0.0.1]/",
      "https://0x7f000001/",
      "https://2130706433/",
    ]
  ) {
    await assertRejects(() => fetcher.fetch(url), FetchRefusedError, "loopback");
  }
  assertEquals(fetched, 0);
});

test("a body that streams past the cap is refused, content-length or not", async () => {
  const fetcher = urlFetcher({
    resolve: () => Promise.resolve(["93.184.216.34"]),
    fetch: (() => {
      const chunk = new TextEncoder().encode("y".repeat(400));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 5; i++) controller.enqueue(chunk);
          controller.close();
        },
      });
      return Promise.resolve(new Response(body, { headers: { "content-type": "text/plain" } }));
    }) as unknown as typeof fetch,
    maxBytes: 1_000,
  });
  await assertRejects(
    () => fetcher.fetch("https://docs.example/stream"),
    FetchRefusedError,
    "over",
  );
});

test("the URL fetcher refuses what it must and fetches what it may", async () => {
  const fetched: string[] = [];
  const fetcher = urlFetcher({
    resolve: (host) => Promise.resolve(host === "docs.example" ? ["93.184.216.34"] : ["10.0.0.5"]),
    fetch: ((input: URL | Request | string) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      if (url.endsWith("/redirect")) {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: "https://docs.example/b" } }),
        );
      }
      if (url.endsWith("/big")) {
        return Promise.resolve(
          new Response("x".repeat(2_000), { headers: { "content-length": "2000" } }),
        );
      }
      return Promise.resolve(
        new Response(
          "<html><head><title>Guide</title></head><body><h1>Deploy</h1><p>Run <b>it</b>.</p><script>x()</script></body></html>",
          {
            headers: { "content-type": "text/html" },
          },
        ),
      );
    }) as unknown as typeof fetch,
    maxBytes: 1_000,
  });
  // web__fetch's rule, word for word: the same function judges both.
  await assertRejects(() => fetcher.fetch("not a url"), FetchRefusedError, "not a valid");
  await assertRejects(() => fetcher.fetch("ftp://docs.example/x"), FetchRefusedError, "http(s)");
  await assertRejects(() => fetcher.fetch("http://docs.example/x"), FetchRefusedError, "https");
  await assertRejects(
    () => fetcher.fetch("https://docs.example:8443/x"),
    FetchRefusedError,
    "port",
  );
  await assertRejects(
    () => fetcher.fetch("https://user:pw@docs.example/x"),
    FetchRefusedError,
    "username or password",
  );
  await assertRejects(() => fetcher.fetch("https://localhost/x"), FetchRefusedError, "loopback");
  await assertRejects(
    () => fetcher.fetch("https://memory.internal/x"),
    FetchRefusedError,
    "non-public",
  );
  await assertRejects(
    () => fetcher.fetch("https://169.254.169.254/latest"),
    FetchRefusedError,
    "non-public",
  );
  await assertRejects(
    () => fetcher.fetch("https://intranet.example/x"),
    FetchRefusedError,
    "non-public",
  );
  assertEquals(fetched, [], "nothing was fetched before the checks passed");
  await assertRejects(
    () => fetcher.fetch("https://docs.example/redirect"),
    FetchRefusedError,
    "redirects",
  );
  await assertRejects(
    () => fetcher.fetch("https://docs.example/big"),
    FetchRefusedError,
    "over 1000 bytes",
  );
  const doc = await fetcher.fetch("https://docs.example/guide");
  assertEquals(doc.title, "Guide");
  assertEquals(doc.text, "Guide\n\n# Deploy\nRun it.");
});

test("a hostile page converts in the worker without holding the event loop", async () => {
  // An unclosed `<` and a `<script` with no end: the shapes that took the old main-thread regexes
  // 5 s at 200 KB and minutes at the 2 MiB cap, while heartbeats and the API waited.
  for (const html of ["<".repeat(200_000), "<script".repeat(30_000), "<".repeat(2 * 1024 * 1024)]) {
    const fetcher = urlFetcher({
      resolve: () => Promise.resolve(["93.184.216.34"]),
      fetch: (() =>
        Promise.resolve(
          new Response(html, { headers: { "content-type": "text/html" } }),
        )) as unknown as typeof fetch,
    });
    let ticks = 0;
    const timer = setInterval(() => ticks += 1, 5);
    const started = performance.now();
    try {
      const doc = await fetcher.fetch("https://docs.example/hostile");
      assertEquals(doc.title, "hostile");
    } finally {
      clearInterval(timer);
      fetcher.close();
    }
    const took = performance.now() - started;
    assert(took < 2_000, `${Math.round(took)} ms`);
    assert(ticks > 0, "the event loop kept turning while the page converted");
  }
});

test("a conversion the converter refuses is a refusal the ingest shows", async () => {
  const fetcher = urlFetcher({
    resolve: () => Promise.resolve(["93.184.216.34"]),
    fetch: (() =>
      Promise.resolve(
        new Response("<p>x</p>", { headers: { "content-type": "text/html" } }),
      )) as unknown as typeof fetch,
    converter: {
      convert: () => Promise.reject(new ConversionRefusedError("that page took too long")),
      close: () => {},
    },
  });
  await assertRejects(
    () => fetcher.fetch("https://docs.example/slow"),
    FetchRefusedError,
    "took too long",
  );
});

test("repo-file locators parse, map to raw URLs on github and gitlab, and refuse traversal", async () => {
  assertEquals(parseRepoFileLocator("https://GitHub.com/Acme/App.git@main:docs/setup.md"), {
    repo: "github.com/acme/app",
    address: "github.com/Acme/App",
    ref: "main",
    path: "docs/setup.md",
  });
  assertEquals(parseRepoFileLocator("github.com/acme/app@main:../etc/passwd"), null);
  assertEquals(parseRepoFileLocator("no-at-sign"), null);
  assertEquals(
    rawUrlFor("github.com/acme/app", "v1.2", "docs/a b.md"),
    "https://raw.githubusercontent.com/acme/app/v1.2/docs/a%20b.md",
  );
  assertEquals(rawUrlFor("bitbucket.org/acme/app", "main", "x"), null);

  const fetcher = repoFileFetcher({
    fetch: ((input: URL | Request | string) =>
      Promise.resolve(
        String(input).endsWith("/README.md")
          ? new Response("# Hi\n")
          : new Response("", { status: 404 }),
      )) as unknown as typeof fetch,
  });
  const doc = await fetcher.fetch("https://github.com/acme/app@main:README.md");
  assertEquals(doc, { title: "github.com/acme/app: README.md @ main", text: "# Hi\n" });
  await assertRejects(
    () => fetcher.fetch("https://github.com/acme/app@main:nope.md"),
    FetchRefusedError,
    "private",
  );
  await assertRejects(
    () => fetcher.fetch("https://bitbucket.org/acme/app@main:README.md"),
    FetchRefusedError,
    "github.com, gitlab.com",
  );
});

test("gitlab raw URLs: nested groups, gitlab.com by default, the deployment's instance when named", () => {
  assertEquals(
    rawUrlFor("gitlab.com/acme/app", "main", "docs/a b.md"),
    "https://gitlab.com/acme/app/-/raw/main/docs/a%20b.md",
  );
  // Groups nest: everything below the host is the project path.
  assertEquals(
    rawUrlFor("gitlab.com/acme/platform/infra/app", "v1.2", "README.md"),
    "https://gitlab.com/acme/platform/infra/app/-/raw/v1.2/README.md",
  );
  // A ref with a slash is one encoded segment, as on GitHub.
  assertEquals(
    rawUrlFor("gitlab.com/acme/app", "feature/x", "a.md"),
    "https://gitlab.com/acme/app/-/raw/feature%2Fx/a.md",
  );
  // A bare namespace is not a project; neither is a path deeper than GitLab's 20 levels.
  assertEquals(rawUrlFor("gitlab.com/acme", "main", "a.md"), null);
  const deep = Array.from({ length: 21 }, (_, i) => `g${i}`).join("/");
  assertEquals(rawUrlFor(`gitlab.com/${deep}`, "main", "a.md"), null);
  // `-` is GitLab's route separator and `..` a climb: neither is a segment.
  assertEquals(rawUrlFor("gitlab.com/acme/-/app", "main", "a.md"), null);
  assertEquals(rawUrlFor("gitlab.com/acme/../app", "main", "a.md"), null);

  // A self-managed instance is read only where it is named, with its own scheme and prefix.
  assertEquals(rawUrlFor("git.example.com/acme/app", "main", "a.md"), null);
  const instances = ["https://gitlab.com", "http://Git.Example.com:8080/gitlab/"];
  assertEquals(
    rawUrlFor("git.example.com:8080/gitlab/acme/sub/app", "main", "a.md", instances),
    "http://git.example.com:8080/gitlab/acme/sub/app/-/raw/main/a.md",
  );
  // The prefix is the instance's, not a group: the same host without it is another address.
  assertEquals(rawUrlFor("git.example.com:8080/acme/app", "main", "a.md", instances), null);
  assertEquals(
    rawUrlFor("gitlab.com/acme/app", "main", "a.md", instances),
    "https://gitlab.com/acme/app/-/raw/main/a.md",
  );
});

test("the repo-file fetcher reads the deployment's GitLab and refuses a sign-in redirect", async () => {
  const seen: string[] = [];
  const fetcher = repoFileFetcher({
    gitlabUrl: "https://git.example.com",
    fetch: ((input: URL | Request | string) => {
      seen.push(String(input));
      return Promise.resolve(
        String(input).includes("/private/")
          ? new Response("", { status: 302, headers: { location: "/users/sign_in" } })
          : new Response("# Hi\n"),
      );
    }) as unknown as typeof fetch,
  });
  const doc = await fetcher.fetch("https://git.example.com/Acme/Sub/App.git@main:README.md");
  // The title names the canonical repository; the fetch keeps the path's case, which GitLab
  // reads case-sensitively (a lower-cased path is redirected, and a redirect is refused).
  assertEquals(doc, { title: "git.example.com/acme/sub/app: README.md @ main", text: "# Hi\n" });
  assertEquals(seen, ["https://git.example.com/Acme/Sub/App/-/raw/main/README.md"]);
  await assertRejects(
    () => fetcher.fetch("https://git.example.com/acme/private@main:README.md"),
    FetchRefusedError,
    "private repository",
  );
  await assertRejects(
    () => fetcher.fetch("https://other.example.com/acme/app@main:README.md"),
    FetchRefusedError,
    "github.com, gitlab.com, git.example.com",
  );
});

test("a project path spelt in the wrong case is refused with GitLab's spelling, not as private", async () => {
  // gitlab.com answers /calcprogrammer1/openrgb/-/raw/… with a 301 to /CalcProgrammer1/OpenRGB/….
  const seen: string[] = [];
  const fetcher = repoFileFetcher({
    fetch: ((input: URL | Request | string) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith("https://gitlab.com/CalcProgrammer1/OpenRGB/")) {
        return Promise.resolve(new Response("# OpenRGB\n"));
      }
      if (url.toLowerCase().startsWith("https://gitlab.com/calcprogrammer1/openrgb/")) {
        const location = url.replace(/calcprogrammer1\/openrgb/i, "CalcProgrammer1/OpenRGB");
        return Promise.resolve(new Response("", { status: 301, headers: { location } }));
      }
      if (url.includes("/acme/private/")) {
        return Promise.resolve(
          new Response("", {
            status: 302,
            headers: { location: "https://gitlab.com/users/sign_in" },
          }),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    }) as unknown as typeof fetch,
  });
  const doc = await fetcher.fetch("https://gitlab.com/CalcProgrammer1/OpenRGB@master:README.md");
  assertEquals(doc.text, "# OpenRGB\n");
  assertEquals(doc.title, "gitlab.com/calcprogrammer1/openrgb: README.md @ master");
  await assertRejects(
    () => fetcher.fetch("https://gitlab.com/calcprogrammer1/openrgb@master:README.md"),
    FetchRefusedError,
    "names this repository gitlab.com/CalcProgrammer1/OpenRGB",
  );
  // The redirect is named, never followed.
  assertEquals(seen, [
    "https://gitlab.com/CalcProgrammer1/OpenRGB/-/raw/master/README.md",
    "https://gitlab.com/calcprogrammer1/openrgb/-/raw/master/README.md",
  ]);
  // A redirect elsewhere (a private project's sign-in page) is still refused as one.
  await assertRejects(
    () => fetcher.fetch("https://gitlab.com/acme/private@main:README.md"),
    FetchRefusedError,
    "private repository",
  );
});
