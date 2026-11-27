// Terminal-style HTML views: static ones for real CLI/HTTP sessions (studio
// "screenshots") and an animated replay of a recorded agent session. Plain
// HTML and CSS, system monospace fonts, no network. Text is masked again
// here (maskText) before it reaches a page.

import { maskText } from './lib.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Strips ANSI colour codes and carriage-return redraws (progress bars) from captured output. */
export function cleanOutput(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .split('\n')
    .map((line) => line.split('\r').filter(Boolean).pop() ?? '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

const BASE_CSS = `
:root{--bg:#0f1215;--panel:#151a1f;--line:#262d35;--text:#d7dde4;--muted:#8a94a1;--accent:#ff5a7e;--ok:#7fd1a8;--warn:#e9c46a}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text)}
body{font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono","Liberation Mono",monospace;padding:28px}
.term{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.bar{display:flex;justify-content:space-between;gap:16px;padding:10px 16px;border-bottom:1px solid var(--line);color:var(--muted);font-size:13px}
.bar b{color:var(--text);font-weight:600}
.body{padding:18px 20px;white-space:pre-wrap;word-break:break-word}
.cmd{color:var(--text)}.cmd::before{content:"$ ";color:var(--accent)}
.out{color:var(--muted);margin:2px 0 16px}.out:last-child{margin-bottom:0}
.note{color:var(--muted);font-size:13px;margin-top:14px}
`;

/**
 * A static terminal view. `blocks` are { cmd, output } pairs, as they ran;
 * `title` names the session, `meta` goes on the right of the title bar.
 */
export function terminalPage({ title, meta = '', blocks, note = '', width = 1280 }) {
  const body = blocks
    .map((b) => `${b.cmd ? `<div class="cmd">${esc(maskText(b.cmd))}</div>` : ''}<div class="out">${esc(maskText(cleanOutput(b.output ?? '')))}</div>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${width}"><title>${esc(title)}</title><style>${BASE_CSS}</style></head>
<body><div class="term"><div class="bar"><b>${esc(title)}</b><span>${esc(meta)}</span></div><div class="body">${body}</div></div>${note ? `<div class="note">${esc(note)}</div>` : ''}</body></html>`;
}

/** Very small Markdown for the agent's reply: code spans, bold, list bullets; tables stay as text. */
function replyHtml(md) {
  return esc(maskText(md))
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/^- /gm, '• ');
}

/**
 * The animated replay of a recorded agent session: the command and prompt
 * are typed, each tool call appears with its result (get_job with a progress
 * bar), then the reply, then the reel the session rendered plays beside it
 * (below it in the 9:16 layout). Sets `window.__replayDone` when finished.
 */
export function replayPage(fixture, { reelSrc, vertical = false }) {
  const data = {
    command: maskText(fixture.command),
    prompt: maskText(fixture.prompt),
    tools: fixture.tools.map((t) => (t.name ? { name: t.name, input: maskText(t.input ?? ''), result: maskText(t.result ?? ''), seconds: t.seconds ?? 0 } : { say: maskText(t.say) })),
    reply: replyHtml(fixture.reply),
  };
  const facts = `final.mp4 · ${fixture.render.width}×${fixture.render.height} · ${fixture.render.durationSeconds} s · ${fixture.render.frames} frames · rendered in ${fixture.render.renderSeconds} s`;
  const when = fixture.date ? fixture.date.slice(0, 10) : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent session replay</title><style>${BASE_CSS}
body{padding:20px;height:100vh;overflow:hidden;font-size:${vertical ? 14 : 14.5}px}
.wrap{display:grid;gap:18px;height:100%;${vertical ? 'grid-template-rows:minmax(0,1fr) 46%;' : 'grid-template-columns:minmax(0,1fr) 340px;'}}
.term{display:flex;flex-direction:column;min-height:0}
.body{flex:1;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end}
.prompt{color:var(--text);border-left:2px solid var(--accent);padding-left:12px;margin:6px 0 14px}
.tool{margin:8px 0 0}.tool .name{color:var(--accent)}.tool .args{color:var(--muted)}
.res{color:var(--muted);padding-left:18px}.res.ok{color:var(--ok)}
.say{color:var(--text);margin:10px 0 0}
.bar2{display:inline-block;width:160px;height:8px;border-radius:4px;background:var(--line);vertical-align:middle;margin-left:8px;overflow:hidden}
.bar2 i{display:block;height:100%;width:0;background:var(--accent);transition:width .8s ease-out}
.reply{color:var(--text);margin-top:12px}.reply code{color:var(--warn)}
.reel{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:0;border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:14px}
.reel video{max-height:100%;max-width:100%;min-height:0;flex:1;border-radius:8px;opacity:0;transition:opacity .6s}
.reel .wait{color:var(--muted);font-size:13px}.reel .facts{color:var(--muted);font-size:12px;text-align:center}
.foot{position:fixed;left:20px;right:20px;bottom:6px;color:var(--muted);font-size:11px;text-align:right}
.caret::after{content:"▍";color:var(--accent)}
</style></head><body>
<div class="wrap"><div class="term"><div class="bar"><b>Claude Code → RenderWeld over MCP</b><span>recorded ${esc(when)} · ${esc(fixture.model ?? '')}</span></div><div class="body" id="log"></div></div>
<div class="reel"><div class="wait" id="wait">waiting for the render…</div><video id="v" src="${esc(reelSrc)}" muted playsinline preload="auto"></video><div class="facts" id="facts" hidden>${esc(facts)}</div></div></div>
<div class="foot">Replay of a recorded session: real prompt, tool calls, results and reel; waits shortened (the real run took ${fixture.durationSeconds} s).</div>
<script>
const D = ${JSON.stringify(data).replace(/</g, "\\u003c")};
const log = document.getElementById('log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const add = (cls, html = '') => { const el = document.createElement('div'); el.className = cls; el.innerHTML = html; log.appendChild(el); return el; };
async function type(el, text, cps) { el.classList.add('caret'); for (let i = 0; i < text.length; i += 3) { el.textContent = text.slice(0, i + 3); await sleep(3000 / cps); } el.classList.remove('caret'); }
(async () => {
  await sleep(600);
  await type(add('cmd'), D.command.replace('"<prompt>"', '"…"'), 220);
  await sleep(300);
  await type(add('prompt'), D.prompt, ${vertical ? 260 : 300});
  await sleep(500);
  for (const t of D.tools) {
    if (t.say) { add('say', t.say.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])); await sleep(900); continue; }
    const el = add('tool', '<span class="name">● ' + t.name + '</span><span class="args">(' + t.input.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]) + ')</span>');
    await sleep(450);
    const res = add('res', '⎿ …');
    const pct = /(\\d+)%/.exec(t.result);
    if (t.name === 'get_job' && pct) {
      res.innerHTML = '⎿ waiting up to 45 s <span class="bar2"><i></i></span>';
      await sleep(80); res.querySelector('i').style.width = pct[1] + '%';
      await sleep(1300);
    } else await sleep(Math.min(1200, 400 + t.seconds * 60));
    res.textContent = '⎿ ' + t.result;
    if (/succeeded|ok: true/.test(t.result)) res.classList.add('ok');
    await sleep(650);
  }
  await sleep(400);
  const r = add('reply'); r.innerHTML = D.reply.split('\\n').slice(0, ${vertical ? 8 : 9}).join('\\n');
  await sleep(1200);
  document.getElementById('wait').hidden = true;
  const v = document.getElementById('v'); v.style.opacity = 1; document.getElementById('facts').hidden = false;
  await v.play().catch(() => {});
  await new Promise((done) => { v.onended = done; setTimeout(done, 15000); });
  await sleep(800);
  window.__replayDone = true;
})();
</script></body></html>`;
}
