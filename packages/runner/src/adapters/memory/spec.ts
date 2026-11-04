// `MemoryStore` over the run spec: the brief the orchestrator composed at task start and froze
// into the run's snapshot arrives with the spec, and this hands it to the core unchanged. There
// is nothing to fetch and nothing to write — the tools an agent proposes and votes with reach
// memory through the MCP gateway, not through this process.

import type { MemoryBrief } from "../../core/types.ts";
import type { MemoryStore } from "../../ports/memory_store.ts";

export function specMemoryStore(brief: MemoryBrief | null | undefined): MemoryStore {
  return {
    loadSnapshot() {
      return Promise.resolve(brief ?? null);
    },
  };
}
