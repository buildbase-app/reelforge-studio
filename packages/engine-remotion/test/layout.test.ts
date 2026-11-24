import { describe, expect, it } from 'vitest';
import { builtinTheme, type OutputSettings, type RenderScene, type SceneMedia } from '@reelforge/project-schema';
import { remotionLayoutInput } from '../src/index';

/** remotion-layout (#287): the shared layout markup with pictures from the render's asset origin. */
describe('remotion-layout markup', () => {
  const output: OutputSettings = { width: 1920, height: 1080, fps: 30, format: 'mp4' };
  const scene: RenderScene = {
    id: 's',
    engine: 'remotion',
    template: 'remotion-layout',
    durationFrames: 60,
    props: { layout: { type: 'split' }, panes: [{ media: { asset: 'still', fit: 'contain' } }, { media: { asset: 'clip', fit: 'blur-fill', startSeconds: 2 }, label: 'Cam' }] },
  };
  const base = 'http://127.0.0.1:9/tok/';
  const media: Record<string, SceneMedia> = {
    still: { url: `${base}still.png`, mediaType: 'image', width: 400, height: 300 },
    'clip@2': { url: `${base}v/0.jpg`, mediaType: 'video', width: 320, height: 180, frames: { urls: Array.from({ length: 50 }, (_, i) => `${base}v/${i}.jpg`), first: 10 } },
  };

  it('pictures come from the staged media; a video pane starts at the range\'s first picture and is marked for per-frame swaps', () => {
    const r = remotionLayoutInput(scene, output, builtinTheme('midnight')!.tokens, undefined, media, 10);
    expect(r.html).toContain(`src="${base}still.png"`);
    // blur-fill: a blurred copy and the picture, both the clip's picture for frame 10.
    expect(r.html.match(/data-rf-video="clip@2" src="http:\/\/127\.0\.0\.1:9\/tok\/v\/0\.jpg"/g)).toHaveLength(2);
    expect(r.css).toContain('.rfl-pane');
    expect(r.rootCss).toContain('--rf-bg:');
    expect(r.rootCss).toContain('--rf-unit:10.8px');
  });

  it('refuses a pane asset that was not staged', () => {
    expect(() => remotionLayoutInput(scene, output, undefined, undefined, { still: media.still! }, 0)).toThrow(/asset "clip" is not available/);
  });
});
