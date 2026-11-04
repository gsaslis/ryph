import { type Agent, DEFAULT_MEMORY_POLICY } from "../../core/types.ts";
import { mintId } from "@ryph/sealed";
import { slugify } from "../../helpers/ids.ts";
import { CreateAgentSchema, MAX_PROMPT_BODY_BYTES, UpdateAgentSchema } from "../../schema.ts";
import type { WiredDeps } from "../app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, parseBody, type Route, route } from "@ryph/shared/http";
import {
  POLICY,
  refuseForgePolicy,
  refuseModelPolicy,
  refuseNetworkPolicy,
  refuseOverCeiling,
  refuseToolPolicy,
  sameForgePolicy,
  sameLimitPolicy,
  sameModelPolicy,
  sameNetworkPolicy,
  sameToolPolicy,
  settleSkillPolicy,
} from "./agent_policies.ts";

/**
 * The `agents_by_handle` index refusing a duplicate. The read-then-write check answers the
 * common case with a clean 409; this answers the photo finish, where two creates pass that
 * check and only one lands. Without it the loser throws — `makeRouter` does not catch, so the
 * caller would get the server's plain-text 500 for what is a perfectly ordinary conflict.
 */
function isHandleTaken(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e !== null && e !== undefined && hops < 4; hops++) {
    const it = e as {
      code?: unknown;
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const names = `${String(it.constraint_name ?? "")} ${String(it.message ?? "")}`;
    if (it.code === "23505" && names.includes("handle")) return true;
    e = it.cause;
  }
  return false;
}

export function agentRoutes(deps: WiredDeps): Route[] {
  const { store, config } = deps;
  const nowIso = () => deps.now().toISOString();

  // ---- agents ------------------------------------------------------------

  /** A harness kind this deployment does not offer (RYPH_HARNESS_KINDS), refused by name. */
  const refuseHarnessKind = (kind: string): Response | null =>
    config.harnessKinds.includes(kind) ? null : json(400, {
      error: `harness kind "${kind}" is not offered here (RYPH_HARNESS_KINDS)`,
      knownKinds: config.harnessKinds,
    });

  const createAgent = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "agents:write");
    if (denied) return denied;
    const body = await parseBody(req, CreateAgentSchema, { maxBytes: MAX_PROMPT_BODY_BYTES });
    if (!body.ok) return body.res;
    // An unknown kind would only fail in the runner, at first launch — surface it at creation.
    const refusedKind = refuseHarnessKind(body.data.harnessKind);
    if (refusedKind) return refusedKind;

    // The admin gate comes FIRST, before either lookup: a caller who may not set a policy must
    // not get to probe which key ids and server ids exist by reading the refusals.
    const modelPolicy = body.data.modelPolicy ?? null;
    if (modelPolicy !== null) {
      const refused = refuseUnless(caller, POLICY, "setting an agent's modelPolicy") ??
        await refuseModelPolicy(modelPolicy, body.data.harnessKind, deps.modelAccess);
      if (refused) return refused;
    }
    const toolPolicy = body.data.toolPolicy ?? null;
    if (toolPolicy !== null) {
      const refused = refuseUnless(caller, POLICY, "setting an agent's toolPolicy") ??
        await refuseToolPolicy(toolPolicy, body.data.harnessKind, deps.toolAccess);
      if (refused) return refused;
    }
    const forgePolicy = body.data.forgePolicy ?? null;
    if (forgePolicy !== null) {
      const refused = refuseUnless(caller, POLICY, "setting an agent's forgePolicy") ??
        await refuseForgePolicy(forgePolicy, body.data.harnessKind, deps);
      if (refused) return refused;
    }
    const networkPolicy = body.data.networkPolicy ?? null;
    if (networkPolicy !== null) {
      const refused = refuseUnless(caller, POLICY, "setting an agent's networkPolicy") ??
        await refuseNetworkPolicy(networkPolicy, store, config.egress);
      if (refused) return refused;
    }
    const limitPolicy = body.data.limitPolicy ?? null;
    if (limitPolicy !== null) {
      const refused = refuseUnless(caller, POLICY, "setting an agent's limitPolicy") ??
        refuseOverCeiling("limitPolicy", limitPolicy, config.limits.ceiling);
      if (refused) return refused;
    }
    // The browser, by the patch switch's rule: on is a widening (a Chromium the agent drives on
    // the internet, and a core and a gigabyte and a half on every run), so asking for it is an
    // admin's; off, the default, needs nothing.
    if (body.data.browserEnabled === true) {
      const refused = refuseUnless(caller, POLICY, "giving an agent a browser");
      if (refused) return refused;
    }
    // Artifacts, the same way: on is a widening (what the agent publishes, everyone on the
    // instance can open, whatever repos it read), so asking for it is an admin's.
    if (body.data.canPublishArtifacts === true) {
      const refused = refuseUnless(caller, POLICY, "letting an agent publish artifacts");
      if (refused) return refused;
    }
    const skillPolicy = settleSkillPolicy(
      body.data.skillPolicy ?? null,
      null,
      body.data.harnessKind,
      deps.skillCatalogue,
    );
    if (skillPolicy instanceof Response) return skillPolicy;

    // The handle: the caller's pick (a taken one is their 409 to resolve), or the name's slug
    // with a numeric suffix walked until free. The unique index backstops the read-then-write
    // race — a photo-finish duplicate dies there instead of landing.
    let handle: string;
    if (body.data.handle !== undefined) {
      if (await store.getAgentByHandle(body.data.handle) !== null) {
        return json(409, { error: `handle "${body.data.handle}" is already taken` });
      }
      handle = body.data.handle;
    } else {
      // Trimmed AFTER the slice: slugify strips its own edges, but cutting at 30 can put a
      // separator back on the end, and "ada-lovelace-" is nobody's idea of a handle.
      const base = slugify(body.data.name).slice(0, 30).replace(/-+$/, "");
      handle = base;
      for (let n = 2; await store.getAgentByHandle(handle) !== null; n++) {
        if (n > 50) return json(409, { error: `no free handle near "${base}" — pick one` });
        handle = `${base}-${n}`;
      }
    }

    const at = nowIso();
    const agent: Agent = {
      id: mintId("a"),
      name: body.data.name,
      handle,
      email: body.data.email,
      systemPrompt: body.data.systemPrompt ?? null,
      harnessKind: body.data.harnessKind,
      modelPolicy,
      toolPolicy,
      // Absent means the default, not off: an agent remembers unless someone said not to.
      memoryPolicy: body.data.memoryPolicy === undefined
        ? DEFAULT_MEMORY_POLICY
        : body.data.memoryPolicy,
      forgePolicy,
      // Absent means the deployment's ceiling, not none — the one policy whose null is the
      // permissive answer, because an agent with no internet cannot run `npm ci`.
      networkPolicy,
      // Absent means the ceiling's values here too: a run is capped by the operator either way.
      limitPolicy,
      skillPolicy,
      // Absent means allowed, as every agent was before the switch existed. Saying false takes
      // access away, which needs no admin.
      canOpenPatches: body.data.canOpenPatches ?? true,
      // Off unless asked for: what the agent publishes, everyone on the instance can open.
      canPublishArtifacts: body.data.canPublishArtifacts ?? false,
      // Off unless asked for: a browser is a core and a gigabyte and a half on every run. Asked
      // for on a deployment that runs none, it is kept, and each run says why it has none.
      browserEnabled: body.data.browserEnabled ?? false,
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    try {
      await store.createAgent(agent);
    } catch (err) {
      if (!isHandleTaken(err)) throw err;
      return json(409, { error: `handle "${handle}" is already taken` });
    }
    return json(201, agent);
  };

  const listAgents = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "agents:read");
    if (denied) return denied;
    return json(200, { agents: await store.listAgents() });
  };

  const getAgent = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "agents:read");
    if (denied) return denied;
    const agent = await store.getAgent(params.id);
    if (!agent) return json(404, { error: "no such agent" });
    return json(200, agent);
  };

  const updateAgent = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "agents:write");
    if (denied) return denied;
    const agent = await store.getAgent(params.id);
    if (!agent) return json(404, { error: "no such agent" });
    const body = await parseBody(req, UpdateAgentSchema, { maxBytes: MAX_PROMPT_BODY_BYTES });
    if (!body.ok) return body.res;

    const patch = body.data;
    if (patch.handle !== undefined && patch.handle !== agent.handle) {
      if (await store.getAgentByHandle(patch.handle) !== null) {
        return json(409, { error: `handle "${patch.handle}" is already taken` });
      }
    }
    const updated: Agent = {
      ...agent,
      name: patch.name ?? agent.name,
      handle: patch.handle ?? agent.handle,
      email: patch.email ?? agent.email,
      // `null` clears the prompt; absent leaves it alone.
      systemPrompt: patch.systemPrompt === undefined ? agent.systemPrompt : patch.systemPrompt,
      harnessKind: patch.harnessKind ?? agent.harnessKind,
      // Same null/absent semantics as the prompt.
      modelPolicy: patch.modelPolicy === undefined ? agent.modelPolicy : patch.modelPolicy,
      toolPolicy: patch.toolPolicy === undefined ? agent.toolPolicy : patch.toolPolicy,
      memoryPolicy: patch.memoryPolicy === undefined ? agent.memoryPolicy : patch.memoryPolicy,
      forgePolicy: patch.forgePolicy === undefined ? agent.forgePolicy : patch.forgePolicy,
      networkPolicy: patch.networkPolicy === undefined ? agent.networkPolicy : patch.networkPolicy,
      limitPolicy: patch.limitPolicy === undefined ? agent.limitPolicy : patch.limitPolicy,
      skillPolicy: patch.skillPolicy === undefined ? agent.skillPolicy : patch.skillPolicy,
      canOpenPatches: patch.canOpenPatches ?? agent.canOpenPatches,
      canPublishArtifacts: patch.canPublishArtifacts ?? agent.canPublishArtifacts,
      browserEnabled: patch.browserEnabled ?? agent.browserEnabled,
      updatedAt: nowIso(),
    };
    // Validated against the PATCHED harness kind: swapping Ada to a harness that cannot drive
    // her policy's provider is refused whether the swap and the policy arrive together or not.
    // Only a patch that MOVES one of the two can invalidate the pair, and a form resends every
    // field it holds, so the test is what changed rather than what arrived. A pair that stays
    // put keeps the verdict it earned when it was set: re-deciding it would make renaming an
    // agent depend on a live model-access surface.
    const harnessMoved = updated.harnessKind !== agent.harnessKind;
    // Only a MOVED kind is checked: an agent created on a kind the deployment later stopped
    // offering stays editable, and its runs say what is wrong instead.
    if (harnessMoved) {
      const refusedKind = refuseHarnessKind(updated.harnessKind);
      if (refusedKind) return refusedKind;
    }
    // "Moved" is also what the admin gate keys on: a resent, unchanged policy is not a change,
    // clearing one is always open, and a harness swap that leaves the policy alone binds no new
    // credential — so neither of those needs an admin, only a policy whose VALUE moved.
    const modelPolicyMoved = updated.modelPolicy !== null &&
      !sameModelPolicy(updated.modelPolicy, agent.modelPolicy);
    if (modelPolicyMoved) {
      const refused = refuseUnless(caller, POLICY, "setting an agent's modelPolicy");
      if (refused) return refused;
    }
    if (updated.modelPolicy !== null && (harnessMoved || modelPolicyMoved)) {
      const refused = await refuseModelPolicy(
        updated.modelPolicy,
        updated.harnessKind,
        deps.modelAccess,
      );
      if (refused) return refused;
    }
    // The tool policy is its own pair with the harness, judged by the same rule.
    const toolPolicyMoved = updated.toolPolicy !== null &&
      !sameToolPolicy(updated.toolPolicy, agent.toolPolicy);
    if (toolPolicyMoved) {
      const refused = refuseUnless(caller, POLICY, "setting an agent's toolPolicy");
      if (refused) return refused;
    }
    if (updated.toolPolicy !== null && (harnessMoved || toolPolicyMoved)) {
      const refused = await refuseToolPolicy(
        updated.toolPolicy,
        updated.harnessKind,
        deps.toolAccess,
      );
      if (refused) return refused;
    }
    // And the forge policy, by the same rule once more — including what that rule costs, which is
    // worth stating because it reads as a bug otherwise: `moved` is true for ANY change to a
    // policy that stays non-null, so NARROWING one (dropping a capability, shrinking a cap) needs
    // an admin exactly as widening does. Deliberate, and the shape toolPolicy already has. The
    // policy rule — taking access away needs no privilege — is about CLEARING a policy, which
    // is the case that stays open to anyone (landed note 6 promises that and nothing more). A
    // non-admin who wants an agent to have less forge access clears the policy; handing back a
    // smaller one is an admin's call, because "smaller" is a judgement the gate cannot make.
    const forgePolicyMoved = updated.forgePolicy !== null &&
      !sameForgePolicy(updated.forgePolicy, agent.forgePolicy);
    if (forgePolicyMoved) {
      const refused = refuseUnless(caller, POLICY, "setting an agent's forgePolicy");
      if (refused) return refused;
    }
    if (updated.forgePolicy !== null && (harnessMoved || forgePolicyMoved)) {
      const refused = await refuseForgePolicy(updated.forgePolicy, updated.harnessKind, deps);
      if (refused) return refused;
    }
    // And egress, by the same rule — with its polarity reversed, which is the whole reason it
    // needs saying. Clearing every other policy takes access AWAY; clearing this one hands the
    // agent the deployment's full ceiling back. So the gate is on a policy that moved to a
    // non-null value OR to null, where the others gate only the former: widening is widening
    // whether it is spelled as a bigger list or as no list at all.
    const networkPolicyMoved = !sameNetworkPolicy(updated.networkPolicy, agent.networkPolicy);
    if (networkPolicyMoved) {
      const refused = refuseUnless(caller, POLICY, "setting an agent's networkPolicy");
      if (refused) return refused;
    }
    if (updated.networkPolicy !== null && networkPolicyMoved) {
      const refused = await refuseNetworkPolicy(updated.networkPolicy, store, config.egress);
      if (refused) return refused;
    }
    // And the limits, by the egress rule rather than the forge rule: clearing the policy hands
    // the agent the deployment's ceiling back, which is wider than anything an admin set under
    // it. A move in either direction is an admin's; the ceiling check applies to a value.
    const limitPolicyMoved = !sameLimitPolicy(updated.limitPolicy, agent.limitPolicy);
    if (limitPolicyMoved) {
      const refused = refuseUnless(caller, POLICY, "setting an agent's limitPolicy");
      if (refused) return refused;
    }
    if (updated.limitPolicy !== null && limitPolicyMoved) {
      const refused = refuseOverCeiling("limitPolicy", updated.limitPolicy, config.limits.ceiling);
      if (refused) return refused;
    }
    // And skills, with no admin gate at all: a skill policy only narrows what the deployment
    // allows, and clearing it widens back to the deployment's own settings and no further. A
    // harness swap re-decides it, because a policy on a harness that reads no skills is inert.
    if (patch.skillPolicy !== undefined || harnessMoved) {
      const settled = settleSkillPolicy(
        updated.skillPolicy,
        agent.skillPolicy,
        updated.harnessKind,
        deps.skillCatalogue,
      );
      if (settled instanceof Response) return settled;
      updated.skillPolicy = settled;
    }
    // And patches, gated on the direction that widens: switching them off is open to anyone who
    // may edit the agent, switching them back on is an admin's. An agent was locked out of
    // shipping code for a reason, such as auditing for vulnerabilities nobody may publish yet,
    // and whoever undoes that should be someone the lock was not meant to stop.
    if (updated.canOpenPatches && !agent.canOpenPatches) {
      const refused = refuseUnless(caller, POLICY, "letting an agent open patches again");
      if (refused) return refused;
    }
    // And the browser, the same way round: switching it off, or resending it as it is, is
    // anyone's who may edit the agent; switching it on is an admin's.
    if (updated.browserEnabled && !agent.browserEnabled) {
      const refused = refuseUnless(caller, POLICY, "giving an agent a browser");
      if (refused) return refused;
    }
    // And artifacts: switching them off is anyone's who may edit the agent, on an admin's.
    if (updated.canPublishArtifacts && !agent.canPublishArtifacts) {
      const refused = refuseUnless(caller, POLICY, "letting an agent publish artifacts");
      if (refused) return refused;
    }
    try {
      await store.saveAgent(updated);
    } catch (err) {
      if (!isHandleTaken(err)) throw err;
      return json(409, { error: `handle "${updated.handle}" is already taken` });
    }
    // The patch switch moves on its own, conditionally: only if it still reads what this edit
    // read, and only when the edit moved it. The full-row save above never writes it, so a
    // rename held back across an admin's lock cannot undo the lock, and a stale "true" resent
    // unchanged writes nothing.
    if (updated.canOpenPatches !== agent.canOpenPatches) {
      const moved = await store.setAgentCanOpenPatches(
        agent.id,
        agent.canOpenPatches,
        updated.canOpenPatches,
      );
      // Lost only to a change that already reached the same end, or to one that went the other
      // way — the first is this edit's answer too; the second is refused, the rest saved.
      const now = await store.getAgent(agent.id);
      if (!moved && now?.canOpenPatches !== updated.canOpenPatches) {
        return json(409, {
          error: "the agent's patch switch changed while this edit was in flight, so it was " +
            "left as it is now; the rest of the edit was saved — reload the agent",
        });
      }
    }
    // The artifact switch, the same way: an edit read before an admin switched publishing off
    // cannot switch it back on by saving the rest.
    if (updated.canPublishArtifacts !== agent.canPublishArtifacts) {
      const moved = await store.setAgentCanPublishArtifacts(
        agent.id,
        agent.canPublishArtifacts,
        updated.canPublishArtifacts,
      );
      const now = await store.getAgent(agent.id);
      if (!moved && now?.canPublishArtifacts !== updated.canPublishArtifacts) {
        return json(409, {
          error: "the agent's artifact switch changed while this edit was in flight, so it was " +
            "left as it is now; the rest of the edit was saved — reload the agent",
        });
      }
    }
    return json(200, await store.getAgent(agent.id) ?? updated);
  };

  const archiveAgent = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "agents:write");
    if (denied) return denied;
    const agent = await store.getAgent(params.id);
    if (!agent) return json(404, { error: "no such agent" });
    if (agent.archivedAt !== null) return json(200, agent); // idempotent
    const archived: Agent = { ...agent, archivedAt: nowIso(), updatedAt: nowIso() };
    await store.saveAgent(archived);
    return json(200, archived);
  };

  return [
    route("POST", "/v1/agents", createAgent),
    route("GET", "/v1/agents", listAgents),
    route("GET", "/v1/agents/:id", getAgent),
    route("PATCH", "/v1/agents/:id", updateAgent),
    route("POST", "/v1/agents/:id/archive", archiveAgent),
  ];
}
