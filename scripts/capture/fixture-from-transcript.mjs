#!/usr/bin/env node
// Turns a recorded Claude Code session (`claude -p … --output-format
// stream-json --verbose` transcript, plus the tutorial run's proof.json) into
// the small, masked fixture the agent-session walkthrough replays:
//
//   node scripts/capture/fixture-from-transcript.mjs <transcript.jsonl> <proof.json> <out.json>
//
// Keeps the prompt, every tool call (name, short input, short result, time
// offset), the final reply and the render facts. Licence keys, emails,
// tokens and signed links are masked; long JSON is cut to one line.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { maskText, stableJson } from './lib.mjs';

const oneLine = (s, n = 140) => {
  const t = maskText(String(s).replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** A short, readable line for a tool's input. */
export function summarizeInput(name, input) {
  const m = input?.manifest;
  if (m) return `manifest "${m.title ?? m.projectId}": ${m.scenes?.length ?? 0} scenes, ${m.output?.width}x${m.output?.height} @ ${m.output?.fps} fps (${(m.scenes ?? []).map((s) => `${s.engine}/${s.template ?? 'html'} ${s.durationSeconds}s`).join(', ')})`;
  const keys = Object.keys(input ?? {});
  if (!keys.length) return '';
  return oneLine(keys.map((k) => `${k}: ${typeof input[k] === 'string' ? input[k] : JSON.stringify(input[k])}`).join(', '), 120);
}

/** A short, readable line for a tool's result. */
export function summarizeResult(name, content) {
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
  const isImageNote = (p) => p.type === 'text' && /^\s*\[Image: /.test(p.text);
  const images = parts.filter((p) => p.type === 'image' || isImageNote(p)).length;
  const text = parts.filter((p) => p.type === 'text' && !isImageNote(p)).map((p) => p.text).join(' ');
  const j = parse(text) ?? (text.includes('{') ? parse(text.slice(text.indexOf('{'))) : null);
  const pre = images ? `[poster image] ` : '';
  if (!j) return pre + oneLine(text);
  if (j.templates) return `${j.templates.length} templates: ${j.templates.map((t) => `${t.id} (${t.engine})`).join(', ')}`;
  if (j.meta?.id) return `project ${j.meta.id}, version ${j.meta.version}`;
  if ('ok' in j && j.summary) return `ok: ${j.ok}, ${j.errors.length} errors, ${j.warnings.length} warnings; ${j.summary.scenes} scenes, ${j.summary.totalFrames} frames, ${j.summary.durationSeconds} s, engines ${j.summary.engines.join(', ')}`;
  const job = j.job ?? (j.type === 'render' ? j : null);
  if (job) {
    const p = job.progress ?? {};
    const pct = typeof p.fraction === 'number' ? ` ${Math.round(p.fraction * 100)}%` : '';
    const res = job.result ? `, ${job.result.frames} frames, ${job.result.durationSeconds} s, ${job.result.width}x${job.result.height}` : '';
    return `job ${job.id}: ${job.status}${pct}${p.stage ? ` (${p.stage}${p.detail ? `: ${p.detail}` : ''})` : ''}${res}`;
  }
  if (j.renderId) return `${pre}render ${j.renderId}: ${j.durationSeconds} s, ${j.frames} frames, ${j.width}x${j.height}; files ${j.files?.length ?? 0}; download link (signed, masked)`;
  return pre + oneLine(text);
}

export function buildFixture(lines, proof) {
  const events = lines.map((l) => parse(l)).filter(Boolean);
  const calls = new Map();
  const tools = [];
  let t0 = null;
  for (const e of events) {
    const at = e.timestamp ? Date.parse(e.timestamp) : null;
    if (at && t0 === null) t0 = at;
    if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) {
        if (c.type === 'tool_use') {
          const call = { name: c.name.replace(/^mcp__reelforge__/, ''), input: summarizeInput(c.name, c.input), at: at && t0 !== null ? Math.round((at - t0) / 100) / 10 : null };
          calls.set(c.id, call);
          tools.push(call);
        } else if (c.type === 'text' && c.text.trim()) tools.push({ say: oneLine(c.text, 200), full: c.text });
      }
    } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === 'tool_result' && calls.has(c.tool_use_id)) {
          const call = calls.get(c.tool_use_id);
          call.result = summarizeResult(call.name, c.content);
          if (at && t0 !== null && call.at !== null) call.seconds = Math.round(((at - t0) / 1000 - call.at) * 10) / 10;
        }
      }
    }
  }
  const result = events.find((e) => e.type === 'result');
  const reply = proof.llm?.reply ?? result?.result ?? '';
  // The last message is the reply itself, shown in full at the end: drop its one-line copy.
  const steps = tools.filter((t) => !(t.say && t.full.trim() === reply.trim())).map(({ full, ...t }) => t);
  return {
    $comment: 'Replayed by scripts/capture/steps/videos.mjs (agent-session walkthrough). Built by scripts/capture/fixture-from-transcript.mjs from a recorded Claude Code stream-json transcript; masked.',
    agent: 'Claude Code',
    command: maskText(proof.command ?? ''),
    model: proof.llm?.model ?? null,
    date: proof.date ?? null,
    studioCommit: proof.commit ?? null,
    prompt: maskText(proof.prompt ?? ''),
    tools: steps,
    reply: maskText(reply),
    turns: proof.llm?.turns ?? result?.num_turns ?? null,
    durationSeconds: Math.round((proof.llm?.durationMs ?? result?.duration_ms ?? 0) / 100) / 10,
    render: { id: proof.renderId, jobId: proof.jobId, renderSeconds: proof.renderSeconds, engines: proof.sceneEngines, ...proof.probe },
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const [transcript, proof, out] = process.argv.slice(2);
  if (!transcript || !proof || !out) {
    console.error('Usage: node scripts/capture/fixture-from-transcript.mjs <transcript.jsonl> <proof.json> <out.json>');
    process.exit(2);
  }
  const fixture = buildFixture(readFileSync(transcript, 'utf8').split('\n'), JSON.parse(readFileSync(proof, 'utf8')));
  writeFileSync(out, stableJson(fixture));
  console.log(`${out}: ${fixture.tools.filter((t) => t.name).length} tool calls`);
}
