import type { AgentId, CellEngine } from '../cells';
import type { Studio } from '../lib/studio';
import type { ToolCall } from '../lib/transcript';

export interface DriverContext {
  studio: Studio;
  /** Artefact directory for this cell (outside the repository). */
  outDir: string;
  agent: AgentId;
  engine: CellEngine;
  projectId: string;
}

export interface DriverResult {
  /** The command a reader runs to reproduce the cell (secrets elided). */
  command: string;
  prompt?: string;
  toolCalls: ToolCall[];
  /** The render job the agent started (the proof checks it independently). */
  jobId: string | null;
  transcriptPath?: string;
  llm?: {
    model: string | null;
    turns: number | null;
    durationMs: number | null;
    costUsd: number | null;
    isError: boolean | null;
    reply: string;
    exitCode?: number;
  };
}

export type Driver = (ctx: DriverContext) => Promise<DriverResult>;
