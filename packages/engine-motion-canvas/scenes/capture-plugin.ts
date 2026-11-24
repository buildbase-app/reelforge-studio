import {
  ObjectMetaField,
  makePlugin,
  type Exporter,
  type ExporterClass,
  type Project,
  type RendererSettings,
} from '@motion-canvas/core';
import type {} from '../src/protocol';

/**
 * A Motion Canvas exporter that hands every rendered frame to the Node process
 * driving the headless browser, instead of to the editor's dev server.
 *
 * The harness (src/render.ts) exposes `window.__reelforgeFrame` with
 * Playwright's exposeBinding; it writes each PNG to FFmpeg's stdin in order.
 * `handleFrame` awaits that call, so frames can never arrive out of order.
 */
async function canvasToBase64Png(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png')
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

class CaptureExporter implements Exporter {
  static readonly id = 'reelforge-capture';
  static readonly displayName = 'RenderWeld capture';

  static meta(): ObjectMetaField<any> {
    return new ObjectMetaField(this.id, {});
  }

  static async create(_project: Project, _settings: RendererSettings): Promise<Exporter> {
    return new CaptureExporter();
  }

  async handleFrame(canvas: HTMLCanvasElement, frame: number): Promise<void> {
    const send = window.__reelforgeFrame;
    if (!send) throw new Error('RenderWeld capture binding is missing');
    await send(frame, await canvasToBase64Png(canvas));
  }
}

/**
 * Registered through the Vite plugin's PLUGIN_OPTIONS.entryPoint (see
 * src/render.ts). In non-editor builds Motion Canvas ignores `plugins` listed
 * in makeProject, so this is the supported way to add an exporter.
 */
export default makePlugin({
  name: 'reelforge-capture',
  exporters(): ExporterClass[] {
    return [CaptureExporter as unknown as ExporterClass];
  },
});
