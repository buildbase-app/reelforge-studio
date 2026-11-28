// Loaded into the HyperFrames CLI process (and any Node process it starts)
// with `--import` through NODE_OPTIONS (D-085, #318). Plain JavaScript on
// purpose: the CLI runs under plain Node, without a TypeScript loader.
//
// HyperFrames resolves web fonts on the Node side with the global `fetch`
// (its deterministic-font step asks fonts.googleapis.com for every font family
// the page names, with the page's characters in `text=`). That path does not go
// through its capture proxy, so it would bypass RenderWeld's deny-all sink.
// This guard refuses every global `fetch` that does not stay on this machine
// before any DNS lookup or connection happens:
//   - Google Fonts hosts: refused quietly; HyperFrames then keeps the CSS
//     fallback (local, bundled or system fonts), as the html engine does;
//   - anything else: refused and reported, and the engine fails the render
//     like any other blocked network attempt.
// Each refusal prints one marker line on stderr that the engine reads.
import { isIP } from 'node:net';

const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const LOCAL_PROTOCOLS = new Set(['data:', 'blob:', 'file:']);

function targetOf(input) {
  try {
    if (typeof input === 'string' || input instanceof URL) return new URL(String(input));
    if (input && typeof input.url === 'string') return new URL(input.url);
  } catch {
    // not a URL we can read: refused below
  }
  return null;
}

function staysLocal(url) {
  if (!url) return false;
  if (LOCAL_PROTOCOLS.has(url.protocol)) return true;
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  return isIP(host) === 4 && host.startsWith('127.');
}

const realFetch = globalThis.fetch;
if (typeof realFetch === 'function' && !realFetch.reelforgeGuarded) {
  const guarded = function fetch(input, init) {
    const url = targetOf(input);
    if (staysLocal(url)) return realFetch.call(this, input, init);
    const host = url ? url.host : '(unknown)';
    const font = url !== null && FONT_HOSTS.has(url.hostname.toLowerCase());
    try {
      process.stderr.write(`[RenderWeld:${font ? 'FONT_REFUSED' : 'EGRESS_REFUSED'}] host=${host}\n`);
    } catch {
      // stderr closed: still refuse
    }
    const cause = Object.assign(new Error(`connect ECONNREFUSED ${host}: RenderWeld renders have no network access`), { code: 'ECONNREFUSED' });
    return Promise.reject(new TypeError('fetch failed', { cause }));
  };
  Object.defineProperty(guarded, 'reelforgeGuarded', { value: true });
  globalThis.fetch = guarded;
}
