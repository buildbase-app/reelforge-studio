// Runs INSIDE the server container (docker exec -i ... node --input-type=module < sandbox-probe.mjs):
// launches Chrome Headless Shell the way the html engine does and reports whether
// its renderer processes run inside Chromium's namespace sandbox. A sandboxed
// renderer sits in a nested PID namespace, so /proc/<pid>/status shows two NSpid
// values (readable for every process; no ptrace needed).
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/app/packages/engine-html/package.json');
const { chromium } = require('playwright-core');
const sandbox = process.env.REELFORGE_CHROMIUM_NO_SANDBOX !== '1';
const browser = await chromium.launch({ executablePath: process.env.REELFORGE_CHROMIUM_PATH, chromiumSandbox: sandbox });
const page = await browser.newPage();
await page.setContent('<p id="x">ok</p>');
const rendered = await page.textContent('#x');
const renderers = [];
for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!cmd.includes('--type=renderer')) continue;
    const nspid = /^NSpid:\s*(.*)$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1].trim().split(/\s+/) ?? [];
    renderers.push({ pid: Number(pid), nspid, noSandboxFlag: cmd.includes('--no-sandbox') });
  } catch {}
}
await browser.close();
const sandboxed = renderers.length > 0 && renderers.every((r) => r.nspid.length > 1 && !r.noSandboxFlag);
console.log(JSON.stringify({ requested: sandbox, rendered, renderers: renderers.length, sandboxed, uid: process.getuid() }));
