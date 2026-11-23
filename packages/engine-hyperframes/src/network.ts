import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Outbound network blocking for HyperFrames renders (D-085).
 *
 * HyperFrames' own "restricted page network" mode starts the browser with a
 * local capture proxy (`--proxy-server`, loopback not bypassed except for its
 * page server, QUIC off, WebRTC limited to proxied connections) and routes its
 * own asset downloads through the same proxy. ReelForge points that proxy's
 * upstream at this sink, which refuses every request, and marks every address
 * as non-public, so nothing leaves the machine: not from the page, not from
 * the CLI. Each refused attempt is reported, and the engine fails the render
 * at once with a clear error (a scene that navigates away or tries to fetch
 * something outside its own files cannot render correctly anyway).
 */
export interface NetworkSink {
  url: string;
  attempts: string[];
  close(): Promise<void>;
}

export async function startNetworkSink(onAttempt: (target: string) => void): Promise<NetworkSink> {
  const attempts: string[] = [];
  const sockets = new Set<Socket>();
  const record = (target: string | undefined) => {
    const t = (target ?? '').slice(0, 200) || '(unknown)';
    if (attempts.length < 20) attempts.push(t);
    onAttempt(t);
  };
  const server: Server = createServer((req, res) => {
    let target = req.url;
    try {
      target = new URL(req.url ?? '').host || req.url;
    } catch {
      // not an absolute URL
    }
    record(target);
    res.writeHead(403, { Connection: 'close', 'Content-Length': '0' }).end();
  });
  server.on('clientError', (_e, s) => s.destroy());
  server.on('connection', (s) => {
    s.on('error', () => undefined);
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  server.on('connect', (req, socket) => {
    socket.on('error', () => undefined);
    record(req.url);
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => undefined);
    record(req.headers.host);
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    attempts,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** HyperFrames prints this line when its capture proxy refuses a non-public destination. */
export const REFUSED_LINE = /\[CaptureProxy:REFUSED\]\s*class=([\w-]+)/;

/**
 * The CLI's own Node-side `fetch` (HyperFrames' web-font resolver asks
 * fonts.googleapis.com for every family the page names, with the page's
 * characters) does not go through the capture proxy (#318). `egress-guard.mjs`
 * is preloaded into the CLI and refuses every global fetch that leaves the
 * machine, before any DNS lookup or connection. These are the lines it prints.
 */
export const FONT_REFUSED_LINE = /\[ReelForge:FONT_REFUSED\] host=(\S+)/;
export const EGRESS_REFUSED_LINE = /\[ReelForge:EGRESS_REFUSED\] host=(\S+)/;

/** file: URL of the fetch guard, for `--import`. */
export function egressGuardUrl(): string {
  return pathToFileURL(fileURLToPath(new URL('./egress-guard.mjs', import.meta.url))).href;
}

/**
 * Environment additions that keep the CLI's Node side off the network:
 * the fetch guard preloaded through NODE_OPTIONS (kept after the base value,
 * so it applies to every Node process the CLI starts) and, with `sink`,
 * Node's own proxy support pointed at the deny-all sink as a second line
 * (Node >= 22.21 honours it for `fetch` and `http(s).request`; loopback stays
 * direct), so a request that slips past the guard is refused and reported.
 */
export function nodeEgressEnv(baseNodeOptions: string | undefined, sink?: string): Record<string, string> {
  const nodeOptions = [baseNodeOptions?.trim(), `--import=${egressGuardUrl()}`].filter(Boolean).join(' ');
  return {
    NODE_OPTIONS: nodeOptions,
    ...(sink
      ? { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: sink, HTTPS_PROXY: sink, NO_PROXY: 'localhost,127.0.0.1,::1' }
      : {}),
  };
}
