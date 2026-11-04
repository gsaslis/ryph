// The single-user owner a first boot creates from git. Its address has to pass @ryph/auth's own
// check, or the account page meant to change it could never be saved.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { z } from "@zod/zod";
import {
  appUrlFromEnv,
  describeBinds,
  DEV_APP_URL,
  ownerFromGit,
  ownerLockout,
  ownerLoginLink,
  PLACEHOLDER_OWNER_EMAIL,
} from "../src/main.ts";

test("git's address and name are the owner's when auth would accept the address", () => {
  assertEquals(ownerFromGit("ada@example.com", "Ada"), { email: "ada@example.com", name: "Ada" });
});

test("an address auth would refuse, or none, falls back to a placeholder it accepts", () => {
  assert(z.email().safeParse(PLACEHOLDER_OWNER_EMAIL).success);
  for (const email of [null, "ada@localhost", "ada@laptop", "not an address"]) {
    assertEquals(ownerFromGit(email, null), { email: PLACEHOLDER_OWNER_EMAIL, name: "Owner" });
  }
});

/** An auth surface whose owner exists from the start or only once ensured. */
function fakeAuth(ownerExists: boolean) {
  let owner = ownerExists;
  const calls: string[] = [];
  return {
    calls,
    auth: {
      ensureOwner: (d: { email: string; name: string }) => {
        calls.push(`ensure ${d.email}`);
        owner = true;
        return Promise.resolve({ id: "u_1" } as never);
      },
      mintLoginLink: (fallback?: string | null) => {
        calls.push(`mint on ${fallback}`);
        return Promise.resolve(
          owner
            ? { ok: true as const, link: "http://localhost:5173/login/t" }
            : { ok: false as const, error: "not-found" as const },
        );
      },
    },
  };
}

test("an existing owner gets a link without git being asked for defaults", async () => {
  const { auth, calls } = fakeAuth(true);
  let asked = 0;
  const defaults = () => (asked++, Promise.resolve({ email: "a@example.com", name: "A" }));
  assertEquals((await ownerLoginLink(auth, defaults)).ok, true);
  assertEquals(asked, 0);
  assertEquals(calls, [`mint on ${DEV_APP_URL}`]);
});

test("an empty instance makes its owner from the defaults, then mints", async () => {
  const { auth, calls } = fakeAuth(false);
  const defaults = () => Promise.resolve({ email: "a@example.com", name: "A" });
  assertEquals((await ownerLoginLink(auth, defaults)).ok, true);
  assertEquals(calls, [
    `mint on ${DEV_APP_URL}`,
    "ensure a@example.com",
    `mint on ${DEV_APP_URL}`,
  ]);
});

test("RYPH_APP_URL unset stays unset; only the boot link falls back to ./dev's app", () => {
  // The fallback rides on the mint (above), never on the app URL the rest of auth, run links
  // and the Host check see.
  assertEquals(appUrlFromEnv(undefined), null);
  assertEquals(appUrlFromEnv(" "), null);
  assertEquals(appUrlFromEnv("https://ryph.example/"), "https://ryph.example");
});

test("multi-user refuses to boot when no owner can sign in without a login link", async () => {
  const auth = (emails: string[] | null) => ({
    ownerSignInEmails: () => Promise.resolve(emails),
  });
  assertEquals(await ownerLockout(auth(["ada@example.com"]), true), null);
  assertEquals(await ownerLockout(auth([]), false), null);
  const refused = await ownerLockout(auth([]), true);
  assert(refused !== null && refused.includes("set a password on the account page"), refused!);
  // An instance with nobody yet is claimed by the setup token.
  assertEquals(await ownerLockout(auth(null), true), null);
});

test("multi-user refuses to boot while every owner who can sign in has the placeholder address", async () => {
  const auth = (emails: string[]) => ({
    ownerSignInEmails: () => Promise.resolve(emails),
  });
  const refused = await ownerLockout(auth([PLACEHOLDER_OWNER_EMAIL]), true);
  assert(refused !== null && refused.includes("set your email and a password"), refused!);
  assertEquals(await ownerLockout(auth([PLACEHOLDER_OWNER_EMAIL]), false), null);
  // One owner with a real address is enough.
  assertEquals(
    await ownerLockout(auth([PLACEHOLDER_OWNER_EMAIL, "ada@example.com"]), true),
    null,
  );
});

test("bind addresses print as URLs, IPv6 bracketed", () => {
  assertEquals(
    describeBinds(["127.0.0.1", "fd00::5", "10.0.0.5"], 7411),
    "http://127.0.0.1:7411, http://[fd00::5]:7411, http://10.0.0.5:7411",
  );
});
