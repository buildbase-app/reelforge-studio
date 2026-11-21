import { spawn } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promptFor } from '../cells';
import { summarizeTranscript } from '../lib/transcript';
import type { Driver, DriverResult } from './types';

/** Run a command, tee stdout to a file, and resolve with the exit code. */
export function runToFile(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; out: string; timeoutMs: number }): Promise<number> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs);
    child.on('error', fail);
    child.on('exit', (code) => {
      clearTimeout(timer);
      writeFileSync(opts.out, out);
      if (err.trim()) writeFileSync(opts.out + '.stderr.txt', err);
      ok(code ?? 1);
    });
  });
}

export const MAX_TURNS = Number(process.env.TUTORIAL_MAX_TURNS ?? 25);

/**
 * Claude Code, headless: `claude -p` with only the studio's MCP server
 * (`--strict-mcp-config`), no built-in tools (`--tools ""`), only the reelforge
 * tools pre-approved, and a bounded number of turns. The transcript is
 * stream-json, one event per line.
 */
export const claudeCode: Driver = async ({ studio, outDir, agent, engine }) => {
  const mcpConfig = join(outDir, 'mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { reelforge: { type: 'http', url: `${studio.url}/mcp`, headers: { Authorization: `Bearer ${studio.key}` } } } }));
  chmodSync(mcpConfig, 0o600);
  const prompt = promptFor(agent, engine);
  const model = process.env.TUTORIAL_CLAUDE_MODEL ?? 'sonnet';
  const args = ['-p', prompt, '--model', model, '--mcp-config', mcpConfig, '--strict-mcp-config', '--tools', '', '--allowedTools', 'mcp__reelforge', '--max-turns', String(MAX_TURNS), '--output-format', 'stream-json', '--verbose'];
  const transcript = join(outDir, 'transcript.jsonl');
  const env = { ...process.env };
  delete env.CLAUDECODE; // allow running from inside another Claude Code session
  const t0 = Date.now();
  const code = await runToFile('claude', args, { env, cwd: outDir, out: transcript, timeoutMs: 30 * 60_000 }).finally(() => rmSync(mcpConfig, { force: true }));
  const s = summarizeTranscript(readFileSync(transcript, 'utf8'));
  const result: DriverResult = {
    command: `claude -p "<prompt>" --model ${model} --mcp-config mcp.json --strict-mcp-config --tools "" --allowedTools mcp__reelforge --max-turns ${MAX_TURNS} --output-format stream-json --verbose`,
    prompt,
    toolCalls: s.toolCalls,
    jobId: s.jobIds.at(-1) ?? null,
    transcriptPath: transcript,
    llm: { model: s.model, turns: s.turns, durationMs: s.durationMs ?? Date.now() - t0, costUsd: s.costUsd, isError: s.isError, reply: s.reply, exitCode: code },
  };
  return result;
};

/**
 * OpenAI Codex CLI, headless: `codex exec` with the studio as a Streamable HTTP
 * MCP server given by `-c` overrides (the same keys as ~/.codex/config.toml).
 * Not proven here yet: it needs an OpenAI API key. When the environment's
 * proxy injects the key for api.openai.com, the local value is a placeholder.
 * VERIFY the flags against `codex exec --help` of your version.
 */
export const codex: Driver = async ({ studio, outDir, agent, engine }) => {
  const prompt = promptFor(agent, engine);
  const transcript = join(outDir, 'transcript.jsonl');
  const env: NodeJS.ProcessEnv = { ...process.env, REELFORGE_API_KEY: studio.key };
  // A placeholder is enough when a proxy injects the real key; never write a real key here.
  if (!env.OPENAI_API_KEY && !env.CODEX_API_KEY) env.CODEX_API_KEY = env.OPENAI_API_KEY = 'sk-placeholder-injected-by-proxy';
  const model = process.env.TUTORIAL_CODEX_MODEL;
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-c',
    `mcp_servers.reelforge.url="${studio.url}/mcp"`,
    '-c',
    'mcp_servers.reelforge.bearer_token_env_var="REELFORGE_API_KEY"',
    '-c',
    'approval_policy="never"',
    ...(model ? ['-m', model] : []),
    prompt,
  ];
  const t0 = Date.now();
  const code = await runToFile('codex', args, { env, cwd: outDir, out: transcript, timeoutMs: 30 * 60_000 });
  const lines = readFileSync(transcript, 'utf8');
  const { toolCalls, jobIds } = summarizeCodexJsonl(lines);
  return {
    command: `codex exec --json --skip-git-repo-check --sandbox read-only -c mcp_servers.reelforge.url=... -c mcp_servers.reelforge.bearer_token_env_var="REELFORGE_API_KEY" -c approval_policy="never" "<prompt>"`,
    prompt,
    toolCalls,
    jobId: jobIds.at(-1) ?? null,
    transcriptPath: transcript,
    llm: { model: model ?? 'codex default', turns: null, durationMs: Date.now() - t0, costUsd: null, isError: code !== 0, reply: '', exitCode: code },
  };
};

/**
 * Tool calls from `codex exec --json` events. The event names changed between
 * Codex versions; this accepts items of type `mcp_tool_call` with
 * `server`/`tool`/`arguments`/`result` (VERIFY with your version).
 */
export function summarizeCodexJsonl(jsonl: string): { toolCalls: DriverResult['toolCalls']; jobIds: string[] } {
  const toolCalls: DriverResult['toolCalls'] = [];
  const jobIds: string[] = [];
  for (const line of jsonl.split('\n')) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const item = e.item ?? e.msg ?? e;
    if (item?.type !== 'mcp_tool_call' || (e.type && e.type !== 'item.completed')) continue;
    const resultText = JSON.stringify(item.result ?? '');
    toolCalls.push({ name: String(item.tool), input: item.arguments ?? {}, isError: item.status === 'failed' || Boolean(item.error) });
    const m = /job_[A-Za-z0-9]+/.exec(resultText);
    if (item.tool === 'render_project' && m) jobIds.push(m[0]);
  }
  return { toolCalls, jobIds };
}
