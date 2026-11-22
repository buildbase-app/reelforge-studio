/**
 * `pnpm gallery sketch <slug...>`: a quick look at the agent-written scenes of
 * gallery entries without a full render. Loads each html/hyperframes scene in
 * headless Chromium (network blocked), seeks every animation (and the
 * HyperFrames seek adapters) to a few times, and tiles the screenshots into
 * one PNG per reel. Template scenes (Remotion, Motion Canvas, built-in
 * templates) need the real engines and show as a grey placeholder.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDocument } from '@reelforge/engine-html';
import { buildComposition } from '@reelforge/engine-hyperframes';
import { builtinTheme, mergeTokens, type ThemeTokens } from '@reelforge/project-schema';
import { chromium } from 'playwright-core';
import type { GalleryEntry } from './catalog/build';

const OUTPUT = { width: 1080, height: 1920, fps: 30 as const, format: 'mp4' as const };

export function themeTokensOf(manifest: Record<string, any>): ThemeTokens {
  const t = manifest.theme;
  if (typeof t === 'string') return builtinTheme(t)!.tokens;
  return mergeTokens(builtinTheme(t.base)!.tokens, t.tokens);
}

export async function sketch(entries: GalleryEntry[], outDir: string, opts: { browser: string; frames?: number }): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: opts.browser, args: ['--disable-gpu', '--font-render-hinting=none'], chromiumSandbox: false });
  const written: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1080, height: 1920 }, offline: true });
    await context.route('**/*', (r) => (r.request().url().startsWith('data:') || r.request().url() === 'about:blank' ? r.continue() : r.abort()));
    let page: import('playwright-core').Page | undefined;
    for (const entry of entries) {
      const m = entry.manifest as any;
      const theme = themeTokensOf(m);
      const tmp = join(outDir, `.${entry.gallery.slug}`);
      mkdirSync(tmp, { recursive: true });
      const shots: string[] = [];
      const per = opts.frames ?? 4;
      for (const [i, sc] of (m.scenes as any[]).entries()) {
        const dur = sc.durationSeconds as number;
        const times = Array.from({ length: per }, (_, k) => Math.min(dur - 0.05, 0.25 + (k / (per - 1)) * (dur - 0.75)));
        if (!sc.html) {
          for (const [k] of times.entries()) {
            const f = join(tmp, `${i}-${k}.png`);
            execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=1080x1920`, '-vf', `drawtext=text='${sc.engine} ${sc.template}':fontsize=60:x=60:y=900:fontcolor=white`, '-frames:v', '1', f]);
            shots.push(f);
          }
          continue;
        }
        const doc =
          sc.engine === 'hyperframes'
            ? buildComposition({ id: sc.id, engine: 'hyperframes', html: sc.html, css: sc.css, durationFrames: Math.round(dur * 30), props: {} }, OUTPUT, theme)
            : buildDocument({ html: sc.html, css: sc.css ?? '', theme, output: OUTPUT, durationSeconds: dur });
        // A fresh page per scene: a document's CSP (html scenes forbid scripts) outlives setContent.
        if (page) await page.close();
        page = await context.newPage();
        page.on('pageerror', (e) => console.error(`sketch: page error: ${e.message}`));
        await page.setContent(doc, { waitUntil: 'load' });
        for (const [k, t] of times.entries()) {
          await page!.evaluate((ms) => {
            for (const a of document.getAnimations()) {
              a.pause();
              a.currentTime = ms;
            }
            for (const h of ((window as any).__hfAnime ?? []) as any[]) {
              try {
                h.seek(ms);
              } catch (e) {
                console.error(e);
              }
            }
          }, t * 1000);
          const f = join(tmp, `${i}-${k}.png`);
          await page!.screenshot({ path: f, type: 'png' });
          shots.push(f);
        }
      }
      const cols = per;
      const rows = Math.ceil(shots.length / cols);
      const out = join(outDir, `${entry.gallery.slug}.png`);
      const list = join(tmp, 'list.txt');
      writeFileSync(list, shots.map((f) => `file '${f}'`).join('\n'));
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `scale=216:384,tile=${cols}x${rows}:padding=6:color=0x222222`, '-frames:v', '1', out]);
      rmSync(tmp, { recursive: true, force: true });
      written.push(out);
    }
  } finally {
    await browser.close();
  }
  return written;
}
