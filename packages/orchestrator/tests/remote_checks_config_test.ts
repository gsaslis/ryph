import { test } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import { remoteChecksConfigFromEnv } from "../src/core/remote_checks_config.ts";

const read = (vars: Record<string, string | undefined>, self: string[] = []) =>
  remoteChecksConfigFromEnv((name) => vars[name], (message) => {
    throw new Error(message);
  }, self);
const pair = (url: string) => ({
  RYPH_CHECKS_REMOTE_URL: url,
  RYPH_CHECKS_REMOTE_TOKEN: "secret-token",
});

test("remote checks are absent by default and require a non-empty pair even when off", () => {
  assertEquals(read({}), null);
  for (
    const vars of [
      { RYPH_CHECKS_REMOTE_URL: "https://checks.example" },
      { RYPH_CHECKS_REMOTE_TOKEN: "secret-token" },
      { ...pair(""), RYPH_CHECKS: "off" },
      { ...pair("https://checks.example"), RYPH_CHECKS_REMOTE_TOKEN: " " },
    ]
  ) assertThrows(() => read(vars), Error, "must be set together");
});

test("remote checks normalize HTTPS and allow only loopback HTTP", () => {
  assertEquals(read(pair(" https://checks.example/prefix/ ")), {
    url: "https://checks.example/prefix",
    token: "secret-token",
  });
  for (const host of ["localhost", "localhost.", "127.0.0.1", "127.1.2.3", "[::1]"]) {
    assertEquals(read(pair(`http://${host}:7411`))?.url, `http://${host}:7411`);
  }
});

test("remote checks refuse unsafe URLs without reflecting credentials", () => {
  for (
    const url of [
      "not-a-url",
      "https:/checks.example",
      "ftp://checks.example",
      "http://checks.example",
      "http://localhost.example",
      "http://0.0.0.0",
      "https://user:secret-token@checks.example",
      "https://checks.example/?token=secret-token",
      "https://checks.example/#secret-token",
      "https://checks.example/?",
      "https://checks.example/#",
      "https://checks.example\\x",
      "https://checks.example/white space",
    ]
  ) {
    const error = assertThrows(() => read(pair(url)), Error, "must be an HTTPS URL");
    assertEquals(error.message.includes("secret-token"), false);
  }
  assertThrows(
    () => read({ ...pair("https://checks.example"), RYPH_CHECKS_REMOTE_TOKEN: "secret\r\nvalue" }),
    Error,
    "visible ASCII",
  );
});

test("remote checks reject own origin including loopback aliases and different paths", () => {
  for (
    const [url, self] of [
      ["https://ryph.example/checks", "https://ryph.example/"],
      ["https://ryph.example:443", "https://ryph.example"],
      ["http://localhost:7411", "http://127.0.0.1:7411"],
      ["http://[::1]:7411", "http://localhost:7411"],
    ]
  ) assertThrows(() => read(pair(url!), [self!]), Error, "must not point to this instance");
  assertEquals(
    read(pair("http://localhost:7412"), ["http://localhost:7411"])?.url,
    "http://localhost:7412",
  );
});
