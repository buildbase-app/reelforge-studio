// Renders one hyperframes-title scene whose theme names a web font that is not
// installed, then prints one JSON line. Run by egress.test.ts under strace
// (`node --import tsx render-missing-font.mts <dir>`), so every connect() of
// the render (CLI, browser, anything they start) is seen.
import { join } from 'node:path';
import { builtinTheme } from '@renderweld/project-schema';
import { renderHyperframesScene } from '../../src/index';

const dir = process.argv[2]!;
const log: string[] = [];
const result = await renderHyperframesScene({
  scene: { id: 'font', engine: 'hyperframes', template: 'hyperframes-title', durationFrames: 15, props: { headline: 'Quarterly launch', subline: 'Private preview' } },
  output: { width: 320, height: 320, fps: 30, format: 'mp4' },
  theme: { ...builtinTheme('default')!.tokens, fontFamily: '"Roboto", sans-serif' },
  out: join(dir, 'font.mp4'),
  workDir: join(dir, 'work'),
  cacheDir: join(dir, 'cache'),
  // The time limit of the test that runs this (280 s), not the per-frame default (82.5 s here): under strace -f every
  // process of the render is traced, and other test files render beside it. On CI runners this render alone took
  // 57 to 60 s, and once ran past 82.5 s while the text overflow tests rendered beside it. Egress is what is checked.
  timeoutMs: 240_000,
  log: (line) => log.push(line),
}).then(
  () => ({ ok: true, log }),
  (e: Error) => ({ ok: false, error: e.message, log })
);
console.log(`RESULT ${JSON.stringify(result)}`);
