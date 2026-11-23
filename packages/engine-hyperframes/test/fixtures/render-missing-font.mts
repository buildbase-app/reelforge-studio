// Renders one hyperframes-title scene whose theme names a web font that is not
// installed, then prints one JSON line. Run by egress.test.ts under strace
// (`node --import tsx render-missing-font.mts <dir>`), so every connect() of
// the render (CLI, browser, anything they start) is seen.
import { join } from 'node:path';
import { builtinTheme } from '@reelforge/project-schema';
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
  log: (line) => log.push(line),
}).then(
  () => ({ ok: true, log }),
  (e: Error) => ({ ok: false, error: e.message, log })
);
console.log(`RESULT ${JSON.stringify(result)}`);
