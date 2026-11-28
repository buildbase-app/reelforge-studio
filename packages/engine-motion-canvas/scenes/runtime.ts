import { Renderer, RendererResult, Vector2, type Project } from '@motion-canvas/core';
import { loadFontFaces } from '@renderweld/project-schema/media';
import type {} from '../src/protocol';

/**
 * Browser entry point for headless rendering. The Node harness opens a page
 * that loads this module, then calls `window.__reelforgeRender(...)`.
 *
 * Motion Canvas only renders from its editor UI out of the box; this calls the
 * same `Renderer` class the editor uses, with the RenderWeld capture exporter.
 */
const projects: Record<string, () => Promise<{ default: Project }>> = {
  'animated-explainer': () => import('./animated-explainer/project?project'),
  'motion-canvas-layout': () => import('./layout/project?project'),
};

window.__reelforgeRender = async (req) => {
  const load = projects[req.template];
  if (!load) {
    return { ok: false, result: 'error', errors: [`unknown Motion Canvas template "${req.template}"`] };
  }
  // Fonts first (#303): Txt measures and draws with canvas, which uses only fonts that have loaded.
  try {
    await loadFontFaces(req.fonts ?? []);
  } catch (e) {
    return { ok: false, result: 'error', errors: [(e as Error).message] };
  }
  const project = (await load()).default;
  const errors: string[] = [];
  project.logger.onLogged.subscribe((payload) => {
    if (payload.level === 'error') {
      errors.push(String(payload.message) + (payload.stack ? `\n${payload.stack}` : ''));
    }
  });
  project.variables = req.variables;

  const renderer = new Renderer(project);
  let result = RendererResult.Error as RendererResult;
  renderer.onFinished.subscribe((r) => {
    result = r;
  });
  await renderer.render({
    name: project.name,
    // The renderer exports frames from..to inclusive, so N frames end at (N-1)/fps.
    range: [(req.firstFrame ?? 0) / req.fps, (req.frames - 1) / req.fps],
    fps: req.fps,
    size: new Vector2(req.width, req.height),
    resolutionScale: 1,
    colorSpace: 'srgb',
    background: req.background,
    exporter: { name: 'reelforge-capture', options: {} },
  });

  const name =
    result === RendererResult.Success ? 'success' : result === RendererResult.Aborted ? 'aborted' : 'error';
  return { ok: name === 'success' && errors.length === 0, result: name, errors };
};

window.__reelforgeReady = true;
