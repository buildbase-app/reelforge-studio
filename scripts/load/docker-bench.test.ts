/**
 * The Docker sizing benchmark's own checks (#151): the size list, when the sweep stops, which point is
 * recommended, reading the container's cgroup (v1 and v2) and the report table. The containers themselves
 * are only started by `pnpm bench:docker`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { best, brokenPoint, cgroupFiles, config, parseSizes, readCgroup, renderMarkdown, shouldContinue, type ApiPoint, type Point } from './docker-bench';

const root = mkdtempSync(join(tmpdir(), 'rf-bench-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const point = (concurrency: number, rendersPerHour: number, extra: Partial<Point> = {}): Point => ({
  size: { cpus: 2, memGiB: 4 },
  workload: 'v1080-30s',
  concurrency,
  ok: concurrency * 2,
  failed: 0,
  errors: [],
  wallSeconds: 100,
  rendersPerHour,
  videoSecondsPerCpuSecond: 0.2,
  renderSeconds: { mean: 90, p95: 95 },
  peakMemMiB: 800 * concurrency,
  oomKills: 0,
  cpuSeconds: 190,
  peakDiskMiB: 20,
  ...extra,
});

describe('docker sizing benchmark', () => {
  it('BENCH-01 reads sizes as vCPUs:GiB and refuses anything else', () => {
    expect(parseSizes('1:2, 2:4,0.5:1')).toEqual([{ cpus: 1, memGiB: 2 }, { cpus: 2, memGiB: 4 }, { cpus: 0.5, memGiB: 1 }]);
    expect(() => parseSizes('2')).toThrow(/vCPUs:GiB/);
    expect(() => parseSizes('2:0')).toThrow(/vCPUs:GiB/);
    expect(config({}).sizes).toEqual([{ cpus: 1, memGiB: 2 }, { cpus: 2, memGiB: 4 }, { cpus: 4, memGiB: 8 }]);
    expect(config({ BENCH_ENV: 'RENDERWELD_CHROMIUM_NO_SANDBOX=1,A=b=c' }).env).toEqual({ RENDERWELD_CHROMIUM_NO_SANDBOX: '1', A: 'b=c' });
    expect(config({}).dockerArgs).toEqual(['--security-opt', 'seccomp=deployment/seccomp/chrome.json']);
    expect(config({}).concurrency).toEqual([]);
    expect(config({ BENCH_CONCURRENCY: '1,3' }).concurrency).toEqual([1, 3]);
  });

  it('BENCH-02 the sweep goes on while throughput grows, and stops at a failure, an OOM kill, the cap or a flat step', () => {
    expect(shouldContinue([], 4, 0.05)).toBe(true);
    expect(shouldContinue([point(1, 40)], 4, 0.05)).toBe(true);
    expect(shouldContinue([point(1, 40), point(2, 70)], 4, 0.05)).toBe(true);
    expect(shouldContinue([point(1, 40), point(2, 41)], 4, 0.05)).toBe(false); // +2.5 %: no gain
    expect(shouldContinue([point(1, 40), point(2, 70, { failed: 1 })], 4, 0.05)).toBe(false);
    expect(shouldContinue([point(1, 40), point(2, 70, { oomKills: 1 })], 4, 0.05)).toBe(false);
    expect(shouldContinue([point(1, 40), point(2, 70), point(3, 90), point(4, 110)], 4, 0.05)).toBe(false); // the cap
  });

  it('BENCH-03 recommends the fastest point with no failure and no OOM kill', () => {
    expect(best([point(1, 40), point(2, 70), point(3, 65)])!.concurrency).toBe(2);
    expect(best([point(1, 40), point(2, 70), point(3, 90, { failed: 2 })])!.concurrency).toBe(2);
    expect(best([point(1, 40, { oomKills: 1 })])).toBeNull();
  });

  it('BENCH-04 reads peak memory, OOM kills and CPU time from a cgroup v1 or v2 folder', () => {
    const v1 = join(root, 'v1');
    mkdirSync(join(v1, 'memory/docker/abc'), { recursive: true });
    mkdirSync(join(v1, 'cpuacct/docker/abc'), { recursive: true });
    writeFileSync(join(v1, 'memory/docker/abc/memory.max_usage_in_bytes'), `${900 * 1024 * 1024}\n`);
    writeFileSync(join(v1, 'memory/docker/abc/memory.oom_control'), 'oom_kill_disable 0\nunder_oom 0\noom_kill 2\n');
    writeFileSync(join(v1, 'cpuacct/docker/abc/cpuacct.usage'), '123500000000\n');
    const f1 = cgroupFiles('abc', v1);
    expect(f1?.version).toBe(1);
    expect(readCgroup(f1)).toEqual({ peakMemMiB: 900, oomKills: 2, cpuSeconds: 123.5 });

    const v2 = join(root, 'v2');
    const dir = join(v2, 'system.slice/docker-def.scope');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'memory.max'), '4294967296\n');
    writeFileSync(join(dir, 'memory.peak'), `${2048 * 1024 * 1024}\n`);
    writeFileSync(join(dir, 'memory.events'), 'low 0\nhigh 0\nmax 4\noom 1\noom_kill 1\n');
    writeFileSync(join(dir, 'cpu.stat'), 'usage_usec 61000000\nuser_usec 50000000\n');
    const f2 = cgroupFiles('def', v2);
    expect(f2?.version).toBe(2);
    expect(readCgroup(f2)).toEqual({ peakMemMiB: 2048, oomKills: 1, cpuSeconds: 61 });

    expect(cgroupFiles('missing', v2)).toBeNull();
    expect(readCgroup(null)).toEqual({ peakMemMiB: null, oomKills: null, cpuSeconds: null });
  });

  it('BENCH-05 the report has one row per size with its recommended point, and every point measured', () => {
    const one = { cpus: 1, memGiB: 2 };
    const points = [point(1, 20, { size: one }), point(2, 21, { size: one, failed: 1, errors: ['failed: out of memory'] }), point(1, 40), point(2, 70)];
    const api: ApiPoint[] = [{ size: { cpus: 2, memGiB: 4 }, requests: 6000, errors: 0, seconds: 10, perSecond: 600, p95Ms: 88.4 }];
    const md = renderMarkdown(points, api, { cpuModel: 'Test CPU', vcpu: 4, ramGiB: 16, date: '2026-11-25T00:00:00Z' }, 'v1080-30s');
    expect(md).toContain('Workload: 30 s videos at 1080x1920, 30 fps');
    expect(md).toContain('Host: Test CPU, 4 vCPU, 16 GiB, measured 2026-11-25.');
    expect(md).toContain('| 1 vCPU, 2 GiB | 1 | 20 | 90 s / 95 s | 800 MiB | 20 MiB | - |');
    expect(md).toContain('| 2 vCPU, 4 GiB | 2 | 70 | 90 s / 95 s | 1600 MiB | 20 MiB | 600 (88 ms) |');
    expect(md).toContain('| 1 vCPU, 2 GiB | 2 | 4 / 1 | 21 | 0.2 | 1600 MiB | 0 | failed: out of memory |');
  });

  it('BENCH-06 a run that broke off counts every planned render as failed, names an OOM kill and ends the sweep for that size', () => {
    const size = { cpus: 1, memGiB: 0.5 };
    const p = brokenPoint(size, 'v1080-30s', 2, 4, new Error('container exited before it was healthy:\nKilled'), true);
    expect(p).toMatchObject({ concurrency: 2, ok: 0, failed: 4, rendersPerHour: 0, oomKills: 1, errors: ['container OOM-killed: container exited before it was healthy: Killed'] });
    expect(brokenPoint(size, 'v1080-30s', 1, 2, 'container not healthy in time', false)).toMatchObject({ failed: 2, oomKills: null, errors: ['container not healthy in time'] });
    expect(shouldContinue([p], 4, 0.05)).toBe(false);
    expect(best([p])).toBeNull();
    const md = renderMarkdown([p], [], { cpuModel: 'Test CPU', vcpu: 4, ramGiB: 16, date: '2026-11-25T00:00:00Z', note: 'Shared sandbox.' }, 'v1080-30s');
    expect(md).toContain('| 1 vCPU, 0.5 GiB | none without a failure | - | - | - MiB | - | - |');
    expect(md).toContain('| 1 vCPU, 0.5 GiB | 2 | 0 / 4 | 0 | 0 | - MiB | 1 | container OOM-killed: container exited before it was healthy: Killed |');
    expect(md).toContain('measured 2026-11-25.\n\nShared sandbox.\n');
    expect(config({}).note).toBe('');
  });
});
