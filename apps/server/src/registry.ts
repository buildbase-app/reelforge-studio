import { ElevenLabsTts, PluginRegistry, RemotionLambdaBackend } from '@reelforge/core';
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
    .registerProvider(new ElevenLabsTts(env))
    .registerBackend(new RemotionLambdaBackend(env));
}
