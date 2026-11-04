import { supportedDialects } from "@ryph/model-proxy";
import { supportsSkills, supportsTools } from "../../core/harness_tools.ts";
import {
  allowlistRefusal,
  EGRESS_BUNDLES,
  type EgressAllowlist,
  liveCeiling,
} from "../../core/egress.ts";
import { browserUnavailable } from "../../core/browser.ts";
import { EgressAllowlistSchema } from "../../schema.ts";
import type { WiredDeps } from "../app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, parseBody, type Route, route } from "@ryph/shared/http";

export function deploymentRoutes(deps: WiredDeps): Route[] {
  const { store, config } = deps;

  // ---- harnesses -----------------------------------------------------------

  // What a UI needs to build agent-creation forms without hardcoding: the harness kinds this
  // deployment offers (RYPH_HARNESS_KINDS), the image every one of them launches on, which wire
  // DIALECTS each can drive, and whether it can use tools and read skills (static registries).
  //
  // Dialects rather than provider ids, because a provider id is no longer a fixed name: beside
  // the two built-ins sits every OpenAI-compatible endpoint an admin has registered, and this
  // static table cannot enumerate rows. A form joins the two — `GET /v1/providers` on the model
  // proxy for the live list, this route for the shapes each harness speaks.
  //
  // This route carries no model CATALOGUE; the proxy's provider list does, a built-in's from its
  // price list and a registered endpoint's from what its admin declared on the row — never here,
  // where nothing knows which endpoints exist.
  const listHarnesses = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "agents:read");
    if (denied) return denied;
    // `browser`: whether an agent on this harness can be given one here — the deployment runs a
    // browser on a provisioner that launches it, and the harness has the MCP client it is
    // driven through. Where it cannot, `browserUnavailable` says which of the three is missing
    // and `provisioner` names the backend, so the form can hold the switch off and say why.
    const harnesses = config.harnessKinds.map((kind) => {
      const unavailable = browserUnavailable(config.browser, deps.provisioner, kind);
      return {
        kind,
        image: config.agentImage,
        dialects: supportedDialects(kind),
        tools: supportsTools(kind),
        skills: supportsSkills(kind),
        browser: unavailable === null,
        browserUnavailable: unavailable,
        provisioner: config.provisionerKind ?? null,
      };
    });
    return json(200, { harnesses });
  };

  // ---- limits ---------------------------------------------------------------

  /** The operator's run limits, for the forms: the ceiling a policy may not exceed, and the
   * deployment-wide concurrency cap. Read-only, and anyone's to read — the values are what
   * every run of theirs is under. */
  const getLimits = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    return json(200, { ceiling: config.limits.ceiling, concurrency: config.limits.concurrency });
  };

  // ---- size classes --------------------------------------------------------

  // The classes a repo or workspace may be set to, for the settings form. Read-anybody: it names
  // quantities the operator configured, nothing an agent could not read off its own cgroup.
  const listRunSizes = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    return json(200, {
      sizes: config.runSizes.classes.map((size) => ({
        ...size,
        default: size.name === config.runSizes.defaultName,
      })),
    });
  };

  // ---- egress --------------------------------------------------------------

  /**
   * The deployment's egress ceiling, so a form can offer what an agent may narrow instead of
   * guessing — and, for an admin, what the allowlist form itself is editing. Read-anybody: it
   * names bundles and hostnames, the shape of the boundary, never a credential, and nothing an
   * agent could not discover by trying.
   *
   * `wired` is the field worth having. A deployment can claim the boundary (`proxy`) and not
   * have finished configuring it, and then its runs reach NOTHING — which looks identical to a
   * broken network from inside a failing `npm ci`. Saying it here lets the form explain it
   * before somebody spends an afternoon on it.
   *
   * `catalogue` is every bundle that EXISTS, beside the ones this deployment vouches for: an
   * admin editing the allowlist needs to see what they could add, while an agent's form must
   * only ever see what it may narrow. One route, two audiences, and the difference is a field
   * rather than a second endpoint that could disagree with this one.
   */
  const getEgress = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "agents:read");
    if (denied) return denied;
    const { policy, key } = config.egress;
    const ceiling = await liveCeiling(store, policy);
    const saved = await store.getEgressAllowlist();
    const byId = new Map(EGRESS_BUNDLES.map((b) => [b.id, b]));
    return json(200, {
      mode: ceiling.mode,
      // Only the bundles this deployment vouches for, expanded — the catalogue's other entries
      // are not on offer here, and listing them would invite a policy that gets refused.
      bundles: ceiling.bundles.flatMap((id) => {
        const bundle = byId.get(id);
        return bundle === undefined ? [] : [bundle];
      }),
      hosts: ceiling.hosts,
      wired: ceiling.mode === "open" || (key !== null && policy.proxyUrl !== null),
      catalogue: EGRESS_BUNDLES,
      // Where the ceiling currently comes from, said plainly, because the two read identically
      // in the form and behave differently on the next deploy: `environment` is the seed and a
      // manifest can still move it, `admin` is a saved row that outlives one.
      source: saved === null ? "environment" : "admin",
      updatedAt: saved?.updatedAt ?? null,
      updatedBy: saved?.updatedBy ?? null,
    });
  };

  /**
   * An admin moves the deployment's allowlist, without a redeploy.
   *
   * WHY THIS IS A WRITE AN ADMIN MAY MAKE AND `mode` IS NOT. The allowlist says what a run may
   * reach; `mode`, the proxy's address and its signing key say whether the boundary exists and
   * how a run dials it. The first is a product decision that changes when a repo picks up a new
   * package manager — and making it a redeploy means the first person to hit it is a run dying
   * in the middle of a setup step, which is exactly how JSR was discovered missing. The second
   * is infrastructure, and an admin turning it off from inside the product would be a bypass
   * wearing a form. So: this route widens and narrows the list, and nothing here can make an
   * enforced deployment stop enforcing.
   *
   * The catalogue check is the point of validating at all. A bundle id nobody offers would
   * store happily and then refuse every launch, and the operator would read a message about a
   * variable they did not set.
   */
  const putEgress = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "egress:manage", "changing this deployment's allowlist");
    if (denied) return denied;
    const body = await parseBody(req, EgressAllowlistSchema);
    if (!body.ok) return body.res;
    const refusal = allowlistRefusal(body.data);
    if (refusal !== null) return json(400, { error: refusal });
    const allowlist: EgressAllowlist = {
      bundles: body.data.bundles,
      hosts: body.data.hosts,
      updatedAt: deps.now().toISOString(),
      // Break-glass has no identity to record, and saying so beats inventing one.
      updatedBy: caller.kind === "break-glass" ? null : caller.userId,
    };
    await store.saveEgressAllowlist(allowlist);
    return json(200, allowlist);
  };

  // ---- images ----------------------------------------------------------------

  /** The images live in the docker launcher's process: one that did not answer is a 503 naming
   * why, as the forge's routes answer for a forge that could not, never a 500. */
  const unavailable = (err: unknown) =>
    json(503, {
      error: `the docker launcher could not say how the images are doing: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });

  /** The images this deployment launches and how far their download got, for the first-run
   * flow. Empty where nothing is fetched ahead: not docker, or nothing wired. */
  const listImages = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "agents:read");
    if (denied) return denied;
    if (!deps.imagePrefetch) return json(200, { images: [] });
    try {
      return json(200, { images: await deps.imagePrefetch.status() });
    } catch (err) {
      return unavailable(err);
    }
  };

  /** Looks for every image again and downloads what is not there, a failed one included. The operator's, as a build is:
   * it spends this machine's disk and bandwidth. */
  const pullImages = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "resources:manage", "downloading images");
    if (denied) return denied;
    if (!deps.imagePrefetch) return json(404, { error: "this deployment fetches no images ahead" });
    try {
      await deps.imagePrefetch.start();
      return json(202, { images: await deps.imagePrefetch.status() });
    } catch (err) {
      return unavailable(err);
    }
  };

  return [
    route("GET", "/v1/images", listImages),
    route("POST", "/v1/images/pull", pullImages),
    route("GET", "/v1/harnesses", listHarnesses),
    route("GET", "/v1/run-sizes", listRunSizes),
    route("GET", "/v1/limits", getLimits),
    route("GET", "/v1/egress", getEgress),
    route("PUT", "/v1/egress", putEgress),
  ];
}
