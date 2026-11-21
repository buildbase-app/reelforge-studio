/**
 * Generative designs for the hyperframes engine. HyperFrames compositions may
 * carry inline scripts; the runtime seeks every registered timeline on each
 * frame, so `draw(t)` below is a pure function of the scene time (window
 * __hfAnime adapter, see kit.hfScript). No randomness at draw time: every
 * "random" value comes from a seeded PRNG built once.
 */
import { EASE, MONO, d, esc, maskCss, maskLines, s, shell, type SceneCtx, type SceneSource } from './kit';

/** Common preamble: canvas, colours from the theme variables, seeded PRNG. */
function pre(seed: number): string {
  return `var cv=document.getElementById('cv'),g=cv.getContext('2d'),W=1080,H=1920;
var cs=getComputedStyle(document.documentElement);function V(n){return (cs.getPropertyValue(n)||'#fff').trim()}
var BG=V('--rf-bg'),TX=V('--rf-text'),A1=V('--rf-accent'),A2=V('--rf-accent2'),SF=V('--rf-surface');
var A3=getComputedStyle(document.querySelector('.hf-root')).getPropertyValue('--x3').trim()||A2;
var sd=${seed >>> 0 || 1};function R(){sd=(sd+0x6d2b79f5)>>>0;var t=sd;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296}
function rgba(hex,a){hex=hex.replace('#','');var n=parseInt(hex,16);return 'rgba('+(n>>16&255)+','+(n>>8&255)+','+(n&255)+','+a+')'}
function ease(x){x=Math.min(1,Math.max(0,x));return 1-Math.pow(2,-10*x)}`;
}

const CANVAS = '<canvas id="cv" width="1080" height="1920" style="position:absolute;inset:0;width:1080px;height:1920px"></canvas>';

function overlay(ctx: SceneCtx, o: { eyebrow?: string; lines: string[]; sub?: string; pos?: 'top' | 'center' | 'bottom'; size?: number }): { html: string; css: string } {
  const t0 = ctx.tin === 'none' ? 0.2 : 0.45;
  const top = o.pos === 'top' ? 260 : o.pos === 'bottom' ? 1080 : 640;
  return {
    html:
      `<div class="ov" style="top:${top}px">` +
      (o.eyebrow ? `<div class="ov-e rise" ${d(t0)}>${esc(o.eyebrow)}</div>` : '') +
      `<h1>${maskLines(o.lines, t0 + 0.15, 'mk', 0.07)}</h1>` +
      (o.sub ? `<p class="rise" ${d(t0 + 0.7)}>${esc(o.sub)}</p>` : '') +
      `</div>`,
    css:
      maskCss() +
      `.ov{position:absolute;left:90px;right:90px;text-align:center;z-index:5}
.ov-e{display:inline-block;font:500 32px/1.2 ${MONO};color:var(--rf-muted);margin-bottom:36px}
.ov h1{margin:0;font-size:${o.size ?? 136}px;line-height:.96;font-weight:var(--rf-heading-weight);letter-spacing:-.035em}
.ov p{margin:40px auto 0;max-width:820px;font-size:46px;line-height:1.25;font-weight:400;color:var(--rf-muted)}`,
  };
}

export interface CanvasTitle {
  eyebrow?: string;
  lines: string[];
  sub?: string;
  pos?: 'top' | 'center' | 'bottom';
  size?: number;
}

/* Silk: a ribbon of 54 sine lines that breathe and twist. Smooth and calm. */
export function flow(ctx: SceneCtx, p: CanvasTitle): SceneSource {
  const ov = overlay(ctx, p);
  const draw = `${pre(ctx.seed)}
var N=54;var draw=function(t){g.fillStyle=BG;g.fillRect(0,0,W,H);
var e=ease(t*.9);g.lineWidth=3;
for(var i=0;i<N;i++){var f=i/(N-1);g.strokeStyle=f>.82?rgba(A1,.9*e):rgba(TX,(.08+.3*Math.sin(f*Math.PI))*e);g.beginPath();
for(var x=-40;x<=W+40;x+=24){var u=x/W;var y=H*.62+Math.sin(u*5.2+t*.9+f*2.4)*(150+f*90)*e+Math.cos(u*2.1-t*.6+f*3.1)*120+(f-.5)*260*Math.sin(u*3.1+t*.5);if(x<=-40)g.moveTo(x,y);else g.lineTo(x,y)}g.stroke()}};`;
  return shell(ctx, { html: CANVAS + ov.html, css: ov.css, script: draw, push: false, backdrop: 'plain' });
}

/* Dotted globe with travelling arcs. */
export function globe(ctx: SceneCtx, p: CanvasTitle): SceneSource {
  const ov = overlay(ctx, { ...p, pos: p.pos ?? 'top' });
  const draw = `${pre(ctx.seed)}
var D=[];for(var la=-80;la<=80;la+=6){var n=Math.max(6,Math.round(64*Math.cos(la*Math.PI/180)));for(var k=0;k<n;k++){var lo=k/n*360;var land=Math.sin(lo*.05+la*.08)+Math.cos(lo*.031-la*.05)*1.2+Math.sin(la*.11)>0.35;D.push([la*Math.PI/180,lo*Math.PI/180,land])}}
var AR=[];for(var i=0;i<9;i++)AR.push([(R()-.5)*2.2,R()*6.28,(R()-.5)*2.2,R()*6.28,R()*2.5]);
var CX=540,CY=1150,RAD=430;
function prj(la,lo,rot){var x=Math.cos(la)*Math.sin(lo+rot),y=Math.sin(la),z=Math.cos(la)*Math.cos(lo+rot);var tl=-.35,y2=y*Math.cos(tl)-z*Math.sin(tl),z2=y*Math.sin(tl)+z*Math.cos(tl);return[CX+x*RAD,CY-y2*RAD,z2]}
var draw=function(t){g.fillStyle=BG;g.fillRect(0,0,W,H);var rot=t*.35;
var sc=.6+.4*ease(t*1.2);
for(var i=0;i<D.length;i++){var q=D[i],p=prj(q[0],q[1],rot);if(p[2]<-.05)continue;var a=(.25+.75*p[2])*sc;g.fillStyle=q[2]?rgba(TX,a*.75):rgba(TX,a*.18);g.beginPath();g.arc(CX+(p[0]-CX)*sc,CY+(p[1]-CY)*sc,q[2]?5:3,0,6.283);g.fill()}
for(var j=0;j<AR.length;j++){var r=AR[j];var st=r[4]*.4+.4,pr=Math.min(1,Math.max(0,(t-st)/1.4));if(pr<=0)continue;g.strokeStyle=A1;g.lineWidth=5;g.lineCap='round';g.beginPath();var seg=36,first=true;for(var k=0;k<=seg*pr;k++){var f=k/seg;var la=r[0]+(r[2]-r[0])*f,lo=r[1]+(r[3]-r[1])*f;var p=prj(la,lo,rot);var lift=1+Math.sin(f*Math.PI)*.18;var x=CX+(p[0]-CX)*lift*sc,y=CY+(p[1]-CY)*lift*sc;if(p[2]<-.1){first=true;continue}if(first){g.moveTo(x,y);first=false}else g.lineTo(x,y)}g.stroke();
var e=prj(r[0]+(r[2]-r[0])*pr,r[1]+(r[3]-r[1])*pr,rot);if(e[2]>0){g.fillStyle=TX;g.beginPath();g.arc(CX+(e[0]-CX)*sc,CY+(e[1]-CY)*sc,9,0,6.283);g.fill()}}};`;
  return shell(ctx, { html: CANVAS + ov.html, css: ov.css, script: draw, push: false });
}

/* Radial equalizer driven by a deterministic "beat". */
export function equalizer(ctx: SceneCtx, p: CanvasTitle & { bpm?: number }): SceneSource {
  const ov = overlay(ctx, { ...p, pos: p.pos ?? 'top', size: p.size ?? 120 });
  const bpm = p.bpm ?? 112;
  const draw = `${pre(ctx.seed)}
var N=96,F=[];for(var i=0;i<N;i++)F.push([R()*6.28,1+R()*3,R()]);var BEAT=60/${bpm};
var draw=function(t){g.fillStyle=BG;g.fillRect(0,0,W,H);var cx=540,cy=1180;var ph=(t%BEAT)/BEAT,kick=Math.exp(-ph*6);
var r0=210+kick*30;for(var i=0;i<N;i++){var f=F[i];var a=i/N*6.283-1.5708;var h=40+(Math.sin(t*f[1]*2+f[0])*.5+.5)*120*(.5+f[2])+kick*90*(i%4==0?1:.4);h*=ease(t*1.2);
g.strokeStyle=i%4==0?A1:rgba(TX,.55);g.lineWidth=11;g.lineCap='round';g.beginPath();g.moveTo(cx+Math.cos(a)*r0,cy+Math.sin(a)*r0);g.lineTo(cx+Math.cos(a)*(r0+h),cy+Math.sin(a)*(r0+h));g.stroke()}
g.fillStyle=SF;g.beginPath();g.arc(cx,cy,r0-26,0,6.283);g.fill();
g.fillStyle=A1;g.beginPath();g.moveTo(cx-40,cy-60);g.lineTo(cx+60,cy);g.lineTo(cx-40,cy+60);g.closePath();g.fill()};`;
  return shell(ctx, { html: CANVAS + ov.html, css: ov.css, script: draw, push: false });
}

/* Confetti burst for launches and milestones. */
export function burst(ctx: SceneCtx, p: CanvasTitle & { at?: number }): SceneSource {
  const ov = overlay(ctx, p);
  const at = p.at ?? (ctx.tin === 'none' ? 0.3 : 0.6);
  const draw = `${pre(ctx.seed)}
var N=260,P=[];for(var i=0;i<N;i++){var a=R()*6.283,v=350+R()*900;P.push({vx:Math.cos(a)*v,vy:Math.sin(a)*v-700,c:[A1,TX,rgba(TX,.5),A2][i%4],w:16+R()*22,h:9+R()*12,sp:(R()-.5)*14,o:R()*6})}
var draw=function(t){g.fillStyle=BG;g.fillRect(0,0,W,H);var cx=540,cy=900,tt=t-${at};
if(tt<0){g.fillStyle=A1;g.beginPath();g.arc(cx,cy,14,0,6.283);g.fill();return}
var ring=Math.min(1,tt/.6);g.strokeStyle=rgba(TX,(1-ring)*.8);g.lineWidth=10*(1-ring)+1;g.beginPath();g.arc(cx,cy,ring*700,0,6.283);g.stroke();
for(var i=0;i<N;i++){var q=P[i];var dr=Math.exp(-tt*1.6);var x=cx+q.vx*(1-dr)/1.6,y=cy+q.vy*(1-dr)/1.6+tt*tt*260;if(y>H+40)continue;g.save();g.translate(x,y);g.rotate(q.o+q.sp*tt);g.scale(1,Math.cos(q.o+tt*6));g.fillStyle=q.c;g.fillRect(-q.w/2,-q.h/2,q.w,q.h);g.restore()}};`;
  return shell(ctx, { html: CANVAS + ov.html, css: ov.css, script: draw, push: false });
}

/* Nodes orbiting a core, linked by lines (integrations, agents, teams). */
export function orbit(ctx: SceneCtx, p: CanvasTitle & { nodes: string[]; core?: string }): SceneSource {
  const ov = overlay(ctx, { ...p, pos: p.pos ?? 'top', size: p.size ?? 112 });
  const labels = p.nodes
    .slice(0, 6)
    .map((n, i) => `<div class="on-l" id="nl${i}">${esc(n)}</div>`)
    .join('');
  const draw = `${pre(ctx.seed)}
var NL=[].slice.call(document.querySelectorAll('.on-l'));var n=NL.length;var cx=540,cy=1160;
var draw=function(t){g.fillStyle=BG;g.fillRect(0,0,W,H);
for(var r=1;r<=3;r++){g.strokeStyle=rgba(TX,.08);g.lineWidth=2;g.setLineDash([6,14]);g.beginPath();g.ellipse(cx,cy,130*r+170,(130*r+170)*.7,0,0,6.283);g.stroke()}g.setLineDash([]);
var P=[];for(var i=0;i<n;i++){var ring=1+i%3;var rr=130*ring+170;var a=i/n*6.283+t*(.5/ring)*(i%2?1:-1);var e=ease((t-.3-i*.15)*1.6);P.push([cx+Math.cos(a)*rr*e,cy+Math.sin(a)*rr*.7*e,e])}
for(var i=0;i<n;i++){var q=P[i];var pulse=(t*1.2+i*.3)%1;g.strokeStyle=rgba(TX,.22*q[2]);g.lineWidth=3;g.beginPath();g.moveTo(cx,cy);g.lineTo(q[0],q[1]);g.stroke();
g.fillStyle=A1;g.beginPath();g.arc(cx+(q[0]-cx)*pulse,cy+(q[1]-cy)*pulse,7*q[2],0,6.283);g.fill();
g.fillStyle=SF;g.beginPath();g.arc(q[0],q[1],56*q[2],0,6.283);g.fill();g.strokeStyle=rgba(TX,.35);g.lineWidth=4;g.stroke();
var el=NL[i];el.style.transform='translate('+(q[0]-540).toFixed(1)+'px,'+(q[1]+74).toFixed(1)+'px)';el.style.opacity=q[2].toFixed(3)}
g.fillStyle=A1;g.beginPath();g.arc(cx,cy,120,0,6.283);g.fill();g.fillStyle=BG;g.font='600 44px Inter, sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillText(${JSON.stringify(p.core ?? 'API')},cx,cy)};`;
  const css =
    ov.css +
    `.on-l{position:absolute;left:0;top:0;width:1080px;text-align:center;font:700 32px/1 ${MONO};color:var(--rf-text);z-index:4;pointer-events:none}
.on-l::before{content:none}`;
  return shell(ctx, { html: CANVAS + labels + ov.html, css, script: draw, push: false });
}

/* Area/candle chart drawn live with a ticker (finance education, no crypto). */
export function liveChart(ctx: SceneCtx, p: CanvasTitle & { start: number; end: number; label: string }): SceneSource {
  const ov = overlay(ctx, { ...p, pos: 'top', size: p.size ?? 100 });
  const t0 = ctx.tin === 'none' ? 0.2 : 0.45;
  const html =
    CANVAS +
    ov.html +
    `<div class="lc-k rise" ${d(t0 + 0.6)}><b class="cnt" data-from="${p.start}" data-to="${p.end}" data-at="${t0 + 0.6}" data-len="${Math.max(1.5, ctx.dur - 2)}" data-pad="0">${p.start}</b><span>${esc(p.label)}</span></div>`;
  const css = ov.css + `.lc-k{position:absolute;left:90px;right:90px;top:1500px;display:flex;align-items:baseline;gap:24px;z-index:5}.lc-k b{font:500 120px/1 ${MONO};letter-spacing:-.04em;color:var(--rf-text);font-variant-numeric:tabular-nums}.lc-k span{font-size:40px;font-weight:400;color:var(--rf-muted)}`;
  const draw = `${pre(ctx.seed)}
var N=60,Y=[],v=0;for(var i=0;i<N;i++){v+= (R()-.38)*1.0;Y.push(v)}var mn=Math.min.apply(null,Y),mx=Math.max.apply(null,Y);
var X0=70,X1=1010,T=640,B=1380;function px(i){return X0+(X1-X0)*i/(N-1)}function py(y){return B-(y-mn)/(mx-mn)*(B-T)}
var draw=function(t){g.fillStyle=BG;g.fillRect(0,0,W,H);
g.strokeStyle=rgba(TX,.08);g.lineWidth=2;for(var k=0;k<6;k++){var yy=T+(B-T)*k/5;g.beginPath();g.moveTo(X0,yy);g.lineTo(X1,yy);g.stroke()}
var pr=Math.min(1,Math.max(0,(t-${t0 + 0.5})/${Math.max(1.5, ctx.dur - 2)}));pr=1-Math.pow(1-pr,2);var m=pr*(N-1);if(m<=0)return;var n=Math.floor(m);
g.beginPath();g.moveTo(px(0),py(Y[0]));for(var i=1;i<=n;i++)g.lineTo(px(i),py(Y[i]));var fx=px(m),fy=py(Y[n]+(Y[Math.min(N-1,n+1)]-Y[n])*(m-n));g.lineTo(fx,fy);
var path=new Path2D();path.moveTo(px(0),py(Y[0]));for(var i=1;i<=n;i++)path.lineTo(px(i),py(Y[i]));path.lineTo(fx,fy);path.lineTo(fx,B);path.lineTo(px(0),B);path.closePath();
g.fillStyle=rgba(A1,.12);g.fill(path);
g.strokeStyle=A1;g.lineWidth=8;g.lineJoin='round';g.stroke();
g.setLineDash([8,10]);g.strokeStyle=rgba(TX,.4);g.lineWidth=2;g.beginPath();g.moveTo(X0,fy);g.lineTo(X1,fy);g.stroke();g.setLineDash([]);
g.fillStyle=BG;g.beginPath();g.arc(fx,fy,14,0,6.283);g.fill();g.strokeStyle=A1;g.lineWidth=6;g.stroke();};`;
  return shell(ctx, { html, css, script: draw, push: false });
}

export const CANVAS_DESIGNS = { flow, globe, equalizer, burst, orbit, liveChart } as const;
export type CanvasDesignName = keyof typeof CANVAS_DESIGNS;
export { EASE, s };
