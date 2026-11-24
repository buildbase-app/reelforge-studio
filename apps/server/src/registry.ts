import { ElevenLabsTts, FasterWhisperStt, PluginRegistry, RemotionLambdaBackend } from '@reelforge/core';
import { htmlEngine } from '@reelforge/engine-html';
import { hyperframesEngine } from '@reelforge/engine-hyperframes';
import { motionCanvasEngine } from '@reelforge/engine-motion-canvas';
import { remotionEngine } from '@reelforge/engine-remotion';

/**
 * The plugins this server ships with. To add an engine, provider or backend,
 * register it here (see AGENTS.md, "How to add a plugin").
 */
export function createDefaultRegistry(env: NodeJS.ProcessEnv = process.env): PluginRegistry {
  return new PluginRegistry()
    .registerEngine(remotionEngine())
    .registerEngine(motionCanvasEngine())
    .registerEngine(htmlEngine())
    .registerEngine(hyperframesEngine())
    .registerProvider(new ElevenLabsTts(env))
    .registerStt(new FasterWhisperStt())
    .registerBackend(new RemotionLambdaBackend(env));
}
