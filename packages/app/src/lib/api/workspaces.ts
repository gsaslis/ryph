import { z } from "zod";
import { apiCall } from "./call";
import { type WorkspaceWithRepos, workspaceWithReposSchema } from "./types";

export type CreateWorkspaceInput = { name: string; description?: string };
export type UpdateWorkspaceInput = {
  name?: string;
  description?: string | null;
  /** Admin only. Null returns the workspace to the deployment's default class. */
  sizeClass?: string | null;
  /** Admin only: the member whose `.ryph/Dockerfile` defines the machine. Null is the first. */
  environmentRepoId?: string | null;
};
export type AddWorkspaceRepoInput = {
  connectedRepoId: string;
  /** Null or absent: the repo's default branch. */
  ref?: string | null;
  /** Absent: the repo's name in slug form. */
  path?: string;
  description?: string | null;
};
export type UpdateWorkspaceRepoInput = {
  ref?: string | null;
  path?: string;
  description?: string | null;
};

export async function getWorkspaces(f = fetch): Promise<WorkspaceWithRepos[]> {
  const res = await apiCall(f, "/v1/workspaces");
  return z.object({ workspaces: z.array(workspaceWithReposSchema) }).parse(res).workspaces;
}

export async function getWorkspace(f = fetch, id: string): Promise<WorkspaceWithRepos> {
  return workspaceWithReposSchema.parse(
    await apiCall(f, `/v1/workspaces/${encodeURIComponent(id)}`),
  );
}

export async function createWorkspace(
  f = fetch,
  input: CreateWorkspaceInput,
): Promise<WorkspaceWithRepos> {
  return workspaceWithReposSchema.parse(
    await apiCall(f, "/v1/workspaces", { method: "POST", body: JSON.stringify(input) }),
  );
}

export async function updateWorkspace(
  f = fetch,
  id: string,
  input: UpdateWorkspaceInput,
): Promise<WorkspaceWithRepos> {
  return workspaceWithReposSchema.parse(
    await apiCall(f, `/v1/workspaces/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function archiveWorkspace(f = fetch, id: string): Promise<WorkspaceWithRepos> {
  return workspaceWithReposSchema.parse(
    await apiCall(f, `/v1/workspaces/${encodeURIComponent(id)}/archive`, { method: "POST" }),
  );
}

export async function addWorkspaceRepo(
  f = fetch,
  id: string,
  input: AddWorkspaceRepoInput,
): Promise<WorkspaceWithRepos> {
  return workspaceWithReposSchema.parse(
    await apiCall(f, `/v1/workspaces/${encodeURIComponent(id)}/repos`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export async function updateWorkspaceRepo(
  f = fetch,
  id: string,
  connectedRepoId: string,
  input: UpdateWorkspaceRepoInput,
): Promise<WorkspaceWithRepos> {
  return workspaceWithReposSchema.parse(
    await apiCall(
      f,
      `/v1/workspaces/${encodeURIComponent(id)}/repos/${encodeURIComponent(connectedRepoId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  );
}

export async function removeWorkspaceRepo(
  f = fetch,
  id: string,
  connectedRepoId: string,
): Promise<WorkspaceWithRepos> {
  return workspaceWithReposSchema.parse(
    await apiCall(
      f,
      `/v1/workspaces/${encodeURIComponent(id)}/repos/${encodeURIComponent(connectedRepoId)}`,
      { method: "DELETE" },
    ),
  );
}
