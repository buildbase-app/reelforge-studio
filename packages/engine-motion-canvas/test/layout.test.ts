import { describe, expect, it } from 'vitest';
import type { OutputSettings, RenderScene } from '@reelforge/project-schema';
import { sceneVariables } from '../src/index';

/** motion-canvas-layout (#287): the scene gets parsed props and the geometry spec, so it calls the shared layout functions. */
describe('motion-canvas-layout variables', () => {
  const output: OutputSettings = { width: 1080, height: 1920, fps: 30, format: 'mp4' };
  const scene = (props: Record<string, unknown>): RenderScene => ({ id: 's', engine: 'motion-canvas', template: 'motion-canvas-layout', durationFrames: 60, props });

  it('applies the schema defaults and turns a "W:H" aspect into a number', () => {
    const v = sceneVariables(scene({ layout: { type: 'pip', aspect: '16:9' }, panes: [{ media: { asset: 'a' } }, { color: '#112233' }], lowerThird: { name: 'Sam' } }), output);
    expect(v.spec).toEqual({ type: 'pip', aspect: 16 / 9 });
    const props = v.props as { panes: Array<{ media?: { fit: string; startSeconds: number } }>; lowerThird: { align: string } };
    expect(props.panes[0]!.media).toEqual({ asset: 'a', fit: 'cover', startSeconds: 0 });
    expect(props.lowerThird.align).toBe('left');
    expect(v.fps).toBe(30);
    expect(v.frames).toBe(60);
    expect(sceneVariables(scene({ layout: { type: 'full' }, panes: [{}] }), { ...output, fps: '30000/1001' }).fps).toBeCloseTo(30000 / 1001, 12);
  });

  it('refuses props the schema refuses', () => {
    expect(() => sceneVariables(scene({ layout: { type: 'full' }, panes: [{}, {}] }), output)).toThrow(/exactly 1 pane/);
  });

  it('other templates get their props as given', () => {
    expect(sceneVariables({ id: 's', engine: 'motion-canvas', template: 'animated-explainer', durationFrames: 60, props: { title: 'T', points: ['a'] } }, output)).toEqual({ title: 'T', points: ['a'] });
  });
});
