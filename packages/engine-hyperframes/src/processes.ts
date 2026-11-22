import { readdirSync, readFileSync } from 'node:fs';

/**
 * Every process of one HyperFrames render, found and killed (D-087).
 *
 * The CLI runs in its own process group, but its browser is launched by
 * Puppeteer in a group of its own and is re-parented once the CLI dies, so a
 * group kill alone can leave Chrome running (and writing into the cache
 * directory) after a render ended, failed, timed out or was cancelled. Each
 * render therefore gets its own TMPDIR, which the CLI and the browser inherit;
 * every process whose environment carries it belongs to that render.
 */

/** PIDs of live processes (this user's, readable) whose environment has `name=value`. Linux only; [] elsewhere. */
export function processesWithEnv(name: string, value: string): number[] {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  const needle = `${name}=${value}\0`;
  const out: number[] = [];
  for (const e of entries) {
    if (!/^\d+$/.test(e) || Number(e) === process.pid) continue;
    try {
      const env = readFileSync(`/proc/${e}/environ`, 'latin1');
      if (env.startsWith(needle) || env.includes(`\0${needle}`)) out.push(Number(e));
    } catch {
      // gone, or another user's process
    }
  }
  return out;
}

function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/** SIGKILL the CLI's process group and every process carrying the render's TMPDIR, now. */
export function killRenderNow(groupPid: number | undefined, tmpDir: string): void {
  if (groupPid) kill(-groupPid);
  for (const pid of processesWithEnv('TMPDIR', tmpDir)) kill(pid);
}

/**
 * Kill what is left of a render and wait until nothing carrying its TMPDIR
 * runs any more (killed processes become zombies, whose environment reads
 * empty). Returns the PIDs still found after `timeoutMs` (normally none).
 */
export async function reapRender(groupPid: number | undefined, tmpDir: string, timeoutMs = 5000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    killRenderNow(groupPid, tmpDir);
    await new Promise((r) => setTimeout(r, 50));
    const left = processesWithEnv('TMPDIR', tmpDir);
    if (left.length === 0 || Date.now() > deadline) return left;
  }
}
