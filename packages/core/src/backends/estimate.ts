import { sceneFrames } from '@reelforge/project-schema';
import type { EstimateRequest } from '../plugins';

/** Seconds of finished video and render units (scenes) of a render or preview, for BackendEstimate. */
export function estimateUnits(req: EstimateRequest): { videoSeconds: number; units: number } {
  const fps = req.project.output.fps;
  const scenes = req.sceneIds ? req.project.scenes.filter((s) => req.sceneIds!.includes(s.id)) : req.project.scenes;
  const frames = scenes.reduce((n, s) => n + sceneFrames(s, fps), 0);
  return { videoSeconds: Math.round((frames / fps) * 1000) / 1000, units: scenes.length };
}
