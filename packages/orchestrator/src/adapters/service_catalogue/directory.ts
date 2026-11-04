// The service catalogue as a directory of JSON files — one entry per file, the file named for
// its id — read and validated ONCE, at construction. An invalid entry fails the load loudly,
// naming the file and every issue: this is the list of images the platform will run on someone
// else's machines, so "we skipped the one that did not parse" is not a mode worth having.
//
// The zod schema lives HERE and not in src/core, following this package's rule that zod never
// reaches the core (see src/schema.ts). The core owns the SHAPE (`ServiceCatalogueEntry`); this
// is the boundary that checks bytes against it.
//
// The directory ships inside the package. Resolved through import.meta.url rather than the cwd,
// so the same path works from source, from the control-plane image, and from inside the
// `ryph` binary's embedded filesystem (its compile step `--include`s the directory).

import { readdir, readFile } from "node:fs/promises";
import { z } from "@zod/zod";
import { fromFileUrl, join } from "@std/path";
import { capabilityRefusal, type ServiceCatalogueEntry } from "../../core/services.ts";
import type { ServiceCatalogue } from "../../ports/service_catalogue.ts";

/** Where the entries this package ships live. */
export const SERVICE_CATALOGUE_DIR: string = fromFileUrl(
  new URL("../../../catalogue", import.meta.url),
);

/**
 * `repo[:tag]@sha256:<64 hex>` — the digest is what gets pulled, the tag is for the reviewer.
 * A tag can be moved under us, and this is the list of code the platform runs. Duplicated from
 * @ryph/mcp-gateway's catalogue for the reason that package's header gives: two catalogues,
 * two review processes, one rule each, and no import between them.
 */
export const PINNED_IMAGE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$/;

/** Docker's memory spelling, capped at a sane ceiling for one service container. */
const MEMORY = /^[1-9][0-9]{0,4}[mg]$/;

/**
 * A capability WITHOUT the `CAP_` prefix, which is how both docker's `--cap-add` and a pod
 * spec's `capabilities.add` name them.
 *
 * Only those in `SERVICE_CAPABILITIES`, rather than left to a reviewer's attention. NET_RAW is
 * the whole reason this rule exists: a sidecar shares the run's network namespace, every
 * intra-cluster hop in this deployment is plaintext HTTP, and a raw socket there reads the run
 * token, the git token and the model key off the wire. It is an allowlist because NET_RAW is
 * not the only road there. No database image needs anything outside it; an entry that thinks
 * it does needs a conversation, not a merge. The escape hatch's parser applies the same rule.
 */
const capability = z.string()
  .regex(/^[A-Z][A-Z0-9_]{0,31}$/, { error: "a capability name like CHOWN, without CAP_" })
  .superRefine((c, ctx) => {
    const refused = capabilityRefusal(c);
    if (refused !== null) ctx.addIssue({ code: "custom", message: refused });
  });

const label = z.string().trim().min(1).max(80);

export const ServiceCatalogueEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, { error: "ids are slug-shaped, ≤31 chars" }),
  name: label,
  description: z.string().trim().max(400),
  docs: z.url({ protocol: /^https$/ }),
  /** The label a repo writes after `@`, e.g. `18` in `postgres@18`. */
  versions: z.record(
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/, { error: "not a version label" }),
    z.string().regex(PINNED_IMAGE, {
      error: "must be digest-pinned: repo[:tag]@sha256:<64 hex>",
    }),
  ).refine((v) => Object.keys(v).length > 0, { error: "needs at least one version" }),
  defaultPort: z.int().min(1).max(65535),
  capabilities: z.array(capability).max(8),
  memory: z.string().regex(MEMORY, { error: 'a memory size like "512m"' }),
  /** Env keys a repo may set. Settings only — a credential does not belong in a repo's tree,
   * and the values sit in the run's record and its container spec. They do not reach the
   * agent's prompt: http/runner_api.ts hands the runner a service's name, port and image. */
  env: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, { error: "not an env var name" }))
    .max(32),
}).strict() satisfies z.ZodType<ServiceCatalogueEntry>;

export async function directoryServiceCatalogue(
  dir: string = SERVICE_CATALOGUE_DIR,
): Promise<ServiceCatalogue> {
  const entries = new Map<string, ServiceCatalogueEntry>();
  const problems: string[] = [];
  const files: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.isFile() && item.name.endsWith(".json")) files.push(item.name);
  }
  for (const file of files.sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(dir, file), "utf8"));
    } catch (err) {
      problems.push(`${file}: not JSON (${err instanceof Error ? err.message : err})`);
      continue;
    }
    const parsed = ServiceCatalogueEntrySchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push(`${file}: ${issue.path.join(".") || "(entry)"}: ${issue.message}`);
      }
      continue;
    }
    if (`${parsed.data.id}.json` !== file) {
      problems.push(`${file}: id "${parsed.data.id}" does not match the file name`);
      continue;
    }
    entries.set(parsed.data.id, parsed.data);
  }
  if (problems.length > 0) {
    throw new Error(`the service catalogue at ${dir} is invalid:\n  ${problems.join("\n  ")}`);
  }
  const sorted = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { list: () => Promise.resolve(structuredClone(sorted)) };
}
