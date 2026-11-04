// The S3 patch store against a fake object store: what it SENDS, and how it behaves at the port's
// boundaries. Whether a real S3 accepts the signature is a different question and is answered by
// the compose stack, which runs the forge against MinIO — a fake that checks our own signature
// would only be checking our own arithmetic.

import { test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { s3PatchStore } from "../src/adapters/patch_store/s3.ts";

const quiet = { debug() {}, warn() {} };

const CONFIG = {
  endpoint: "http://objects.internal:9000",
  region: "eu-central-1",
  bucket: "ryph-patches",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  forcePathStyle: true,
};

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array;
}

/** A fake store that records what arrived and answers with whatever the test set. */
function fakeS3(answer: (sent: Sent) => Response = () => new Response(null, { status: 200 })) {
  const sent: Sent[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body === undefined
      ? new Uint8Array()
      : new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
    const record: Sent = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit),
      body,
    };
    sent.push(record);
    return answer(record);
  }) as unknown as typeof fetch;
  return { sent, impl };
}

async function stagedFile(contents: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "ryph-s3-test-")), "staged");
  await writeFile(path, contents);
  return path;
}

test("s3 put sends the staging file, signs it, and consumes it", async () => {
  const fake = fakeS3();
  const store = s3PatchStore({ config: CONFIG, diag: quiet, fetch: fake.impl });
  const staging = await stagedFile("PACK bundle bytes");

  await store.put("patches/r-1/bundle.pack", staging);

  assertEquals(fake.sent.length, 1);
  const [req] = fake.sent;
  assertEquals(req.method, "PUT");
  // Path style, bucket first.
  assertEquals(req.url, "http://objects.internal:9000/ryph-patches/patches/r-1/bundle.pack");
  assertEquals(new TextDecoder().decode(req.body), "PACK bundle bytes");
  // fetch derives content-length from the body — it is a forbidden header, so setting it here
  // would be dropped, and signing it would then produce a 403 nobody can read.
  assert(!req.headers.has("content-length"));
  // The payload hash is the FILE's, which is what SigV4 signs — not the empty-body constant a
  // GET sends. Getting this wrong is a 403 from the store and nothing else.
  assertEquals(
    req.headers.get("x-amz-content-sha256"),
    "4f8681751b02d7b79a3904887791a9f5aa969b09ad74ff71bcbb9041549bcb01",
  );
  assert(req.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/"));
  assert(req.headers.get("authorization")?.includes("SignedHeaders=host;x-amz-content-sha256;"));

  // The port says the source is consumed: the local adapter renames it away, and leaving it here
  // would fill the very disk that moving to object storage was meant to stop mattering.
  assertEquals(
    ((await assertRejects(() => stat(staging))) as NodeJS.ErrnoException).code,
    "ENOENT",
  );
});

test("s3 put signs the host it will actually dial, port included", async () => {
  const fake = fakeS3();
  const store = s3PatchStore({ config: CONFIG, diag: quiet, fetch: fake.impl });
  await store.put("k", await stagedFile("x"));
  // A signature over "objects.internal" while the socket sends "objects.internal:9000" is a 403
  // with no explanation, and it only shows up against a store on a non-default port.
  assertEquals(fake.sent[0].headers.get("host"), "objects.internal:9000");
});

test("s3 put surfaces a rejection with the store's own words", async () => {
  const fake = fakeS3(() =>
    new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })
  );
  const store = s3PatchStore({ config: CONFIG, diag: quiet, fetch: fake.impl });
  const staging = await stagedFile("bytes");
  const err = await assertRejects(() => store.put("k", staging));
  assert(String(err).includes("403"));
  assert(String(err).includes("AccessDenied"));
  await rm(staging).catch(() => {});
});

test("s3 get returns the body unread, and null for a missing key", async () => {
  const fake = fakeS3((sent) =>
    sent.url.endsWith("/present")
      ? new Response("bundle bytes", { status: 200 })
      : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
  );
  const store = s3PatchStore({ config: CONFIG, diag: quiet, fetch: fake.impl });

  const found = await store.get("present");
  assert(found !== null);
  assertEquals(await new Response(found).text(), "bundle bytes");

  // 404 is "no such patch", which the route turns into its own 404 — not an error.
  assertEquals(await store.get("absent"), null);
});

test("s3 get raises anything that is not a 404", async () => {
  const fake = fakeS3(() => new Response("upstream is unwell", { status: 503 }));
  const store = s3PatchStore({ config: CONFIG, diag: quiet, fetch: fake.impl });
  // The definitive-no / could-not-ask split: a 503 must never read as "the patch is gone".
  const err = await assertRejects(() => store.get("k"));
  assert(String(err).includes("503"));
});

test("s3 delete signs a DELETE for the key; gone already is fine, anything else raises", async () => {
  const fake = fakeS3((sent) =>
    sent.url.endsWith("/absent")
      ? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
      : sent.url.endsWith("/broken")
      ? new Response("upstream is unwell", { status: 503 })
      : new Response(null, { status: 204 })
  );
  const store = s3PatchStore({ config: CONFIG, diag: quiet, fetch: fake.impl });

  await store.delete("attachments/r-1/att-1");
  assertEquals(fake.sent[0].method, "DELETE");
  assertEquals(fake.sent[0].url, "http://objects.internal:9000/ryph-patches/attachments/r-1/att-1");
  assert(fake.sent[0].headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 "));
  await store.delete("absent");
  const err = await assertRejects(() => store.delete("broken"));
  assert(String(err).includes("503"));
});

test("a prefix is applied, and each key segment encoded separately", async () => {
  const fake = fakeS3();
  const store = s3PatchStore({
    config: { ...CONFIG, prefix: "/env/prod/" },
    diag: quiet,
    fetch: fake.impl,
  });
  await store.put("patches/r-1/bundle.pack", await stagedFile("x"));
  // Slashes stay slashes: encoding them would address a differently-named flat object than the
  // one a bucket listing shows, and the two would never meet.
  assertEquals(
    fake.sent[0].url,
    "http://objects.internal:9000/ryph-patches/env/prod/patches/r-1/bundle.pack",
  );
});

test("virtual-hosted style puts the bucket in the hostname", async () => {
  const fake = fakeS3();
  const store = s3PatchStore({
    config: {
      ...CONFIG,
      endpoint: "https://s3.eu-central-1.amazonaws.com",
      forcePathStyle: false,
    },
    diag: quiet,
    fetch: fake.impl,
  });
  await store.put("patches/r-1/bundle.pack", await stagedFile("x"));
  assertEquals(
    fake.sent[0].url,
    "https://ryph-patches.s3.eu-central-1.amazonaws.com/patches/r-1/bundle.pack",
  );
  assertEquals(fake.sent[0].headers.get("host"), "ryph-patches.s3.eu-central-1.amazonaws.com");
});

test("a key that could traverse out of the bucket is refused before it is sent", async () => {
  const fake = fakeS3();
  const store = s3PatchStore({ config: CONFIG, diag: quiet, fetch: fake.impl });
  // Same guard as the local adapter's, and belt-and-braces in both: the gateway composes keys
  // from ids it validated, so reaching either check means something upstream already went wrong.
  for (const bad of ["../escape", "patches/../../etc/passwd", "with space", "semi;colon"]) {
    await assertRejects(() => store.get(bad));
  }
  assertEquals(fake.sent.length, 0);
});
