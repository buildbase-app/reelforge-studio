#!/usr/bin/env node
/**
 * A small local agent: an open-weight model on your own CPU drives RenderWeld
 * Studio over MCP. No cloud model, no API key for the model.
 *
 *   1. The MCP SDK client connects to the studio and lists its tools.
 *   2. A curated subset is converted to the model's tool-calling format.
 *   3. The model calls tools until the render job has succeeded and the
 *      output has been fetched (or the tool-call budget runs out).
 *
 * Backends:
 *   LOCAL_AGENT_BACKEND=llama-cpp (default): node-llama-cpp runs a GGUF file in
 *     this process; its function calling constrains every call's arguments with
 *     a grammar built from the tool's JSON Schema.
 *   LOCAL_AGENT_BACKEND=openai: any OpenAI-compatible chat endpoint with tools,
 *     e.g. Ollama (http://127.0.0.1:11434/v1) or llama.cpp's llama-server --jinja.
 *
 * Environment:
 *   RENDERWELD_URL, RENDERWELD_API_KEY   the studio and a key (read,write,render)
 *   LOCAL_AGENT_MODEL                  llama-cpp: path to the .gguf file; openai: the model name
 *   LOCAL_AGENT_MODULES                folder where `npm i node-llama-cpp` was run (llama-cpp backend)
 *   LOCAL_AGENT_BASE_URL               openai backend, default http://127.0.0.1:11434/v1
 *   LOCAL_AGENT_MAX_TOOL_CALLS         budget, default 25
 *   LOCAL_AGENT_CONTEXT                context size in tokens, default 4096 (older turns are shifted out)
 *   LOCAL_AGENT_THREADS                CPU threads (default: all cores)
 *   LOCAL_AGENT_TRACE                  write every step as JSON lines to this file
 *
 *   node scripts/tutorials/local-agent.mjs "Make an 8-second reel ..."
 *
 * The last line it prints is `RESULT {json}` (job, render, tool calls, turns).
 */
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Tools the local model sees, and the optional parameters it may set (node-llama-cpp makes every listed property required). */
export const LOCAL_TOOLS = {
  list_templates: ['engine'],
  create_project: [],
  validate_project: [],
  update_scene: [],
  render_project: [],
  get_job: ['waitSeconds'],
  get_render_output: ['jobId'],
};

/** Arguments the agent loop always sets, whatever the model sends. */
export const FIXED_ARGS = { get_render_output: { includePoster: false }, get_job: { waitSeconds: 45 } };

const SYSTEM_PROMPT = `You are a video production agent connected to a RenderWeld studio through tools.
Work step by step: call one tool, read its result, then decide the next call.
A manifest looks like {"schemaVersion":"0.2","projectId":"...","title":"...","output":{"width":1080,"height":1920,"fps":30,"format":"mp4"},"scenes":[{"id":"intro","engine":"html","template":"html-title","durationSeconds":4,"props":{"headline":"..."}}]}.
Scene props must match the template's props schema from list_templates. If a tool returns an error, fix the arguments and call it again.
After render_project, call get_job with the job id until its status is "succeeded", then call get_render_output with that job id, then answer in one short paragraph.`;

/**
 * Convert an MCP tool input JSON Schema into node-llama-cpp's GBNF JSON schema
 * subset: keep the required properties plus the allowed optional ones, map
 * free-form objects (z.record) to `additionalProperties: true`, unions to oneOf,
 * and drop keywords the grammar does not support.
 */
export function toGbnfSchema(schema, keepOptional = []) {
  const s = schema ?? {};
  if (s.anyOf || s.oneOf) return withDesc({ oneOf: (s.anyOf ?? s.oneOf).map((x) => toGbnfSchema(x)) }, s);
  if (s.enum) return withDesc({ enum: s.enum }, s);
  if (s.const !== undefined) return withDesc({ const: s.const }, s);
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === 'object' || s.properties || s.additionalProperties) {
    const required = new Set([...(s.required ?? []), ...keepOptional]);
    const props = Object.entries(s.properties ?? {}).filter(([k]) => required.has(k));
    if (!props.length) return withDesc({ type: 'object', additionalProperties: true }, s);
    return withDesc({ type: 'object', properties: Object.fromEntries(props.map(([k, v]) => [k, toGbnfSchema(v)])) }, s);
  }
  if (type === 'array') return withDesc({ type: 'array', ...(s.items ? { items: toGbnfSchema(s.items) } : {}) }, s);
  if (['string', 'number', 'integer', 'boolean', 'null'].includes(type)) return withDesc({ type }, s);
  // `{}` (z.unknown): any JSON value.
  return withDesc({ type: ['string', 'number', 'boolean', 'null'] }, s);
}
function withDesc(out, s) {
  return s.description ? { ...out, description: String(s.description).slice(0, 300) } : out;
}

/** A tool description cut to its first sentences (at most 400 characters): small models, small context. */
export function shortDescription(text = '') {
  if (text.length <= 400) return text;
  const cut = text.slice(0, 400);
  const end = cut.lastIndexOf('. ');
  return end > 100 ? cut.slice(0, end + 1) : cut + '...';
}

/** The same tools in the OpenAI `tools` format (for Ollama / llama-server). */
export function toOpenAiTool(tool, keepOptional = []) {
  const s = tool.inputSchema ?? { type: 'object', properties: {} };
  const keep = new Set([...(s.required ?? []), ...keepOptional]);
  const properties = Object.fromEntries(Object.entries(s.properties ?? {}).filter(([k]) => keep.has(k)));
  return { type: 'function', function: { name: tool.name, description: shortDescription(tool.description), parameters: { type: 'object', properties, required: [...keep] } } };
}

/** Keep tool results short for a small context: long JSON is cut, images are dropped. */
export function compactResult(result, max = 1500) {
  const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const t = text.length > max ? text.slice(0, max) + ` ... [${text.length - max} more characters cut]` : text;
  return result.isError ? `ERROR: ${t}` : t;
}

/**
 * Tool calls a model wrote as text: Qwen/Hermes-style `<tool_call>{"name": ..., "arguments": {...}}</tool_call>`
 * blocks (any whitespace), or a bare JSON object with name and arguments.
 */
export function textToolCalls(text) {
  const out = [];
  const blocks = [...String(text).matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].map((m) => m[1]);
  if (!blocks.length && /^\s*\{[\s\S]*\}\s*$/.test(String(text))) blocks.push(String(text));
  for (const b of blocks) {
    try {
      const j = JSON.parse(b);
      if (typeof j?.name === 'string') out.push({ name: j.name, arguments: j.arguments ?? j.parameters ?? {} });
    } catch {
      /* not a call */
    }
  }
  return out;
}

/** The loop's bookkeeping: what was called, the job, whether the reel is done. */
export class AgentState {
  constructor(maxToolCalls) {
    this.maxToolCalls = maxToolCalls;
    this.toolCalls = [];
    this.jobId = null;
    this.renderId = null;
    this.jobStatus = null;
  }
  get done() {
    return Boolean(this.renderId);
  }
  get exhausted() {
    return this.toolCalls.length >= this.maxToolCalls;
  }
  /** Record a call and what its result tells us. */
  observe(name, input, result) {
    this.toolCalls.push({ name, input, isError: result.isError === true });
    if (result.isError) return;
    let json;
    try {
      json = JSON.parse((result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
    } catch {
      return;
    }
    if (name === 'render_project' && json?.job?.id) this.jobId = json.job.id;
    if (name === 'get_job' && json?.status) this.jobStatus = json.status;
    if (name === 'get_render_output' && json?.renderId) this.renderId = json.renderId;
  }
}

async function connectMcp() {
  const load = async (spec) => {
    try {
      return await import(spec);
    } catch {
      const dir = process.env.LOCAL_AGENT_MODULES;
      if (!dir) throw new Error(`cannot load ${spec}: run npm i @modelcontextprotocol/sdk in a folder and set LOCAL_AGENT_MODULES`);
      return import(pathToFileURL(createRequire(join(dir, 'package.json')).resolve(spec)).href);
    }
  };
  const { Client } = await load('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await load('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const base = (process.env.RENDERWELD_URL ?? 'http://127.0.0.1:4321').replace(/\/$/, '');
  const client = new Client({ name: 'reelforge-local-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${process.env.RENDERWELD_API_KEY}` } } }));
  return client;
}

function trace(event) {
  if (process.env.LOCAL_AGENT_TRACE) appendFileSync(process.env.LOCAL_AGENT_TRACE, JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n');
}

/** Call an MCP tool for the model, with the fixed arguments merged in. */
async function callTool(client, state, name, args) {
  const input = { ...(args ?? {}), ...(FIXED_ARGS[name] ?? {}) };
  let result;
  try {
    result = await client.callTool({ name, arguments: input });
  } catch (e) {
    result = { isError: true, content: [{ type: 'text', text: String(e.message ?? e) }] };
  }
  state.observe(name, input, result);
  const text = compactResult(result);
  console.log(`  [${state.toolCalls.length}] ${name}(${Object.keys(input).join(', ')})${result.isError ? ' -> ERROR' : ''}`);
  trace({ type: 'tool_call', name, input, isError: result.isError === true, result: text.slice(0, 1500) });
  return text;
}

/**
 * What the model gets after a context reset. Once a render job exists, the task is
 * only to finish that job: repeating the original prompt made a small model start
 * over (list templates, create, render again) and loop.
 */
export function recapAfterReset(prompt, state) {
  if (state.jobId) return `You already created the project and started render job ${state.jobId}; do not create or render again. ${NUDGE(state)}`;
  return `${prompt}\n\nProgress so far: ${state.toolCalls.map((c) => c.name).join(', ') || 'nothing'}. ${NUDGE(state)}`;
}

const NUDGE = (state) =>
  state.jobId
    ? `The render job ${state.jobId} is ${state.jobStatus ?? 'started'}. Call get_job with jobId "${state.jobId}" until it succeeds, then call get_render_output with that jobId.`
    : 'The reel is not rendered yet. Continue with the next tool call.';

async function runLlamaCpp(client, tools, prompt, state) {
  const dir = process.env.LOCAL_AGENT_MODULES;
  const spec = 'node-llama-cpp';
  const mod = dir ? await import(pathToFileURL(createRequire(join(dir, 'package.json')).resolve(spec)).href) : await import(spec);
  const { getLlama, LlamaChatSession, defineChatSessionFunction } = mod;
  const modelPath = process.env.LOCAL_AGENT_MODEL;
  if (!modelPath) throw new Error('set LOCAL_AGENT_MODEL to the path of a .gguf file');
  const llama = await getLlama({ gpu: process.env.LOCAL_AGENT_GPU ?? false });
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize: Number(process.env.LOCAL_AGENT_CONTEXT ?? 4096), ...(process.env.LOCAL_AGENT_THREADS ? { threads: Number(process.env.LOCAL_AGENT_THREADS) } : {}) });
  const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: SYSTEM_PROMPT });
  const controller = new AbortController();
  const functions = Object.fromEntries(
    tools.map((t) => [
      t.name,
      defineChatSessionFunction({
        description: shortDescription(t.description),
        params: toGbnfSchema(t.inputSchema, LOCAL_TOOLS[t.name]),
        handler: async (params) => {
          if (state.exhausted) {
            controller.abort();
            return 'Tool-call budget exhausted. Stop.';
          }
          const text = await callTool(client, state, t.name, params);
          if (state.done) controller.abort(); // the reel is finished: no need to let the model talk on
          return text;
        },
      }),
    ])
  );
  let reply = '';
  let turns = 0;
  let message = prompt;
  const offered = new Set(tools.map((t) => t.name));
  for (let round = 0; round < 30 && !state.done && !state.exhausted; round++) {
    const before = state.toolCalls.length;
    try {
      reply = await session.prompt(message, { functions, signal: controller.signal, stopOnAbortSignal: true, maxTokens: 1500, temperature: 0.2 });
    } catch (e) {
      // The loop aborts generation itself once the render is fetched (or the budget is spent).
      if (controller.signal.aborted) {
        turns += state.toolCalls.length - before;
        break;
      }
      // The history no longer fits the context (long tool results): start over from the system
      // prompt with a recap of the progress, instead of failing the whole run.
      if (!/context/i.test(String(e?.message))) throw e;
      trace({ type: 'assistant', round, text: `[context full: history reset] ${String(e.message).slice(0, 200)}` });
      session.setChatHistory(session.getChatHistory().slice(0, 1));
      message = recapAfterReset(prompt, state);
      turns++;
      continue;
    }
    turns += state.toolCalls.length - before + 1;
    trace({ type: 'assistant', round, text: reply.slice(0, 1500) });
    // Small models sometimes write the call as text (e.g. a pretty-printed <tool_call> block) instead of
    // the format the runtime detects. Run such calls too and answer in the model's own result format.
    const textCalls = textToolCalls(reply).filter((c) => offered.has(c.name));
    if (textCalls.length && !state.done) {
      const results = [];
      for (const c of textCalls.slice(0, 3)) results.push(`<tool_response>\n${await callTool(client, state, c.name, c.arguments)}\n</tool_response>`);
      message = results.join('\n');
      continue;
    }
    message = NUDGE(state);
  }
  return { reply, turns, model: modelPath.split('/').pop() };
}

async function runOpenAi(client, tools, prompt, state) {
  const base = (process.env.LOCAL_AGENT_BASE_URL ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  const model = process.env.LOCAL_AGENT_MODEL ?? 'qwen2.5:7b-instruct';
  const oaTools = tools.map((t) => toOpenAiTool(t, LOCAL_TOOLS[t.name]));
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }];
  let turns = 0;
  let reply = '';
  while (!state.done && !state.exhausted && turns < 40) {
    turns++;
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, tools: oaTools, temperature: 0.2 }),
    });
    if (!res.ok) throw new Error(`${base}/chat/completions -> ${res.status} ${await res.text()}`);
    const msg = (await res.json()).choices[0].message;
    messages.push(msg);
    if (!msg.tool_calls?.length) {
      reply = msg.content ?? '';
      trace({ type: 'assistant', text: reply.slice(0, 1500) });
      messages.push({ role: 'user', content: NUDGE(state) });
      continue;
    }
    for (const tc of msg.tool_calls) {
      let args = {};
      try {
        args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : tc.function.arguments;
      } catch {
        /* bad JSON: the tool answers with a validation error */
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: await callTool(client, state, tc.function.name, args) });
    }
  }
  return { reply, turns, model };
}

async function main() {
  const prompt = process.argv.slice(2).join(' ');
  if (!prompt || !process.env.RENDERWELD_API_KEY) {
    console.error('usage: RENDERWELD_API_KEY=rf_... LOCAL_AGENT_MODEL=... node scripts/tutorials/local-agent.mjs "<prompt>"');
    process.exit(2);
  }
  const client = await connectMcp();
  const { tools: all } = await client.listTools();
  const tools = all.filter((t) => t.name in LOCAL_TOOLS);
  console.log(`studio: ${all.length} tools, ${tools.length} offered to the local model`);
  const state = new AgentState(Number(process.env.LOCAL_AGENT_MAX_TOOL_CALLS ?? 25));
  const t0 = Date.now();
  const backend = process.env.LOCAL_AGENT_BACKEND ?? 'llama-cpp';
  const run = backend === 'openai' ? runOpenAi : runLlamaCpp;
  let out;
  try {
    out = await run(client, tools, prompt, state);
  } catch (e) {
    console.error(`agent stopped: ${e?.stack ?? e}`);
    out = { reply: `agent stopped: ${String(e?.message ?? e).slice(0, 300)}`, turns: null, model: process.env.LOCAL_AGENT_MODEL?.split('/').pop() ?? null };
  }
  await client.close().catch(() => undefined);
  const seconds = Math.round((Date.now() - t0) / 1000);
  console.log(`${state.done ? 'done' : 'NOT done'} after ${state.toolCalls.length} tool calls, ${out.turns} turns, ${seconds} s`);
  console.log('RESULT ' + JSON.stringify({ jobId: state.jobId, renderId: state.renderId, done: state.done, toolCalls: state.toolCalls, turns: out.turns, model: out.model, backend, seconds, reply: out.reply }));
  // node-llama-cpp keeps native handles open; exit explicitly.
  process.exit(state.done ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
