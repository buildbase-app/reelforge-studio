/**
 * The contract between the Node harness (src/render.ts) and the browser
 * runtime (scenes/runtime.ts, scenes/capture-plugin.ts).
 */
export interface RenderRequest {
  template: string;
  variables: Record<string, unknown>;
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** Export from this frame on (a frame range's first frame); the scene still runs from frame 0. Default 0. */
  firstFrame?: number;
  background: string | null;
}

export interface RenderResponse {
  ok: boolean;
  result: 'success' | 'error' | 'aborted';
  errors: string[];
}

declare global {
  interface Window {
    /** Set by the runtime: render one scene with the capture exporter. */
    __reelforgeRender?: (req: RenderRequest) => Promise<RenderResponse>;
    /** Set by the runtime once it has loaded. */
    __reelforgeReady?: boolean;
    /** Exposed by the harness: receives each frame as base64 PNG, in order. */
    __reelforgeFrame?: (frame: number, pngBase64: string) => Promise<void>;
  }
}
