import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_INFO, HYGEN, HYGEN_TMPLS, hygenArgs, promptFor, shellQuote } from '../cells';
import { REPO } from '../lib/studio';
import { runToFile } from './llm-cli';
import type { Driver, DriverResult } from './types';

/** The `RESULT {json}` line the example scripts print last. */
export function parseResultLine(stdout: string): Record<string, any> {
  const line = stdout.split('\n').reverse().find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error('the script printed no RESULT line');
  return JSON.parse(line.slice('RESULT '.length));
}

async function runExample(cmd: string, args: string[], env: NodeJS.ProcessEnv, outDir: string, allowFail = false): Promise<Record<string, any>> {
  const log = join(outDir, 'transcript.txt');
  const code = await runToFile(cmd, args, { env: { ...process.env, ...env }, cwd: REPO, out: log, timeoutMs: Number(process.env.TUTORIAL_AGENT_TIMEOUT_MIN ?? 30) * 60_000 });
  const stdout = readFileSync(log, 'utf8');
  if (code !== 0 && !(allowFail && stdout.includes('\nRESULT '))) throw new Error(`${cmd} ${args.join(' ')} exited with ${code}:\n${stdout.slice(-2000)}\n${(() => { try { return readFileSync(log + '.stderr.txt', 'utf8').slice(-2000); } catch { return ''; } })()}`);
  return { ...parseResultLine(stdout), transcriptPath: log };
}

/** Any MCP client: the SDK script calls the tools one by one, no language model. */
export const mcpSdk: Driver = async ({ studio, outDir, engine, projectId }) => {
  const manifest = ENGINE_INFO[engine].manifest;
  const r = await runExample('node', ['examples/tutorials/mcp-client.mjs', manifest, projectId], { REELFORGE_URL: studio.url, REELFORGE_API_KEY: studio.key }, outDir);
  if (!r.posterAttached) throw new Error('get_render_output attached no poster image');
  return { command: `node examples/tutorials/mcp-client.mjs ${manifest} ${projectId}`, toolCalls: r.toolCalls, jobId: r.jobId, transcriptPath: r.transcriptPath };
};

/** REST with curl (default) or fetch (TUTORIAL_REST_CLIENT=fetch). */
export const restDriver: Driver = async ({ studio, outDir, engine, projectId }) => {
  const manifest = ENGINE_INFO[engine].manifest;
  const out = join(outDir, 'client-download.mp4');
  const fetchClient = process.env.TUTORIAL_REST_CLIENT === 'fetch';
  const r = fetchClient
    ? await runExample('node', ['examples/tutorials/rest-fetch.mjs', manifest, projectId, out], { REELFORGE_URL: studio.url, REELFORGE_API_KEY: studio.key }, outDir)
    : await runExample('bash', ['examples/tutorials/rest.sh', manifest, projectId, out], { RF: studio.url, KEY: studio.key }, outDir);
  return {
    command: fetchClient ? `node examples/tutorials/rest-fetch.mjs ${manifest} ${projectId} final.mp4` : `examples/tutorials/rest.sh ${manifest} ${projectId} final.mp4`,
    toolCalls: r.toolCalls,
    jobId: r.jobId,
    transcriptPath: r.transcriptPath,
  };
};

/** Local AI: an open-weight model in node-llama-cpp drives the MCP tools (scripts/tutorials/local-agent.mjs). */
export const localAi: Driver = async ({ studio, outDir, agent, engine }) => {
  const prompt = promptFor(agent, engine);
  const t0 = Date.now();
  const r = await runExample('node', ['scripts/tutorials/local-agent.mjs', prompt], { REELFORGE_URL: studio.url, REELFORGE_API_KEY: studio.key, LOCAL_AGENT_TRACE: join(outDir, 'trace.jsonl') }, outDir, true);
  const result: DriverResult = {
    command: 'node scripts/tutorials/local-agent.mjs "<prompt>"',
    prompt,
    toolCalls: r.toolCalls,
    jobId: r.jobId,
    transcriptPath: r.transcriptPath,
    llm: { model: r.model ?? null, turns: r.turns ?? null, durationMs: Date.now() - t0, costUsd: 0, isError: r.done !== true, reply: r.reply ?? '' },
  };
  return result;
};

/** Hygen: the generator writes the manifest from flags, then the REST script sends and renders it. */
export const hygenDriver: Driver = async ({ studio, outDir, engine, projectId }) => {
  const manifest = join(outDir, 'manifest.json');
  const log = join(outDir, 'hygen.txt');
  const env = { ...process.env, HYGEN_TMPLS, HYGEN_OVERWRITE: '1' };
  const code = await runToFile('pnpm', ['exec', 'hygen', ...hygenArgs(engine, projectId, manifest)], { env, cwd: REPO, out: log, timeoutMs: 120_000 });
  if (code !== 0) throw new Error(`hygen reel ${HYGEN[engine].action} exited with ${code}: ${readFileSync(log, 'utf8').slice(-1000)}`);
  const r = await runExample('bash', ['examples/tutorials/rest.sh', manifest, projectId, join(outDir, 'client-download.mp4')], { RF: studio.url, KEY: studio.key }, outDir);
  const shown = hygenArgs(engine, projectId, 'reel.json').map(shellQuote).join(' ');
  return {
    command: `HYGEN_TMPLS=${HYGEN_TMPLS} pnpm exec hygen ${shown} && examples/tutorials/rest.sh reel.json ${projectId} final.mp4`,
    toolCalls: [{ name: `hygen reel ${HYGEN[engine].action}`, input: {} }, ...r.toolCalls],
    jobId: r.jobId,
    transcriptPath: r.transcriptPath,
  };
};
