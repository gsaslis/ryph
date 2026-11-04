// @ryph/fake-gitlab — a stateful, in-memory GitLab for end-to-end tests and the playground: the
// REST API v4 surface ryph's GitLab adapter uses, OAuth, git smart HTTP over real bare
// repositories, and webhooks to a configured URL. See README.md for what it covers and where it
// knowingly differs from GitLab.

export {
  deriveHookToken,
  type FakeGitlab,
  type FakeGitlabOptions,
  type Interceptor,
  type RequestRecord,
  startFakeGitlab,
} from "./fake.ts";
export type { Delivery } from "./hooks.ts";
export type { MergeMethod } from "./git/repo.ts";
export { ACCESS, type Feature, type FeatureAccess, FEATURES, type Visibility } from "./model.ts";
export type {
  Group,
  Issue,
  MergeRequest,
  Note,
  Project,
  ProjectHook,
  User,
  World,
} from "./model.ts";
export type { Instance } from "./instance.ts";
export { s256 } from "./routes/accounts.ts";
export { extractQuickActions, renderedLine } from "./quick_actions.ts";
