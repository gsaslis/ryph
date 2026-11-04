// Scriptable OrchestratorGateway test double with an assertion surface: progress reports and
// results are retained for inspection. The gateway is report-only — it drives nothing and cannot
// answer a report, so it behaves like a batch caller: it confirms delivery of every result and
// collects it. The core must behave correctly against it without any caller's assumptions leaking
// into core code.

import type {
  Progress,
  Result,
  SetupFailureReport,
  SkillReport,
  StaleBase,
  StaleMemory,
} from "../../src/core/types.ts";
import type { OrchestratorGateway } from "../../src/ports/orchestrator_gateway.ts";

export interface FakeOrchestratorGateway extends OrchestratorGateway {
  readonly progressReports: Progress[];
  readonly results: Result[];
  readonly staleReports: StaleMemory[][];
  readonly staleBaseReports: StaleBase[][];
  readonly setupFailureReports: SetupFailureReport[][];
  readonly skillReports: SkillReport[];
}

export function fakeOrchestratorGateway(): FakeOrchestratorGateway {
  const progressReports: Progress[] = [];
  const results: Result[] = [];
  const staleReports: StaleMemory[][] = [];
  const staleBaseReports: StaleBase[][] = [];
  const setupFailureReports: SetupFailureReport[][] = [];
  const skillReports: SkillReport[] = [];

  return {
    progressReports,
    results,
    staleReports,
    staleBaseReports,
    setupFailureReports,
    skillReports,
    reportProgress(p) {
      progressReports.push(p);
    },
    reportStaleMemories(stale) {
      staleReports.push(stale);
    },
    reportStaleBases(bases) {
      staleBaseReports.push(bases);
    },
    reportSetupFailures(failures) {
      setupFailureReports.push(failures);
      return Promise.resolve();
    },
    reportSkills(report) {
      skillReports.push(report);
    },
    reportResult(r) {
      results.push(r);
      return Promise.resolve();
    },
  };
}
