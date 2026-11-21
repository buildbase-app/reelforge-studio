/**
 * The tutorial matrix: agents (rows) x engines (columns). Every proof script
 * and every generated tutorial page reads this file, so the prompt a page shows
 * is the prompt the proof ran.
 */

export const AGENTS = ['claude-code', 'codex', 'mcp-sdk', 'rest', 'local-ai'] as const;
export type AgentId = (typeof AGENTS)[number];

export const CELL_ENGINES = ['remotion', 'motion-canvas', 'html', 'hyperframes', 'multi-engine'] as const;
export type CellEngine = (typeof CELL_ENGINES)[number];

export interface AgentInfo {
  title: string;
  /** Short label for the matrix. */
  label: string;
  /** Drives the studio with a language model (prompt, turns, transcript). */
  llm: boolean;
  /** Why the row cannot be proven here, when it cannot. */
  blocked?: string;
  /** The same, in two or three words for the matrix. */
  short?: string;
}

export const AGENT_INFO: Record<AgentId, AgentInfo> = {
  'claude-code': { title: 'Claude Code over MCP', label: 'Claude Code (MCP)', llm: true },
  codex: {
    title: 'OpenAI Codex CLI over MCP',
    label: 'OpenAI Codex CLI (MCP)',
    llm: true,
    blocked: 'needs an OpenAI API key, pending from the founder',
    short: 'OpenAI key pending',
  },
  'mcp-sdk': { title: 'Any MCP client (TypeScript SDK script)', label: 'Any MCP client (SDK script)', llm: false },
  rest: { title: 'REST API (curl and fetch)', label: 'REST (curl / fetch)', llm: false },
  'local-ai': { title: 'Local AI over MCP (open-weight model on your CPU)', label: 'Local AI (node-llama-cpp, MCP)', llm: true },
};

export interface EngineInfo {
  title: string;
  /** Engine ids every scene must use (one for a single-engine cell, all four for multi-engine). */
  engines: readonly string[];
  /** Built-in template per engine. */
  templates: readonly string[];
  /** The manifest the deterministic rows (SDK, REST) send. */
  manifest: string;
  /** Frames the deterministic rows must produce (30 fps). */
  frames: number;
  /** What the reel is about (LLM rows). */
  topic: string;
  /** One line on what to build, for the LLM prompt. */
  brief: string;
}

export const ENGINE_INFO: Record<CellEngine, EngineInfo> = {
  remotion: {
    title: 'Remotion',
    engines: ['remotion'],
    templates: ['kinetic-title'],
    manifest: 'examples/tutorials/remotion.json',
    frames: 240,
    topic: 'why short product videos beat long ones',
    brief: 'an 8-second reel made of two 4-second scenes, both using only the remotion engine (template kinetic-title)',
  },
  'motion-canvas': {
    title: 'Motion Canvas',
    engines: ['motion-canvas'],
    templates: ['animated-explainer'],
    manifest: 'examples/tutorials/motion-canvas.json',
    frames: 240,
    topic: 'three steps to plan a product demo',
    brief: 'an 8-second reel with one scene using only the motion-canvas engine (template animated-explainer, three points)',
  },
  html: {
    title: 'HTML',
    engines: ['html'],
    templates: ['html-title'],
    manifest: 'examples/tutorials/html.json',
    frames: 240,
    topic: 'a launch announcement for a note-taking app',
    brief: 'an 8-second reel made of two 4-second scenes, both using only the html engine (template html-title)',
  },
  hyperframes: {
    title: 'HyperFrames',
    engines: ['hyperframes'],
    templates: ['hyperframes-title'],
    manifest: 'examples/tutorials/hyperframes.json',
    frames: 240,
    topic: 'two quick tips for better thumbnails',
    brief: 'an 8-second reel made of two 4-second scenes, both using only the hyperframes engine (template hyperframes-title)',
  },
  'multi-engine': {
    title: 'Multi-engine',
    engines: ['remotion', 'motion-canvas', 'html', 'hyperframes'],
    templates: ['kinetic-title', 'animated-explainer', 'html-title', 'hyperframes-title'],
    manifest: 'examples/tutorials/multi-engine.json',
    frames: 270,
    topic: 'how one reel can mix four render engines',
    brief:
      'a 9-second reel with four scenes in this order: remotion (kinetic-title, 2 s), motion-canvas (animated-explainer, 3 s), html (html-title, 2 s), hyperframes (hyperframes-title, 2 s)',
  },
};

/** Project id an agent must use, so the proof can find its project. */
export function projectIdFor(agent: AgentId, engine: CellEngine): string {
  return `tut-${agent}-${engine}`;
}

/** The exact prompt the LLM rows send. Kept short: every token is paid for (or computed on a CPU). */
export function promptFor(agent: AgentId, engine: CellEngine): string {
  const e = ENGINE_INFO[engine];
  return [
    `You are connected to a ReelForge video studio through the "reelforge" MCP server.`,
    `Make a vertical reel (1080x1920, 30 fps) about ${e.topic}: ${e.brief}.`,
    `Use the project id "${projectIdFor(agent, engine)}".`,
    `Check list_templates for the props, create the project, validate it, render it,`,
    `call get_job with waitSeconds 45 until the job succeeds, then call get_render_output.`,
    `Reply with the project id, job id, render id, duration and frame count. Use only the reelforge tools.`,
  ].join(' ');
}

/** What every proof checks with ffprobe. */
export interface ReelExpectation {
  width: number;
  height: number;
  fps: number;
  /** Exact frame count (deterministic rows). */
  frames?: number;
  /** Duration bounds in seconds (LLM rows choose their own timing within the brief). */
  minSeconds: number;
  maxSeconds: number;
  /** Every render carries an AAC track (silence when there is no audio). */
  audio: boolean;
}

export function expectationFor(agent: AgentId, engine: CellEngine): ReelExpectation {
  const e = ENGINE_INFO[engine];
  const base = { width: 1080, height: 1920, fps: 30, audio: true };
  if (AGENT_INFO[agent].llm) return { ...base, minSeconds: 6, maxSeconds: 12 };
  return { ...base, frames: e.frames, minSeconds: e.frames / 30 - 0.1, maxSeconds: e.frames / 30 + 0.1 };
}

export function isAgent(x: string): x is AgentId {
  return (AGENTS as readonly string[]).includes(x);
}
export function isCellEngine(x: string): x is CellEngine {
  return (CELL_ENGINES as readonly string[]).includes(x);
}
