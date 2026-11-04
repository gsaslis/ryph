// @ryph/previews — a run's dev server, opened in the browsers of the people who can read the run,
// on hosted deployments. The control plane registers a preview and hands its runner a tunnel
// ticket; the runner dials out and every browser connection rides that one socket
// (@ryph/tunnel). The local binary does the same in-process (packages/host/src/previews.ts).
// src/main.ts is the standalone service; README.md has the trust model.

export {
  type Previews,
  previews,
  PREVIEWS_PER_RUN,
  type PreviewsLog,
  type PreviewsOptions,
  TOTAL,
} from "./service.ts";
export { contentSecurityPolicy, validHost } from "./core/csp.ts";
export { COOKIE } from "./core/keys.ts";
