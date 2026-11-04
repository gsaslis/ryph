import { expect, test } from "bun:test";
import { contextRefusal, releaseRefusal } from "./throwaway.ts";

const KIND = { context: "kind-ryph", throwaway: "kind-ryph", server: "https://127.0.0.1:6443" };

test("a local kind or k3d context named twice is a throwaway", () => {
  expect(contextRefusal(KIND)).toBeNull();
  for (const server of ["https://localhost:6443", "https://[::1]:6443"]) {
    expect(contextRefusal({ ...KIND, server })).toBeNull();
  }
  expect(
    contextRefusal({
      context: "k3d-ryph",
      throwaway: "k3d-ryph",
      server: "https://127.0.0.1:41235",
    }),
  ).toBeNull();
  // k3d v5 writes its API server as 0.0.0.0.
  expect(
    contextRefusal({ context: "k3d-ryph", throwaway: "k3d-ryph", server: "https://0.0.0.0:6443" }),
  ).toBeNull();
});

test("a bare flag, another context, a remote server or another name is refused", () => {
  expect(contextRefusal({ ...KIND, throwaway: undefined })).toContain("--throwaway=kind-ryph");
  expect(contextRefusal({ ...KIND, throwaway: "" })).toContain("must name the context");
  expect(contextRefusal({ ...KIND, throwaway: "kind-other" })).toContain("must name the context");
  expect(contextRefusal({ context: "gke_p_r_c", throwaway: "gke_p_r_c", server: KIND.server }))
    .toContain("not a kind or k3d cluster");
  expect(contextRefusal({ context: "my-kind-x", throwaway: "my-kind-x", server: KIND.server }))
    .toContain("not a kind or k3d cluster");
  for (
    const server of [
      "https://203.0.113.10:6443",
      "https://127.0.0.1.example.com:6443",
      "https://kind-ryph-control-plane:6443",
      "not a url",
    ]
  ) {
    expect(contextRefusal({ ...KIND, server })).not.toBeNull();
  }
});

test("only a release on the dev state is a throwaway", () => {
  expect(releaseRefusal({ devState: { enabled: true } })).toBeNull();
  for (
    const values of [{}, null, { devState: { enabled: false } }, { devState: { enabled: "true" } }]
  ) {
    expect(releaseRefusal(values)).toContain("devState.enabled");
  }
});
