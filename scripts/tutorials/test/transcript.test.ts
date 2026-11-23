import { describe, expect, it } from 'vitest';
import { summarizeCodexJsonl } from '../drivers/llm-cli';
import { parseResultLine } from '../drivers/scripted';
import { redact } from '../prove';
import { describeCall, jobIdFromResult, shortToolName, summarizeTranscript } from '../lib/transcript';

const lines = [
  { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 't1', name: 'mcp__reelforge__list_templates', input: { engine: 'html' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"templates":[]}' }] }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__reelforge__render_project', input: { projectId: 'p' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: '{"job":{"id":"job_abc123","status":"queued"}}' }] }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'mcp__reelforge__get_job', input: { jobId: 'job_abc123', waitSeconds: 45 } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'boom' }] } },
  'not json',
  { type: 'result', subtype: 'success', is_error: false, num_turns: 4, duration_ms: 1234, total_cost_usd: 0.01, result: 'done' },
]
  .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
  .join('\n');

describe('summarizeTranscript (Claude Code stream-json)', () => {
  it('lists tool calls in order with results, and the job id from render_project', () => {
    const s = summarizeTranscript(lines);
    expect(s.toolCalls.map((c) => c.name)).toEqual(['list_templates', 'render_project', 'get_job']);
    expect(s.toolCalls[2]!.isError).toBe(true);
    expect(s.jobIds).toEqual(['job_abc123']);
    expect(s).toMatchObject({ turns: 4, durationMs: 1234, costUsd: 0.01, model: 'claude-sonnet-5-5', isError: false, reply: 'done' });
  });
  it('handles an empty transcript', () => {
    expect(summarizeTranscript('')).toMatchObject({ toolCalls: [], jobIds: [], turns: null });
  });
});

describe('helpers', () => {
  it('shortens MCP tool names', () => {
    expect(shortToolName('mcp__reelforge__create_project')).toBe('create_project');
    expect(shortToolName('mcp__my_server__get_job')).toBe('get_job');
    expect(shortToolName('get_job')).toBe('get_job');
  });
  it('finds job ids in results', () => {
    expect(jobIdFromResult('{"job":{"id":"job_x1"}}')).toBe('job_x1');
    expect(jobIdFromResult('prefix {"id": "job_y2"} suffix')).toBe('job_y2');
    expect(jobIdFromResult('{"id":"run_1"}')).toBeNull();
  });
  it('describes calls by argument names only (no values, no secrets)', () => {
    expect(describeCall({ name: 'get_job', input: { jobId: 'job_1', waitSeconds: 45 } })).toBe('get_job(jobId, waitSeconds)');
    expect(describeCall({ name: 'x', input: {}, isError: true })).toBe('x() -> error');
  });
  it('reads the RESULT line of the example scripts', () => {
    expect(parseResultLine('log\nRESULT {"jobId":"job_1"}\n')).toEqual({ jobId: 'job_1' });
    expect(() => parseResultLine('no result')).toThrow(/no RESULT line/);
  });
  it('redacts signed links and API keys before a proof is committed', () => {
    expect(redact('/v1/renders/r/output?expires=1&sig=abc_DEF-123 and rf_abcdefgh12345678')).toBe('/v1/renders/r/output?expires=1&sig=<redacted> and rf_<redacted>');
  });
  it('reads Codex exec JSON events', () => {
    const jsonl = [
      { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'reelforge', tool: 'render_project', arguments: { projectId: 'p' }, result: { content: [{ type: 'text', text: '{"job":{"id":"job_c1"}}' }] }, status: 'completed' } },
      { type: 'item.started', item: { type: 'mcp_tool_call', tool: 'get_job' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'hi' } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    const s = summarizeCodexJsonl(jsonl);
    expect(s.toolCalls).toEqual([{ name: 'render_project', input: { projectId: 'p' }, isError: false }]);
    expect(s.jobIds).toEqual(['job_c1']);
  });
});
