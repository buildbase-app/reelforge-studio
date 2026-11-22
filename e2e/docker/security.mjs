// Scene isolation in the release image (private security review SEC-01/02/03; D-085..D-087).
// Runs in a client container with the network alias "canary": it listens on TCP and UDP
// itself and renders HyperFrames scenes that try to reach it in several ways. Nothing
// may arrive; a scene that navigates away must fail fast with a clear error.
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';

const B = 'http://reelforge:4321', K = process.env.KEY;
let fail = 0;
const check = (name, ok, extra = '') => { if (!ok) fail++; console.log(`${ok ? '✔' : '✘'} ${name}${extra ? `: ${extra}` : ''}`); };
const req = (p, o = {}) => fetch(B + p, { ...o, headers: { 'content-type': 'application/json', authorization: `Bearer ${K}` } });

const ip = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
const hits = [];
const http = createServer((q, r) => { hits.push(`tcp ${q.url}`); r.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' }).end('<h1>CANARY</h1>'); });
await new Promise((r) => http.listen(8099, '0.0.0.0', r));
const udp = createSocket('udp4'); udp.on('message', () => hits.push('udp'));
await new Promise((r) => udp.bind(8098, '0.0.0.0', r));
console.log(`   canary at ${ip}:8099 (tcp) and :8098 (udp), also as http://canary:8099`);

const clip = '<div class="clip" data-start="0" data-duration="1" style="position:absolute;inset:0;background:#123"><h1 style="color:#fff">isolation</h1></div>';
async function render(id, html) {
  hits.length = 0;
  const manifest = { schemaVersion: '0.2', projectId: id, title: `Isolation check ${id}`, output: { width: 360, height: 640, fps: 30, format: 'mp4' }, scenes: [{ id: 's', engine: 'hyperframes', durationFrames: 30, props: {}, html }] };
  const created = await req('/v1/projects', { method: 'POST', body: JSON.stringify({ manifest }) });
  if (created.status !== 201) return { state: 'invalid', error: { message: `create ${created.status}: ${(await created.text()).slice(0, 300)}` }, ms: 0 };
  const started = Date.now();
  const r = await (await req(`/v1/projects/${id}/renders`, { method: 'POST', body: '{}' })).json();
  const jobId = r.job?.id ?? r.job?.jobId;
  let j;
  for (;;) { j = await (await req(`/v1/jobs/${jobId}?wait=45`)).json(); if (['succeeded', 'failed', 'cancelled'].includes(j.state ?? j.status)) break; }
  await new Promise((res) => setTimeout(res, 1000)); // late packets
  return { state: j.state ?? j.status, error: j.error, ms: Date.now() - started };
}

let r = await render('sec-nav-ip', `${clip}<script>setTimeout(()=>{location.href='http://${ip}:8099/nav'},10)</script>`);
check('navigation to an internal address fails the render', r.state === 'failed' && /tried to reach the network/.test(r.error?.message ?? ''), `${r.state} in ${r.ms} ms: ${(r.error?.message ?? '').slice(0, 120)}`);
check('  ... fast (< 60 s) and nothing reached the canary', r.ms < 60_000 && hits.length === 0, `${r.ms} ms, hits ${JSON.stringify(hits)}`);
r = await render('sec-nav-host', `${clip}<script>setTimeout(()=>{location.href='http://canary:8099/nav'},10)</script>`);
check('navigation to a host name fails the render, nothing reached', r.state === 'failed' && /tried to reach the network/.test(r.error?.message ?? '') && hits.length === 0, `${r.state}, hits ${JSON.stringify(hits)}`);
r = await render('sec-webrtc', `${clip}<script>try{const pc=new (window.RTCPeerConnection||Object)({iceServers:[{urls:'stun:${ip}:8098'}]});pc.createDataChannel('a');pc.createOffer().then(o=>pc.setLocalDescription(o))}catch(e){}try{const f=document.createElement('iframe');document.body.appendChild(f);const pc=new f.contentWindow.RTCPeerConnection({iceServers:[{urls:'stun:${ip}:8098'}]});pc.createDataChannel('b');pc.createOffer().then(o=>pc.setLocalDescription(o))}catch(e){}</script>`);
check('WebRTC (STUN over UDP) sends nothing', r.state !== 'invalid' && hits.length === 0, `render ${r.state}, hits ${JSON.stringify(hits)}`);
r = await render('sec-doc', `<html><!-- <head> --><head><title>t</title></head><body><div data-composition-id="main" data-start="0" data-duration="1" data-width="360" data-height="640">${clip}<iframe src="http://${ip}:8099/iframe"></iframe><img src="http://${ip}:8099/img"><script>fetch('http://${ip}:8099/fetch').catch(()=>{})</script></div></body></html>`);
check('a full-document scene reaches nothing (iframe, img, fetch)', r.state !== 'invalid' && hits.length === 0, `render ${r.state}, hits ${JSON.stringify(hits)}`);
r = await render('sec-csp', `<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body><div data-composition-id="main" data-width="360" data-height="640"></div></body></html>`);
check('a document that brings its own CSP is refused', r.state === 'failed' && /http-equiv/.test(r.error?.message ?? ''), `${r.state}: ${(r.error?.message ?? '').slice(0, 120)}`);

const caps = await (await req('/v1/capabilities')).json();
const sb = caps.security?.chromiumSandbox ?? {};
check("Chromium's own sandbox is on by default for html, hyperframes and motion-canvas", sb.html === true && sb.hyperframes === true && sb['motion-canvas'] === true, JSON.stringify(sb));
http.close(); udp.close();
process.exit(fail ? 1 : 0);
