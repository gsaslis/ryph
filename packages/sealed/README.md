# @ryph/sealed

The credential kit every ryph service shares: seal a secret at rest, mint an id or a bearer
token, hash a token for storage, compare hashes without leaking through timing. A handful of
functions and one format, no dependencies, WebCrypto only.

## ⚙️ What it does

| Export                            | Does                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `importMasterKey(hex)`            | Turns a 64-hex-char master key into a `MasterKey`; anything else throws, so a truncated key can never "work" |
| `deriveSealingKey(master, class)` | One class's own AES-256-GCM key, HKDF-SHA256 over the master with the label `ryph sealed <class> v2`          |
| `encryptSecret` / `decryptSecret` | AES-256-GCM with a fresh IV per seal, in the `v2.<iv>.<ciphertext>` format, bound to the caller's binding (the row and where the secret is sent) as authenticated data; a tampered row, or one read with another binding, throws |
| `mintId(prefix)`                  | `r-01jb7k3m9x4q8zt2vw6hn5c0fe` — path-, slug-, and branch-safe; sorts by mint time                                                               |
| `mintToken()`                     | 256 bits of hex — the run and session tokens as-is; the model-proxy prefixes it (`ryph-vk-…`)               |
| `sha256Hex` / `timingSafeEqual`   | The two halves of checking a token whose only stored form is its hash                                        |
| `makeServiceGate(token)`          | The gate for one shared service bearer: `bearerToken`, then `tokenMatches` (hashes compared, so no length leaks), else `unauthorized()` |

## 🧭 What it deliberately does not know

Which master key seals which class of secret, what a secret is bound to, what a token grants,
where a hash lives: all of that stays with the service that owns the secret. The model-proxy seals
provider keys under a key derived from `RYPH_SECRETS_KEY`, the mcp-gateway seals MCP credentials
under one derived from `RYPH_MCP_KEY`; this package is handed an already-imported key and never
reads an env var. Keeping the two questions
apart is what lets a compromised control plane hold the sealing _code_ without holding the proxy's
_key_.

## 🧬 Why a package

These functions used to exist as one copy per package, each carrying a note that a shared kit
could absorb them once a third copy appeared. Cryptographic code is the worst thing to have several
of: a fix to one copy (a reused IV, a length-leaking compare) has to be found and repeated in the
rest. One implementation, tested once — the same reasoning that makes
[`@ryph/logger`](../logger/README.md) a package.

"No dependencies" is checked, not promised: `bun run guard` walks `src/`'s module graph and
fails on any edge that is not another file in `src/`. It is also what keeps the service guards
honest — `../sealed/` is the one allowance they grant to a package rather than a directory inside
one, and they walk direct edges only, so their fences are transitive only for as long as this one
holds.

The sealed format is versioned so a later scheme — sealing to a service-held keypair, making the
writer write-only on secrets — can coexist with rows sealed today.
