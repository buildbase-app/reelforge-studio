/**
 * `pnpm gallery serve [--port 8787]`: serves <out>/web at the same paths the
 * R2 bucket uses (`/gallery/<slug>/<file>`), with byte ranges and the same
 * immutable cache headers, so the store can be previewed against local media
 * (GALLERY_MEDIA_URL=http://127.0.0.1:8787) before R2 is live.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { CACHE_CONTROL } from './r2';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

/** `/gallery/<slug>/<file>` -> `<web>/<slug>/<file>`, or null outside it. */
export function resolveMediaPath(webDir: string, urlPath: string): string | null {
  const m = /^\/gallery\/([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(decodeURIComponent(urlPath.split('?')[0]!));
  if (!m) return null;
  const file = normalize(join(webDir, m[1]!, m[2]!));
  return file.startsWith(normalize(webDir)) ? file : null;
}

export function serveMedia(webDir: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const file = resolveMediaPath(webDir, req.url ?? '/');
    if (!file || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    const size = statSync(file).size;
    const headers: Record<string, string | number> = {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': CACHE_CONTROL,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return void res.end();
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}
