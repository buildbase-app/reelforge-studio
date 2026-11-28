/**
 * Reproduce one cell of the tutorial matrix and check its output.
 *
 *   pnpm tutorials:prove <agent> <engine|all> [--record]
 *
 *   agent:  claude-code | codex | mcp-sdk | rest | local-ai | hygen
 *   engine: remotion | motion-canvas | html | hyperframes | multi-engine | all
 *
 * Starts a studio from this checkout (RENDERWELD_LICENCE_MODE=off, local
 * development only) unless RENDERWELD_URL and RENDERWELD_API_KEY name one, runs
 * the agent, then checks independently over REST: the job succeeded, the
 * project uses the cell's engines, and the downloaded MP4 passes ffprobe
 * (size, fps, decoded frames, duration, H.264 + AAC). Artefacts go to
 * $TUTORIAL_OUT (default: $TMPDIR/reelforge-tutorials), never into the repo;
 * --record (or --record-only, for the last run's proof.json) copies the small proof JSON and a poster JPEG (<= 60 KB) into
 * docs/tutorials/proofs/. Exits non-zero on any failure.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGENT_INFO, CELL_ENGINES, ENGINE_INFO, expectationFor, isAgent, isCellEngine, projectIdFor, type AgentId, type CellEngine } from './cells';
import { claudeCode, codex } from './drivers/llm-cli';
import { hygenDriver, localAi, mcpSdk, restDriver } from './drivers/scripted';
import type { Driver, DriverResult } from './drivers/types';
import { checkEngines, checkReel, probeFile, sceneEngines, type ReelProbe } from './lib/probe';
import { REPO, rest, useStudio, type Studio } from './lib/studio';
import { describeCall } from './lib/transcript';

const DRIVERS: Record<AgentId, Driver> = { 'claude-code': claudeCode, codex, 'mcp-sdk': mcpSdk, rest: restDriver, 'local-ai': localAi, hygen: hygenDriver };

export interface Proof {
  agent: AgentId;
  engine: CellEngine;
  status: 'passed' | 'failed';
  date: string;
  studioVersion: string;
  commit: string;
  licenceMode: string;
  command: string;
  prompt?: string;
  projectId: string | null;
  jobId: string | null;
  renderId: string | null;
  renderSeconds: number | null;
  sceneEngines: string[];
  toolCalls: string[];
  probe: ReelProbe | null;
  poster: string | null;
  llm?: DriverResult['llm'];
  problems: string[];
  /** Where the full artefacts of this run are (outside the repository). */
  artefacts: string;
}

/** Poster: one frame at 40 % of the reel, 270 px wide, JPEG; quality lowered until it fits in 60 KB. */
export function makePoster(mp4: string, durationSeconds: number, out: string): number {
  for (const q of [5, 8, 12, 18]) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.max(0, durationSeconds * 0.4)), '-i', mp4, '-frames:v', '1', '-vf', 'scale=270:-2', '-q:v', String(q), out]);
    const size = statSync(out).size;
    if (size <= 60 * 1024) return size;
  }
  throw new Error(`poster ${out} is over 60 KB`);
}

function gitCommit(): string {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

export async function proveCell(studio: Studio, agent: AgentId, engine: CellEngine, outRoot: string): Promise<Proof> {
  const outDir = join(outRoot, agent, engine);
  mkdirSync(outDir, { recursive: true });
  const api = rest(studio);
  const caps = await api.get('/v1/capabilities');
  const projectId = projectIdFor(agent, engine);
  const proof: Proof = {
    agent,
    engine,
    status: 'failed',
    date: new Date().toISOString(),
    studioVersion: String(caps.server?.version ?? 'unknown'),
    commit: gitCommit(),
    licenceMode: studio.owned ? 'off (local development only)' : String(caps.licence?.mode ?? 'unknown'),
    command: `pnpm tutorials:prove ${agent} ${engine}`,
    projectId: null,
    jobId: null,
    renderId: null,
    renderSeconds: null,
    sceneEngines: [],
    toolCalls: [],
    probe: null,
    poster: null,
    problems: [],
    artefacts: outDir,
  };
  try {
    console.log(`\n== ${AGENT_INFO[agent].title} x ${ENGINE_INFO[engine].title} (artefacts: ${outDir})`);
    // A re-run starts clean: an agent told to create this project id must not find an old one.
    if (AGENT_INFO[agent].llm) await api.del(`/v1/projects/${projectId}`).catch(() => undefined);
    const r =await DRIVERS[agent]({ studio, outDir, agent, engine, projectId });
    proof.command = r.command;
    proof.prompt = r.prompt;
    proof.llm = r.llm;
    proof.toolCalls = r.toolCalls.map(describeCall);
    console.log(`   tool calls (${r.toolCalls.length}): ${r.toolCalls.map((c) => c.name).join(' -> ')}`);
    if (r.llm) console.log(`   model ${r.llm.model}, turns ${r.llm.turns}, ${Math.round((r.llm.durationMs ?? 0) / 1000)} s, cost ${r.llm.costUsd ?? 'n/a'} USD`);
    if (r.llm?.isError === true) proof.problems.push(`the agent did not finish cleanly: ${(r.llm.reply || 'no reply').split('\n')[0]!.slice(0, 300)}`);
    if (!r.jobId) throw new Error('the agent started no render job (no render_project call returned a job)');
    proof.jobId = r.jobId;

    const job = await api.waitJob(r.jobId);
    if (job.status !== 'succeeded') throw new Error(`job ${r.jobId} ${job.status}: ${JSON.stringify(job.error)}`);
    proof.renderId = job.result.renderId;
    proof.projectId = job.projectId ?? job.params?.projectId;
    proof.renderSeconds = Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 100) / 10;
    if (proof.projectId !== projectId) proof.problems.push(`the agent used project id ${proof.projectId}, the prompt asked for ${projectId}`);

    const project = await api.get(`/v1/projects/${proof.projectId}?version=${job.params.version}`).catch(() => api.get(`/v1/projects/${proof.projectId}`));
    proof.sceneEngines = sceneEngines(project.manifest);
    proof.problems.push(...checkEngines(proof.sceneEngines, ENGINE_INFO[engine].engines));

    const mp4 = join(outDir, 'final.mp4');
    await api.download(proof.renderId!, 'final.mp4', mp4);
    proof.probe = probeFile(mp4);
    proof.problems.push(...checkReel(proof.probe, expectationFor(agent, engine)));
    const poster = join(outDir, 'poster.jpg');
    makePoster(mp4, proof.probe.durationSeconds, poster);
    proof.poster = poster;
    console.log(`   job ${proof.jobId} succeeded in ${proof.renderSeconds} s; ${proof.probe.width}x${proof.probe.height} ${proof.probe.fps} fps, ${proof.probe.frames} frames, ${proof.probe.durationSeconds} s; engines ${proof.sceneEngines.join(',')}`);
    if (!proof.problems.length) proof.status = 'passed';
  } catch (e) {
    const message = (e as Error).message;
    proof.problems.push(message);
    // Say why a render failed: the last lines of the job log (e.g. an engine's own error).
    const jobId = proof.jobId ?? /job_[A-Za-z0-9]+/.exec(message)?.[0];
    if (jobId) {
      const logs = await api.get(`/v1/jobs/${jobId}/logs?tail=4`).catch(() => null);
      if (logs?.lines?.length) proof.problems.push(`job log: ${logs.lines.map((l: string) => l.replace(/\s+/g, ' ').slice(0, 300)).join(' | ')}`);
    }
  }
  writeFileSync(join(outDir, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(proof.status === 'passed' ? `✔ ${agent} x ${engine} PASSED` : `✘ ${agent} x ${engine} FAILED:\n  - ${proof.problems.join('\n  - ')}`);
  return proof;
}

/** Signed download links and API keys never go into the repository, even expired ones. */
export function redact(text: string): string {
  return text.replace(/([?&]sig=)[A-Za-z0-9_-]+/g, '$1<redacted>').replace(/\brf_[A-Za-z0-9_-]{8,}/g, 'rf_<redacted>');
}

/** Copy a proof into docs/tutorials/proofs/ (no secrets: the key is never in a proof; local paths are reduced to their last parts). */
export function recordProof(p: Proof): void {
  const dir = join(REPO, 'docs/tutorials/proofs');
  mkdirSync(dir, { recursive: true });
  const name = `${p.agent}-${p.engine}`;
  const outRoot = dirname(dirname(p.artefacts));
  const local = (t: string) => redact(t.split(outRoot).join('$TUTORIAL_OUT'));
  const recorded = { ...p, artefacts: `$TUTORIAL_OUT/${p.agent}/${p.engine}`, poster: p.poster ? `${name}.jpg` : null, problems: p.problems.map(local) };
  if (recorded.llm) recorded.llm = { ...recorded.llm, reply: redact(recorded.llm.reply).slice(0, 1500) };
  if (p.poster) copyFileSync(p.poster, join(dir, `${name}.jpg`));
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(recorded, null, 2) + '\n');
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const record = process.argv.includes('--record');
  const [agent, engineArg] = args;
  if (!agent || !isAgent(agent) || !engineArg || !(engineArg === 'all' || isCellEngine(engineArg))) {
    console.error('usage: pnpm tutorials:prove <claude-code|codex|mcp-sdk|rest|local-ai|hygen> <remotion|motion-canvas|html|hyperframes|multi-engine|all> [--record]');
    process.exit(2);
  }
  const engines = engineArg === 'all' ? [...CELL_ENGINES] : [engineArg as CellEngine];
  const outRoot = process.env.TUTORIAL_OUT ?? join(tmpdir(), 'reelforge-tutorials');
  mkdirSync(outRoot, { recursive: true });
  if (process.argv.includes('--record-only')) {
    // Record the proof of an earlier run (its proof.json under $TUTORIAL_OUT) without running it again.
    for (const engine of engines) recordProof(JSON.parse(readFileSync(join(outRoot, agent, engine, 'proof.json'), 'utf8')));
    return;
  }
  const studio = await useStudio(outRoot);
  console.log(`studio ${studio.url}${studio.owned ? ' (started by this run, RENDERWELD_LICENCE_MODE=off: local development only)' : ''}`);
  let failed = 0;
  try {
    for (const engine of engines) {
      const p = await proveCell(studio, agent, engine, outRoot);
      if (p.status !== 'passed') failed++;
      if (record) recordProof(p);
    }
  } finally {
    await studio.stop();
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
