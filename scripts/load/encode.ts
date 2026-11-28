/**
 * Encoder memory (issue #307): peak memory of a real render and of its H.264 encode, and what the x264
 * settings cost in memory, time, size and quality.
 *
 * For each size (LOAD_ENCODE_SIZES, default 1080x1920 and 3840x2160; 30 fps; LOAD_ENCODE_SECONDS, 10):
 *   1. a real html-engine render (the built-in html-title template, Chrome Headless Shell, the engine's own
 *      PNG pipe into FFmpeg) once with the old encoder settings (x264 automatic threads, the preset's
 *      lookahead) and once with each of LOAD_ENCODE_RENDER_SETTINGS: the FFmpeg process's peak RSS from the
 *      kernel (getrusage of the waited child), and the whole render's memory (Node, Chromium, FFmpeg),
 *      sampled every 100 ms as the sum of PSS (shared pages split between processes, so not counted twice);
 *   2. the first render's PNG frames (captured from the pipe) encoded again with every setting of the matrix
 *      (LOAD_ENCODE_MATRIX: threads/lookahead pairs, 0 = the x264 or preset default): peak RSS, CPU seconds,
 *      wall seconds, bytes, and SSIM and PSNR of the result against the frames (in yuv420p, so the numbers
 *      measure the encoder's loss, not chroma subsampling). This FFmpeg has no libvmaf; LOAD_ENCODE_VMAF=1
 *      adds VMAF where it has.
 *
 *   RENDERWELD_CHROMIUM_PATH=... pnpm load:encode
 *   LOAD_ENCODE_SIZES=1080x1920 LOAD_ENCODE_SECONDS=2 pnpm load:encode     # quick look
 *
 * Results: LOAD_OUT/<date>-encode.json and .md. Every temporary file is removed at the end.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { renderHtmlScene } from '@renderweld/engine-html';
import { DEFAULT_ENCODER_SETTINGS, encoderSettings, h264Args, inputThreadArgs, filterThreadArgs, resolveTools, setEncoderSettings, type EncoderSettings } from '@renderweld/media-pipeline';
import { builtinTheme, type RenderScene } from '@renderweld/project-schema';
import { env, envNum, hostFingerprint, round, sleep } from './lib';

const repo = resolve(import.meta.dirname, '../..');
const cfg = {
  sizes: env('LOAD_ENCODE_SIZES', '1080x1920,3840x2160').split(',').map((s) => s.split('x').map(Number) as [number, number]),
  seconds: envNum('LOAD_ENCODE_SECONDS', 10),
  fps: 30 as const,
  /** Real renders: the old settings first, then these (threads/lookahead). */
  renderSettings: env('LOAD_ENCODE_RENDER_SETTINGS', `${DEFAULT_ENCODER_SETTINGS.threads}/${DEFAULT_ENCODER_SETTINGS.lookahead}`).split(',').filter((s) => s !== 'none'),
  matrix: env('LOAD_ENCODE_MATRIX', '0/0,0/20,4/0,4/20,4/10,2/20,2/10,1/20').split(','),
  repeats: envNum('LOAD_ENCODE_REPEATS', 3),
  vmaf: env('LOAD_ENCODE_VMAF', '0') === '1',
  out: resolve(repo, env('LOAD_OUT', 'out/load')),
};
const OLD: EncoderSettings = { threads: 0, lookahead: 0 };
const parse = (s: string): EncoderSettings => {
  const [t, l] = s.split('/').map(Number);
  return { threads: t!, lookahead: l! };
};
const label = (s: EncoderSettings) => `threads ${s.threads || 'auto'}, lookahead ${s.lookahead || 'preset (40)'}`;
const log = (s: string) => console.log(`[encode ${new Date().toISOString().slice(11, 19)}] ${s}`);
const work = mkdtempSync(join(tmpdir(), 'rf-encode-'));
const tools = resolveTools();
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)]!;

// A wrapper FFmpeg: runs the real one, records its peak RSS and CPU from the kernel, and (RF_CAPTURE) keeps a copy of its stdin.
const wrapper = join(work, 'bin');
mkdirSync(wrapper);
writeFileSync(
  join(wrapper, 'measure.py'),
  `import json, os, resource, subprocess, sys, time
cap = os.environ.get('RF_CAPTURE')
t = time.time()
p = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE if cap else None)
if cap:
    with open(cap, 'wb') as f:
        while True:
            b = sys.stdin.buffer.read1(1 << 20)
            if not b:
                break
            f.write(b)
            p.stdin.write(b)
    p.stdin.close()
rc = p.wait()
ru = resource.getrusage(resource.RUSAGE_CHILDREN)
with open(os.environ['RF_MEASURE'], 'a') as o:
    o.write(json.dumps({'maxRssMB': ru.ru_maxrss / 1024, 'cpuSeconds': ru.ru_utime + ru.ru_stime, 'wallSeconds': time.time() - t, 'rc': rc}) + '\\n')
sys.exit(rc)
`
);
writeFileSync(join(wrapper, 'ffmpeg'), `#!/bin/sh\nexec python3 -I ${join(wrapper, 'measure.py')} ${tools.ffmpeg} "$@"\n`);
chmodSync(join(wrapper, 'ffmpeg'), 0o755);

function measured(file: string) {
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as { maxRssMB: number; cpuSeconds: number; wallSeconds: number; rc: number };
}

/**
 * Sum of PSS of this process and its descendants (Node, Chromium, FFmpeg), sampled every 100 ms: the peak; and
 * their CPU seconds (utime + stime of each process, its last sample; a process that ends between samples loses
 * at most 100 ms). This process's own CPU counts from the start of the render.
 */
function treeSampler() {
  let peak = 0;
  const cpu = new Map<string, number>();
  const tick = sysconfTicks();
  const self = String(process.pid);
  const selfStart = process.cpuUsage();
  const pss = (pid: string) => {
    try {
      const m = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
      return m ? Number(m[1]) / 1024 : 0;
    } catch {
      return 0;
    }
  };
  const sample = () => {
    const stat = new Map<string, string[]>();
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        stat.set(d, readFileSync(`/proc/${d}/stat`, 'utf8').split(') ')[1]!.split(' '));
      } catch {
        // gone
      }
    }
    const mine = new Set([self]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [p, f] of stat) if (!mine.has(p) && mine.has(f[1]!)) (mine.add(p), (grew = true));
    }
    peak = Math.max(peak, [...mine].reduce((a, p) => a + pss(p), 0));
    for (const p of mine) if (p !== self) cpu.set(p, (Number(stat.get(p)![11]) + Number(stat.get(p)![12])) / tick);
  };
  const timer = setInterval(sample, 100);
  return {
    stop: () => {
      clearInterval(timer);
      const own = process.cpuUsage(selfStart);
      return { peakPssMB: round(peak), cpuSeconds: round([...cpu.values()].reduce((a, b) => a + b, 0) + (own.user + own.system) / 1e6, 1) };
    },
  };
}
const sysconfTicks = () => Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim()) || 100;

async function realRender(w: number, h: number, s: EncoderSettings, capture?: string) {
  const out = join(work, `render-${w}x${h}.mp4`);
  const m = join(work, 'measure.jsonl');
  process.env.RF_MEASURE = m;
  if (capture) process.env.RF_CAPTURE = capture;
  else delete process.env.RF_CAPTURE;
  setEncoderSettings(s);
  const frames = cfg.seconds * cfg.fps;
  const scene: RenderScene = { id: 'mem', engine: 'html', template: 'html-title', durationFrames: frames, props: { headline: 'Encoder memory', subline: `${w} x ${h}, ${cfg.fps} fps`, kicker: 'ISSUE 307' } };
  const tree = treeSampler();
  const t = Date.now();
  await renderHtmlScene({ scene, output: { width: w, height: h, fps: cfg.fps, format: 'mp4' }, theme: builtinTheme('midnight')!.tokens, out, ffmpeg: join(wrapper, 'ffmpeg'), timeoutMs: 1_800_000 });
  const t2 = tree.stop();
  const ff = measured(m);
  rmSync(out, { force: true });
  return { settings: label(s), ffmpegPeakRssMB: round(ff.maxRssMB), ffmpegCpuSeconds: round(ff.cpuSeconds, 2), renderPeakPssMB: t2.peakPssMB, renderCpuSeconds: t2.cpuSeconds, renderSeconds: round((Date.now() - t) / 1000) };
}

function metrics(frames: string, encoded: string) {
  const graph = `[0:v]format=yuv420p,split[r1][r2];[1:v]split[d1][d2];[d1][r1]ssim;[d2][r2]psnr`;
  const r = spawnSync(tools.ffmpeg, ['-hide_banner', '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(cfg.fps), '-i', frames, '-i', encoded, '-lavfi', graph, '-f', 'null', '-'], { encoding: 'utf8' });
  const ssim = /SSIM .*All:([\d.]+)/.exec(r.stderr)?.[1];
  const psnr = /PSNR .*average:([\d.inf]+)/.exec(r.stderr)?.[1];
  let vmaf: number | null = null;
  if (cfg.vmaf) {
    const v = spawnSync(tools.ffmpeg, ['-hide_banner', '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(cfg.fps), '-i', frames, '-i', encoded, '-lavfi', '[0:v]format=yuv420p[r];[1:v][r]libvmaf', '-f', 'null', '-'], { encoding: 'utf8' });
    vmaf = Number(/VMAF score: ([\d.]+)/.exec(v.stderr)?.[1] ?? NaN);
  }
  return { ssim: ssim ? Number(ssim) : null, psnrDb: psnr ? Number(psnr) : null, vmaf };
}

/** The captured frames encoded with one setting, as startPngEncoder does: peak RSS, CPU, time, size, quality. */
function encodeOnce(frames: string, s: EncoderSettings) {
  const out = join(work, 'matrix.mp4');
  const m = join(work, 'matrix.jsonl');
  const args = ['-hide_banner', '-y', ...filterThreadArgs(s), ...inputThreadArgs(s), '-f', 'image2pipe', '-framerate', String(cfg.fps), '-c:v', 'png', '-i', frames, ...h264Args(s), '-r', String(cfg.fps), '-an', out];
  const r = spawnSync('python3', ['-I', join(wrapper, 'measure.py'), tools.ffmpeg, ...args], { env: { ...process.env, RF_MEASURE: m, RF_CAPTURE: '' }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`encode failed: ${r.stderr.slice(-800)}`);
  return { ...measured(m), bytes: statSync(out).size, out };
}

async function main() {
  mkdirSync(cfg.out, { recursive: true });
  const host = hostFingerprint();
  log(`${host.vcpu} vCPU, load average ${host.loadAvgAtStart.join(' ')}; ${tools.ffmpeg}`);
  const results = [];
  for (const [w, h] of cfg.sizes) {
    const frames = join(work, `frames-${w}x${h}.pngs`);
    log(`${w}x${h}: real render, old settings (${label(OLD)}), capturing the frames`);
    const renders = [await realRender(w, h, OLD, frames)];
    for (const s of cfg.renderSettings.map(parse)) {
      log(`${w}x${h}: real render, ${label(s)}`);
      renders.push(await realRender(w, h, s));
    }
    const matrix = [];
    for (const s of cfg.matrix.map(parse)) {
      const runs = Array.from({ length: cfg.repeats }, () => encodeOnce(frames, s));
      const q = metrics(frames, runs[runs.length - 1]!.out);
      // The decoded frames' digest: equal digests mean the same picture, whatever the container or SEI bytes say.
      const md5 = spawnSync(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-i', runs[runs.length - 1]!.out, '-map', '0:v', '-f', 'framemd5', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const framesDigest = createHash('sha256').update(md5.stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim()).join('\n')).digest('hex').slice(0, 16);
      const row = {
        settings: label(s),
        threads: s.threads,
        lookahead: s.lookahead,
        peakRssMB: round(median(runs.map((r) => r.maxRssMB))),
        cpuSeconds: round(median(runs.map((r) => r.cpuSeconds)), 2),
        wallSeconds: round(median(runs.map((r) => r.wallSeconds)), 2),
        bytes: runs[0]!.bytes,
        framesDigest,
        ...q,
        loadAvg1m: round(loadavg()[0]!, 2),
      };
      log(`${w}x${h} ${row.settings}: ${row.peakRssMB} MB, ${row.cpuSeconds} CPU s, ${row.wallSeconds} s, ${row.bytes} bytes, SSIM ${row.ssim}, PSNR ${row.psnrDb} dB`);
      matrix.push(row);
      await sleep(200);
    }
    results.push({ width: w, height: h, fps: cfg.fps, seconds: cfg.seconds, frameBytes: statSync(frames).size, renders, matrix });
    rmSync(frames, { force: true });
  }
  const doc = { host: { ...host, loadAvgAtEnd: loadavg().map((x) => round(x, 2)), cpus: cpus().length }, ffmpeg: spawnSync(tools.ffmpeg, ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0], defaults: DEFAULT_ENCODER_SETTINGS, current: encoderSettings(), config: cfg, results };
  const md = [
    `# Encoder memory ${host.date}`,
    '',
    `Lower bound, shared host: ${host.vcpu} vCPU ${host.cpuModel}, ${host.ramGiB} GiB, load average at start ${host.loadAvgAtStart.join(' ')}, at end ${doc.host.loadAvgAtEnd.join(' ')}. ${doc.ffmpeg}. Medians of ${cfg.repeats} encodes.`,
    '',
    ...results.flatMap((r) => [
      `## ${r.width}x${r.height}, ${r.fps} fps, ${r.seconds} s (${r.seconds * r.fps} frames)`,
      '',
      '| Real render | FFmpeg peak RSS MB | FFmpeg CPU s | Whole render peak PSS MB | Whole render CPU s | Render s |',
      '| --- | --- | --- | --- | --- | --- |',
      ...r.renders.map((x) => `| ${x.settings} | ${x.ffmpegPeakRssMB} | ${x.ffmpegCpuSeconds} | ${x.renderPeakPssMB} | ${x.renderCpuSeconds} | ${x.renderSeconds} |`),
      '',
      '| Encode of the same frames | Peak RSS MB | CPU s | Wall s | Bytes | Decoded frames digest | SSIM | PSNR dB |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...r.matrix.map((x) => `| ${x.settings} | ${x.peakRssMB} | ${x.cpuSeconds} | ${x.wallSeconds} | ${x.bytes} | ${x.framesDigest} | ${x.ssim} | ${x.psnrDb} |`),
      '',
    ]),
  ].join('\n');
  const file = join(cfg.out, `${host.date.replace(/[:.]/g, '-').slice(0, 19)}-encode`);
  writeFileSync(`${file}.json`, JSON.stringify(doc, null, 2));
  writeFileSync(`${file}.md`, md);
  console.log(md);
  log(`results: ${file}.json and .md`);
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit();
