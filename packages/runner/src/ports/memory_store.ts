/**
 * Memory at the runner boundary: the brief a run starts with, and nothing else.
 *
 * The brief is composed and frozen by the orchestrator at task start and rides the run spec; the
 * runner never composes, fetches or writes memory. What the agent learns goes back through the
 * memory tools it holds — MCP tools behind the gateway, like every other tool — so nothing here
 * has to be flushed before the result is reported. The port stays a seam: a run driven from a
 * file (`--context`) carries its brief in that file, the same way.
 */
import type { MemoryBrief } from "../core/types.ts";

export interface MemoryStore {
  /** The brief, already rendered with the evidence behind its claims, or null when memory had
   * nothing to say (or is off). */
  loadSnapshot(): Promise<MemoryBrief | null>;
}
