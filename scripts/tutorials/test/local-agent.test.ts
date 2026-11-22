import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain ESM script without type declarations
import { AgentState, FIXED_ARGS, LOCAL_TOOLS, compactResult, recapAfterReset, shortDescription, textToolCalls, toGbnfSchema, toOpenAiTool } from '../local-agent.mjs';

/** The shape zod 4 / the MCP SDK give a tool's inputSchema (e.g. get_job). */
const getJob = {
  type: 'object',
  properties: {
    jobId: { type: 'string' },
    waitSeconds: { type: 'integer', minimum: 0, maximum: 50, description: 'Wait up to this many seconds.' },
  },
  required: ['jobId'],
  additionalProperties: false,
  $schema: 'http://json-schema.org/draft-07/schema#',
};
const createProject = {
  type: 'object',
  properties: {
    manifest: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {}, description: 'A project manifest.' },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
  },
  required: ['manifest'],
};

describe('MCP tool schema -> node-llama-cpp grammar schema', () => {
  it('keeps required properties and the allowed optional ones, drops unsupported keywords', () => {
    expect(toGbnfSchema(getJob, ['waitSeconds'])).toEqual({
      type: 'object',
      properties: { jobId: { type: 'string' }, waitSeconds: { type: 'integer', description: 'Wait up to this many seconds.' } },
    });
    expect(toGbnfSchema(getJob)).toEqual({ type: 'object', properties: { jobId: { type: 'string' } } });
  });
  it('turns free-form objects (z.record) into any-keys objects and drops optional ones', () => {
    expect(toGbnfSchema(createProject)).toEqual({ type: 'object', properties: { manifest: { type: 'object', additionalProperties: true, description: 'A project manifest.' } } });
  });
  it('maps unions, enums, arrays and unknown values', () => {
    expect(toGbnfSchema({ anyOf: [{ type: 'string' }, { type: 'object', properties: { base: { type: 'string' } }, required: ['base'] }] })).toEqual({
      oneOf: [{ type: 'string' }, { type: 'object', properties: { base: { type: 'string' } } }],
    });
    expect(toGbnfSchema({ type: 'string', enum: ['a', 'b'] })).toEqual({ enum: ['a', 'b'] });
    expect(toGbnfSchema({ type: 'array', items: { type: 'string', minLength: 1 } })).toEqual({ type: 'array', items: { type: 'string' } });
    expect(toGbnfSchema({})).toEqual({ type: ['string', 'number', 'boolean', 'null'] });
    expect(toGbnfSchema({ type: 'object', properties: {} })).toEqual({ type: 'object', additionalProperties: true });
  });
  it('produces OpenAI-format tools for Ollama / llama-server', () => {
    const t = toOpenAiTool({ name: 'get_job', description: 'Status', inputSchema: getJob }, ['waitSeconds']);
    expect(t).toEqual({ type: 'function', function: { name: 'get_job', description: 'Status', parameters: { type: 'object', properties: getJob.properties, required: ['jobId', 'waitSeconds'] } } });
  });
  it('offers a small tool set and pins the arguments a small model gets wrong', () => {
    expect(Object.keys(LOCAL_TOOLS)).toContain('render_project');
    expect(FIXED_ARGS.get_render_output).toEqual({ includePoster: false });
  });
});

describe('agent loop state', () => {
  const ok = (json: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(json) }] });
  it('follows render_project -> get_job -> get_render_output to done', () => {
    const s = new AgentState(5);
    s.observe('render_project', {}, ok({ job: { id: 'job_1', status: 'queued' } }));
    expect(s.jobId).toBe('job_1');
    s.observe('get_job', {}, ok({ status: 'running' }));
    expect(s.done).toBe(false);
    s.observe('get_job', {}, ok({ status: 'succeeded' }));
    s.observe('get_render_output', {}, ok({ renderId: 'run_1' }));
    expect(s).toMatchObject({ jobStatus: 'succeeded', renderId: 'run_1' });
    expect([s.done, s.exhausted]).toEqual([true, false]);
    expect(s.toolCalls.map((c: { name: string }) => c.name)).toEqual(['render_project', 'get_job', 'get_job', 'get_render_output']);
  });
  it('records errors without taking ids from them, and stops at the budget', () => {
    const s = new AgentState(2);
    s.observe('render_project', {}, { isError: true, content: [{ type: 'text', text: '{"job":{"id":"job_no"}}' }] });
    expect(s.jobId).toBeNull();
    expect(s.exhausted).toBe(false);
    s.observe('get_job', {}, { content: [{ type: 'text', text: 'not json' }] });
    expect(s.exhausted).toBe(true);
  });
  it('reads tool calls a model wrote as text', () => {
    const pretty = '<tool_call>\n{\n  "name": "list_templates",\n  "arguments": {\n    "engine": "html"\n  }\n}\n</tool_call>';
    expect(textToolCalls(pretty)).toEqual([{ name: 'list_templates', arguments: { engine: 'html' } }]);
    expect(textToolCalls('{"name":"get_job","arguments":{"jobId":"job_1"}}')).toEqual([{ name: 'get_job', arguments: { jobId: 'job_1' } }]);
    expect(textToolCalls('All done, the reel is rendered.')).toEqual([]);
    expect(textToolCalls('<tool_call>{broken</tool_call>')).toEqual([]);
  });
  it('after a context reset, a started render is finished, not started again', () => {
    const s = new AgentState(25);
    expect(recapAfterReset('Make a reel.', s)).toMatch(/^Make a reel\.\n\nProgress so far: nothing\./);
    s.observe('render_project', {}, { content: [{ type: 'text', text: '{"job":{"id":"job_9"}}' }] });
    const r = recapAfterReset('Make a reel.', s);
    expect(r).not.toContain('Make a reel.');
    expect(r).toContain('do not create or render again');
    expect(r).toContain('job_9');
  });
  it('shortens long tool descriptions at a sentence end', () => {
    expect(shortDescription('Short.')).toBe('Short.');
    const long = 'First sentence is here and it is long enough to keep. '.repeat(10);
    const out = shortDescription(long);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out.endsWith('.')).toBe(true);
  });
  it('cuts long results and drops images', () => {
    const r = compactResult({ content: [{ type: 'text', text: 'x'.repeat(30) }, { type: 'image', data: 'AAAA' }] }, 10);
    expect(r).toBe('xxxxxxxxxx ... [20 more characters cut]');
    expect(compactResult({ isError: true, content: [{ type: 'text', text: 'bad' }] })).toBe('ERROR: bad');
  });
});
