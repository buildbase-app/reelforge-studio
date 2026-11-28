// Guards two claims that went stale (issue #390), so they cannot come back:
// - the HyperFrames title is CSS keyframes seeked by the HyperFrames runtime,
//   not a GSAP timeline (GSAP is not bundled, see D-019);
// - captions are rendered (burned in or as sidecars), not "stored, not
//   rendered yet".
// Run: pnpm test:docs (node --test, no dependencies).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

/** Every Markdown file under a docs folder. */
function markdown(dir) {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) out.push(...markdown(path));
    else if (name.endsWith('.md')) out.push(relative(root, join(root, path)));
  }
  return out;
}

/** Text agents read to learn what the HyperFrames title is. */
const AGENT_FACING = [
  'README.md',
  'packages/project-schema/src/templates.ts',
  'scripts/tutorials/docs.ts',
  ...markdown('docs/public'),
];

describe('stale claims (#390)', () => {
  it('no agent-facing text calls the HyperFrames title a GSAP timeline', () => {
    const hits = AGENT_FACING.filter((path) => /GSAP timeline/i.test(read(path)));
    assert.deepEqual(hits, [], 'the HyperFrames title is CSS keyframes, not a GSAP timeline');
  });

  it('the README does not say captions are not rendered', () => {
    assert.doesNotMatch(read('README.md'), /not rendered yet/i);
  });
});

// The official image ships no Remotion (#783, D-143): customer docs must not say it does.
describe('stale claims (#783)', () => {
  const STALE = [/pre-built Remotion/i, /four-engine 1080x1920 render/i, /Remotion, one of the four engines/i];
  it('no public doc says the official image includes Remotion', () => {
    const hits = markdown('docs/public').filter((path) => STALE.some((re) => re.test(read(path))));
    assert.deepEqual(hits, [], 'the official image has no Remotion: see docs/public/install/remotion.md');
  });

  it('the Remotion install page is published', () => {
    assert.match(read('docs/public/manifest.json'), /"docs\/public\/install\/remotion\.md"/);
  });
});
