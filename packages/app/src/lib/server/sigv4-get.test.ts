import { describe, expect, it } from "vitest";
import { signGet } from "./sigv4-get";
// The forge's general signer, checked against AWS's published vectors. The app's image does not
// carry it — that is the whole reason signGet exists — but the repository does, so the two can be
// held against each other here. If they ever disagree, the narrow one is wrong.
import { signRequest } from "../../../../forge/src/helpers/sigv4";

const CREDS = {
  accessKeyId: "GOOG1EEXAMPLEACCESSID",
  secretAccessKey: "bGVzc0V4YW1wbGVTZWNyZXRLZXlOb3RSZWFs",
  region: "auto",
};
const AT = new Date("2026-09-18T20:15:30.000Z");
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const url = (path: string) => new URL(`https://storage.googleapis.com${path}`);

describe("signGet", () => {
  it("agrees with the forge's signer on the same request", async () => {
    const target = url("/acme-assets/_app/immutable/chunks/BndRyUmO.js");

    const mine = await signGet(target, CREDS, AT);
    const theirs = await signRequest(
      {
        method: "GET",
        path: target.pathname,
        query: "",
        headers: { host: target.host, "x-amz-content-sha256": EMPTY_SHA256 },
        payloadHash: EMPTY_SHA256,
      },
      { ...CREDS, service: "s3" },
      AT,
    );

    expect(mine.authorization).toBe(theirs.authorization);
    expect(mine["x-amz-date"]).toBe(theirs["x-amz-date"]);
  });

  it("agrees for a path whose segments need encoding", async () => {
    const target = url("/acme-assets/_app/immutable/assets/font-a%20b.woff2");

    const mine = await signGet(target, CREDS, AT);
    const theirs = await signRequest(
      {
        method: "GET",
        path: target.pathname,
        query: "",
        headers: { host: target.host, "x-amz-content-sha256": EMPTY_SHA256 },
        payloadHash: EMPTY_SHA256,
      },
      { ...CREDS, service: "s3" },
      AT,
    );

    expect(mine.authorization).toBe(theirs.authorization);
  });

  it("scopes the credential to the date, region and s3", async () => {
    const headers = await signGet(url("/b/o.js"), CREDS, AT);
    expect(headers.authorization).toContain(
      `Credential=${CREDS.accessKeyId}/20260918/auto/s3/aws4_request`,
    );
    expect(headers.authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date",
    );
    expect(headers["x-amz-date"]).toBe("20260918T201530Z");
  });

  it("never returns host, which fetch refuses to let a caller set", async () => {
    const headers = await signGet(url("/b/o.js"), CREDS, AT);
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("host");
    expect(headers["x-amz-content-sha256"]).toBe(EMPTY_SHA256);
  });

  it("produces a different signature for a different object", async () => {
    const a = await signGet(url("/b/one.js"), CREDS, AT);
    const b = await signGet(url("/b/two.js"), CREDS, AT);
    expect(a.authorization).not.toBe(b.authorization);
  });
});
