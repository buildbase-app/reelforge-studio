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
  background: string | null;
  /** Font faces to load before the first frame (#303): project font assets and bundled fonts on the bundle server. */
  fonts?: Array<{ family: string; url: string; format: 'woff2' | 'woff' | 'truetype' | 'opentype'; weight: string; style: 'normal' | 'italic'; stretch?: string; unicodeRange?: string }>;
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
