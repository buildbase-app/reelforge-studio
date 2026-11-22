/**
 * Read an agent transcript (Claude Code `--output-format stream-json`, or the
 * JSONL the other drivers write in the same shape) into the facts a proof
 * records: which tools were called, in which order, and the final result.
 */

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  /** The tool result text (truncated), when the transcript has it. */
  result?: string;
  isError?: boolean;
}

export interface TranscriptSummary {
  toolCalls: ToolCall[];
  /** Job ids returned by render_project calls, in order. */
  jobIds: string[];
  turns: number | null;
  durationMs: number | null;
  costUsd: number | null;
  model: string | null;
  isError: boolean | null;
  reply: string;
}

/** `mcp__reelforge__create_project` -> `create_project`. */
export function shortToolName(name: string): string {
  const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name);
  return m ? m[1]! : name;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : '')).join('');
  return '';
}

/** Job id from a render_project result: `{ "job": { "id": "job_..." } }`. */
export function jobIdFromResult(text: string): string | null {
  try {
    const j = JSON.parse(text);
    const id = j?.job?.id ?? j?.jobId ?? j?.id;
    if (typeof id === 'string' && id.startsWith('job_')) return id;
  } catch {
    /* fall through to the regex */
  }
  const m = /"id"\s*:\s*"(job_[A-Za-z0-9]+)"/.exec(text);
  return m ? m[1]! : null;
}

export function summarizeTranscript(jsonl: string): TranscriptSummary {
  const calls = new Map<string, ToolCall>();
  const order: ToolCall[] = [];
  const s: TranscriptSummary = { toolCalls: order, jobIds: [], turns: null, durationMs: null, costUsd: null, model: null, isError: null, reply: '' };
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'system' && e.subtype === 'init' && typeof e.model === 'string') s.model = e.model;
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === 'tool_use') {
          const call: ToolCall = { name: shortToolName(String(c.name)), input: c.input ?? {} };
          calls.set(String(c.id), call);
          order.push(call);
        }
      }
    }
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type !== 'tool_result') continue;
        const call = calls.get(String(c.tool_use_id));
        if (!call) continue;
        const text = textOf(c.content);
        call.result = text.slice(0, 2000);
        call.isError = c.is_error === true;
        if (call.name === 'render_project' && !call.isError) {
          const id = jobIdFromResult(text);
          if (id) s.jobIds.push(id);
        }
      }
    }
    if (e.type === 'result') {
      s.turns = typeof e.num_turns === 'number' ? e.num_turns : null;
      s.durationMs = typeof e.duration_ms === 'number' ? e.duration_ms : null;
      s.costUsd = typeof e.total_cost_usd === 'number' ? e.total_cost_usd : null;
      s.isError = typeof e.is_error === 'boolean' ? e.is_error : null;
      s.reply = typeof e.result === 'string' ? e.result : '';
    }
  }
  return s;
}

/** A one-line view of a call for the proof table: `add_scene(projectId, scene)`. */
export function describeCall(c: ToolCall): string {
  const keys = Object.keys(c.input ?? {});
  return `${c.name}(${keys.join(', ')})${c.isError ? ' -> error' : ''}`;
}
