import { ElevenLabsTts, FasterWhisperStt, PluginRegistry, RemotionLambdaBackend } from '@renderweld/core';
import { htmlEngine } from '@renderweld/engine-html';
import { hyperframesEngine } from '@renderweld/engine-hyperframes';
import { motionCanvasEngine } from '@renderweld/engine-motion-canvas';
import { remotionEngine } from '@renderweld/engine-remotion';

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
