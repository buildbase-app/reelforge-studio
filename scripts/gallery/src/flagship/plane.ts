/**
 * Flagship reel: "How does a 400-tonne plane fly?" One HyperFrames
 * composition, 28 s, drawn on a canvas by a pure function of time (seeked by
 * the runtime through window.__hfAnime). Five acts: the hook (a 747 above the
 * clouds), a slice of the wing in a stream of air, the angle of attack, a cut
 * through a turbofan, and the payoff. Captions are DOM text, also driven from
 * the seek, so every frame is reproducible.
 *
 * Facts used (general, well known): a fully loaded 747-400 weighs about
 * 400 t at take-off (MTOW 396.9 t); wingspan about 64 m; rotation at roughly
 * 300 km/h; a CF6-80C2-class turbofan moves on the order of 800 kg of air per
 * second at take-off.
 */
import { composition, type FlagshipReel } from './kit';

const DUR = 28;

const SCRIPT = String.raw`
var cv=document.getElementById('cv'),g=cv.getContext('2d'),W=1080,H=1920;
var sd=747;function R(){sd=(sd+0x6d2b79f5)>>>0;var t=sd;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296}
function cl(x){return x<0?0:x>1?1:x}
function seg(t,a,b){return cl((t-a)/(b-a))}
function eo(x){x=cl(x);return 1-Math.pow(1-x,3)}
function eio(x){x=cl(x);return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2}
function lerp(a,b,f){return a+(b-a)*f}
function rgba(c,a){return 'rgba('+c[0]+','+c[1]+','+c[2]+','+a+')'}
function mix(c1,c2,f){return [Math.round(lerp(c1[0],c2[0],f)),Math.round(lerp(c1[1],c2[1],f)),Math.round(lerp(c1[2],c2[2],f))]}
var INK=[11,22,38],SKY1=[14,36,64],SKY2=[38,74,112],DUSK=[232,140,92],WHITE=[244,246,250],CYAN=[126,214,255],ORANGE=[255,122,40],BLUE=[64,132,246],GREY=[150,164,182];
var ELEMENTS=0;

/* ---------- shared: sky and clouds ---------- */
var CLOUDS=[];for(var i=0;i<46;i++){var layer=i%3;var puffs=[];var n=9+Math.floor(R()*8);for(var k=0;k<n;k++)puffs.push([(R()-.5)*260*(1+layer*.4),(R()-.5)*50*(1+layer*.3),(34+R()*46)*(1+layer*.35)]);CLOUDS.push({x:R()*1600,y:1330+layer*170+R()*200,layer:layer,p:puffs})}
function sky(t,dusk){var gr=g.createLinearGradient(0,0,0,H);gr.addColorStop(0,rgba(mix(INK,SKY1,.4),1));gr.addColorStop(.55,rgba(SKY2,1));gr.addColorStop(.82,rgba(mix(SKY2,DUSK,.55*dusk),1));gr.addColorStop(1,rgba(mix(SKY2,DUSK,.9*dusk),1));g.fillStyle=gr;g.fillRect(0,0,W,H);
g.fillStyle=rgba(mix(DUSK,[255,214,160],.6),.9*dusk);g.beginPath();g.arc(210,1370,120,0,6.283);g.fill();g.fillStyle=rgba([255,232,200],.95*dusk);g.beginPath();g.arc(210,1370,84,0,6.283);g.fill();
for(var i=0;i<90;i++){var sx=(i*137.5)%W,sy=(i*71.3)%760;g.fillStyle=rgba(WHITE,.12+.1*Math.sin(i+t));g.fillRect(sx,sy,2,2);ELEMENTS++}}
var CORD=CLOUDS.slice().sort(function(a,b){return a.y-b.y});
function clouds(t,speed,yoff,alpha){for(var i=0;i<CORD.length;i++){var c=CORD[i];var depth=cl((c.y-1330)/560);var v=speed*(40+depth*170);var x=((c.x-t*v)%1700+1700)%1700-300;var y=c.y+yoff*(1+depth*.6);var sc=.75+depth*.6;var base=y+30*sc;
var sh=mix(mix([104,100,138],DUSK,.4),[214,196,206],depth),lit=mix(mix([226,170,160],DUSK,.2),[255,250,248],depth);
g.save();g.globalAlpha=alpha;g.beginPath();g.rect(x-600,y-480,1200,base-y+480);g.clip();
g.fillStyle=rgba(sh,1);g.beginPath();for(var k=0;k<c.p.length;k++){var p=c.p[k];g.moveTo(x+p[0]*sc+p[2]*sc,y+p[1]*sc);g.arc(x+p[0]*sc,y+p[1]*sc,p[2]*sc,0,6.283);ELEMENTS++}g.fill();
g.fillStyle=rgba(lit,1);g.beginPath();for(var k=0;k<c.p.length;k++){var p=c.p[k];g.moveTo(x+p[0]*sc+p[2]*sc*.9-8,y+p[1]*sc-14);g.arc(x+p[0]*sc-8,y+p[1]*sc-14,p[2]*sc*.9,0,6.283);ELEMENTS++}g.fill();
g.restore()}}

/* ---------- the 747 (side view), drawn at scale s with nose to the right ---------- */
function plane(x,y,s,rot,t){g.save();g.translate(x,y);g.rotate(rot);g.scale(s,s);
/* far wing */g.fillStyle=rgba(GREY,1);g.beginPath();g.moveTo(-40,10);g.lineTo(-170,-70);g.lineTo(-130,-74);g.lineTo(40,0);g.closePath();g.fill();
/* tail */g.fillStyle=rgba([206,214,226],1);g.beginPath();g.moveTo(-360,-10);g.lineTo(-420,-150);g.lineTo(-370,-150);g.lineTo(-290,-20);g.closePath();g.fill();
g.beginPath();g.moveTo(-350,0);g.lineTo(-430,-30);g.lineTo(-410,-38);g.lineTo(-320,-8);g.closePath();g.fill();
/* fuselage */var fg=g.createLinearGradient(0,-48,0,52);fg.addColorStop(0,'#ffffff');fg.addColorStop(.6,'#e4e9f0');fg.addColorStop(1,'#b9c3d1');g.fillStyle=fg;
g.beginPath();g.moveTo(-400,-6);g.bezierCurveTo(-380,-40,-300,-44,-200,-44);g.lineTo(150,-44);g.bezierCurveTo(200,-44,230,-78,290,-80);g.bezierCurveTo(350,-80,400,-40,420,0);g.bezierCurveTo(410,30,380,44,330,46);g.lineTo(-250,46);g.bezierCurveTo(-330,46,-390,24,-400,-6);g.closePath();g.fill();
/* belly stripe and cheat line */g.fillStyle=rgba(ORANGE,1);g.fillRect(-380,8,720,6);
/* windows: main deck and upper deck */g.fillStyle=rgba([40,60,90],1);for(var i=0;i<44;i++){g.fillRect(-300+i*14,-18,7,10);ELEMENTS++}for(var i=0;i<9;i++){g.fillRect(190+i*14,-62,7,9);ELEMENTS++}
/* cockpit */g.fillStyle=rgba([30,45,70],1);g.beginPath();g.moveTo(372,-34);g.lineTo(398,-20);g.lineTo(366,-22);g.closePath();g.fill();
/* near wing */g.fillStyle=rgba([196,205,218],1);g.beginPath();g.moveTo(-30,20);g.lineTo(-200,120);g.lineTo(-150,124);g.lineTo(80,26);g.closePath();g.fill();
/* engines under the near wing */for(var e=0;e<2;e++){var ex=-40-e*92,ey=62+e*36;g.fillStyle=rgba([170,182,198],1);g.beginPath();g.ellipse(ex,ey,48,15,0,0,6.283);g.fill();g.fillStyle=rgba([60,74,96],1);g.beginPath();g.ellipse(ex+44,ey,6,13,0,0,6.283);g.fill();ELEMENTS+=2}
g.restore();ELEMENTS+=12}

/* ---------- airfoil (NACA 2412), chord C px, leading edge at (lx,ly), angle a ---------- */
function naca(xc){var m=.04,p=.4,tt=.15;var yt=5*tt*(.2969*Math.sqrt(xc)-.126*xc-.3516*xc*xc+.2843*xc*xc*xc-.1015*xc*xc*xc*xc);var yc=xc<p?m/(p*p)*(2*p*xc-xc*xc):m/((1-p)*(1-p))*((1-2*p)+2*p*xc-xc*xc);return [yc+yt,yc-yt]}
var AF=[];for(var i=0;i<=80;i++){var xc=(1-Math.cos(i/80*Math.PI))/2;var r=naca(xc);AF.push([xc,r[0],r[1]])}
function airfoilPath(cx,cy,C,a){g.save();g.translate(cx,cy);g.rotate(-a);g.beginPath();for(var i=0;i<AF.length;i++){var p=AF[i];var x=(p[0]-.5)*C,y=-p[1]*C;i?g.lineTo(x,y):g.moveTo(x,y)}for(var i=AF.length-1;i>=0;i--){var p=AF[i];g.lineTo((p[0]-.5)*C,-p[2]*C)}g.closePath();g.restore()}

/* Flow field around the wing: a lane starts at height y0 (relative to the wing
   centre) far upstream; returns its height at x. Lanes above bend over the
   camber and speed up; behind the trailing edge the stream is turned down by
   the angle of attack (downwash). */
function laneY(y0,x,C,a){var d=Math.abs(y0);var xn=x/C+.5;var inside=xn>0&&xn<1?Math.sin(Math.PI*xn):0;var near=Math.exp(-d/(C*.42));
var bump=y0<0?-(inside*C*.13+inside*C*a*.9)*near:-(inside*C*.04)*near;
var wake=xn>1?Math.min(1,(xn-1)*1.6):0;var down=Math.sin(a)*C*(.15+wake*.9)*near*(xn>.4?cl((xn-.4)*2):0);
var defl=xn<0?Math.exp(xn*3)*(-Math.sin(a)*C*.2*near):0;
return y0+bump+down+defl}
function laneSpeed(y0,C,a){var d=Math.abs(y0);var near=Math.exp(-d/(C*.45));return y0<0?1+(.55+a*2.2)*near:1-(.22)*near}

var LANES=70,PER=20,PH=[];for(var i=0;i<LANES*PER;i++)PH.push(R());
function stream(t,cx,cy,C,a,alpha,showSpeed){var span=W+400;for(var l=0;l<LANES;l++){var y0=(l-LANES/2+.5)*22;if(Math.abs(y0)<8)continue;var v=laneSpeed(y0,C,a);
for(var k=0;k<PER;k++){var ph=PH[l*PER+k];var x=((ph*span+t*360*v)%span)-span/2;var y=laneY(y0,x,C,a);var x2=x-22*v*v*v,y2=laneY(y0,x2,C,a);
var col=y0<0?mix(WHITE,CYAN,showSpeed*cl((v-1)*2)):mix(WHITE,[200,210,230],showSpeed*.6);g.strokeStyle=rgba(col,alpha*(.4+.55*Math.exp(-Math.abs(y0)/300)));g.lineWidth=y0<0?3.6:2.6;g.beginPath();g.moveTo(cx+x2,cy+y2);g.lineTo(cx+x,cy+y);g.stroke();ELEMENTS++}}}

/* Pressure field: a dot grid tinted blue (low) above and orange (high) below. */
function pressure(cx,cy,C,a,alpha){if(alpha<=0)return;for(var r=0;r<38;r++)for(var c=0;c<24;c++){var x=-W/2+22+c*44,y=-760+r*40;var xn=x/C+.5;var along=Math.exp(-Math.pow((xn-.35)/.55,2));var d=Math.abs(y);var f=along*Math.exp(-d/320)*(1+a*4);var low=y<0;var col=low?BLUE:ORANGE;var aa=alpha*cl(f*(low?1.15:.75));if(aa<.02)continue;g.fillStyle=rgba(col,aa*.85);g.beginPath();g.arc(cx+x,cy+y,5+9*cl(f),0,6.283);g.fill();ELEMENTS++}}

function arrow(x,y,len,ang,col,w,alpha){if(alpha<=0||len<2)return;g.save();g.translate(x,y);g.rotate(ang);g.globalAlpha=alpha;g.fillStyle=rgba(col,1);g.fillRect(-w/2,-len+w*1.4,w,len-w*1.4);g.beginPath();g.moveTo(-w*1.6,-len+w*1.6);g.lineTo(0,-len-w*.6);g.lineTo(w*1.6,-len+w*1.6);g.closePath();g.fill();g.restore();ELEMENTS++}

/* ---------- turbofan cutaway, centred at (cx,cy), length L ---------- */
var CORE=[],BYP=[],FL=[];for(var i=0;i<380;i++)CORE.push([R(),R()*2-1]);for(var i=0;i<560;i++)BYP.push([R(),R()]);for(var i=0;i<260;i++)FL.push([R(),R()*2-1,R()]);
function engine(t,cx,cy,L,alpha){if(alpha<=0)return;g.save();g.globalAlpha=alpha;g.translate(cx,cy);var x0=-L/2,Rn=300;
/* nacelle */g.fillStyle=rgba([34,52,78],1);g.beginPath();g.moveTo(x0,-Rn);g.bezierCurveTo(x0-40,-Rn,x0-40,-Rn+40,x0,-Rn+30);g.lineTo(x0+L*.62,-Rn+60);g.lineTo(x0+L*.62,-Rn+30);g.lineTo(x0+10,-Rn-12);g.closePath();g.fill();
g.save();g.scale(1,-1);g.beginPath();g.moveTo(x0,-Rn);g.bezierCurveTo(x0-40,-Rn,x0-40,-Rn+40,x0,-Rn+30);g.lineTo(x0+L*.62,-Rn+60);g.lineTo(x0+L*.62,-Rn+30);g.lineTo(x0+10,-Rn-12);g.closePath();g.fill();g.restore();
/* core casing */var cx0=x0+L*.2,cx1=x0+L*.9;g.fillStyle=rgba([52,72,102],1);g.beginPath();g.moveTo(cx0,-110);g.lineTo(x0+L*.5,-78);g.lineTo(x0+L*.68,-82);g.lineTo(cx1,-60);g.lineTo(cx1,60);g.lineTo(x0+L*.68,82);g.lineTo(x0+L*.5,78);g.lineTo(cx0,110);g.closePath();g.fill();
/* shaft */g.fillStyle=rgba([90,108,134],1);g.fillRect(x0+40,-12,L*.86,24);
/* spinner */g.fillStyle=rgba([210,218,230],1);g.beginPath();g.moveTo(x0-30,0);g.quadraticCurveTo(x0+10,-60,x0+60,-62);g.lineTo(x0+60,62);g.quadraticCurveTo(x0+10,60,x0-30,0);g.fill();
/* fan: 24 blades seen edge-on, their tips sweep up and down as they turn */var rot=t*9;for(var b=0;b<24;b++){var ph=rot+b/24*6.283;var yy=Math.sin(ph)*(Rn-34);var zz=Math.cos(ph);g.fillStyle=rgba(mix([120,140,170],WHITE,(zz+1)/2),1);g.fillRect(x0+70-6*zz,Math.min(0,yy),14,Math.abs(yy)||1);ELEMENTS++}
/* compressor: 14 stages, blade rows shrink as the air is squeezed */for(var st=0;st<14;st++){var sx=x0+L*.24+st*L*.018;var hR=104-st*4.6;var n=16;for(var b=0;b<n;b++){var ph=t*(14+st)+b/n*6.283+st;var yy=Math.sin(ph)*hR;g.fillStyle=rgba(mix([150,170,200],WHITE,(Math.cos(ph)+1)/2),1);g.fillRect(sx,yy-4,8,8);ELEMENTS++}g.fillStyle=rgba([150,170,200],.35);g.fillRect(sx+2,-hR,4,hR*2)}
/* combustor */var bx=x0+L*.52,bw=L*.14;g.fillStyle=rgba([70,40,30],1);g.fillRect(bx,-74,bw,40);g.fillRect(bx,34,bw,40);
for(var i=0;i<FL.length;i++){var f=FL[i];var life=(f[0]+t*1.6)%1;var fx=bx+life*bw,fy=(f[1]>0?54:-54)+(f[2]-.5)*30*(1-life);var col=mix([255,230,120],ORANGE,life);g.fillStyle=rgba(col,.85*(1-life));g.beginPath();g.arc(fx,fy,4+8*(1-life),0,6.283);g.fill();ELEMENTS++}
/* turbine: 5 stages */for(var st=0;st<5;st++){var sx=x0+L*.69+st*L*.03;var hR=70+st*6;for(var b=0;b<16;b++){var ph=t*20+b/16*6.283+st;var yy=Math.sin(ph)*hR;g.fillStyle=rgba(mix([200,120,80],[255,210,170],(Math.cos(ph)+1)/2),1);g.fillRect(sx,yy-4,9,8);ELEMENTS++}}
/* bypass air: cool, fast, around the core */for(var i=0;i<BYP.length;i++){var p=BYP[i];var u=(p[0]+t*.55)%1;var x=x0-120+u*(L*.9);var side=i%2?1:-1;var rr=lerp(150,236,p[1]);if(x>x0+L*.62)rr=lerp(rr,120+p[1]*60,cl((x-x0-L*.62)/(L*.3)));g.strokeStyle=rgba(CYAN,.55);g.lineWidth=2.5;g.beginPath();g.moveTo(x-18,side*rr);g.lineTo(x,side*rr);g.stroke();ELEMENTS++}
/* core air: squeezed, burnt, expanded (cyan to orange to red) */for(var i=0;i<CORE.length;i++){var p=CORE[i];var u=(p[0]+t*.42)%1;var x=x0+L*.2+u*L*.9;var squeeze=x<x0+L*.5?lerp(100,40,(x-x0-L*.2)/(L*.3)):lerp(40,70,cl((x-x0-L*.5)/(L*.4)));var y=p[1]*squeeze;var hot=cl((x-x0-L*.5)/(L*.12));var col=mix(CYAN,mix(ORANGE,[255,80,60],cl((x-x0-L*.7)/(L*.2))),hot);g.fillStyle=rgba(col,.9);g.fillRect(x,y-2,5+hot*6,4);ELEMENTS++}
g.restore();ELEMENTS+=12}

/* ---------- captions (DOM), driven by the seek ---------- */
var CAP=[].slice.call(document.querySelectorAll('[data-in]'));
function captions(t){CAP.forEach(function(el){var a=+el.dataset.in,b=+el.dataset.out;var o=Math.min(seg(t,a,a+.45),1-seg(t,b-.35,b));el.style.opacity=o.toFixed(3);el.style.transform='translateY('+((1-eo(seg(t,a,a+.6)))*34).toFixed(1)+'px)'})
var n=document.getElementById('n400');if(n)n.textContent=Math.round(400*eo(seg(t,1.2,3))).toString();
var k=document.getElementById('nkg');if(k)k.textContent=Math.round(800*eo(seg(t,19.2,21))).toString();}

var draw=function(t){ELEMENTS=0;g.setTransform(1,0,0,1,0,0);
/* Act 1 (0-5): the plane above the clouds */
if(t<5.6){sky(t,1);clouds(t,1,0,1);var px=lerp(-420,560,eo(seg(t,0,3.2)))+Math.max(0,t-3.2)*30,py=1060+Math.sin(t*1.3)*10;plane(px,py,lerp(1.5,1.2,eo(seg(t,0,4))),-.03,t);clouds(t+40,1.6,260,.9)}
/* iris into the wing (4.6-5.8) */
var iris=seg(t,4.6,5.8);
if(t>=4.6&&t<12.6){var CX=540,CY=1030,C=760;var a=.04;
g.save();if(iris<1){g.beginPath();g.arc(440,1070,eio(iris)*1300,0,6.283);g.clip()}
g.fillStyle=rgba(INK,1);g.fillRect(0,0,W,H);
var pa=seg(t,8.6,9.6);pressure(CX,CY,C,a,pa);
stream(t,CX,CY,C,a,1,seg(t,7,8));
airfoilPath(CX,CY,C,a);g.fillStyle=rgba(WHITE,1);g.fill();ELEMENTS++;
arrow(CX-40,CY-20,eo(seg(t,10.4,11.6))*420,0,ORANGE,22,seg(t,10.4,10.8));
g.restore()}
/* Act 3 (12-17.6): angle of attack and downwash */
if(t>=12&&t<18.2){var CX=540,CY=1030,C=760;var a=lerp(.04,.2,eio(seg(t,12.4,14.4)));g.fillStyle=rgba(INK,1);g.fillRect(0,0,W,H);
pressure(CX,CY,C,a,1-seg(t,17.4,18.2));stream(t,CX,CY,C,a,1,1);airfoilPath(CX,CY,C,a);g.fillStyle=rgba(WHITE,1);g.fill();ELEMENTS++;
arrow(CX-40,CY-30,420+eo(seg(t,13,15))*160,0,ORANGE,22,1-seg(t,17.4,18));
arrow(CX+330,CY+120,eo(seg(t,14.6,15.8))*360,Math.PI,CYAN,18,seg(t,14.6,15)*(1-seg(t,17.4,18)));
if(t<12.6){g.globalAlpha=1-seg(t,12,12.6);g.globalAlpha=1}}
/* Act 4 (17.6-23.8): the engine */
if(t>=17.6&&t<24.4){var ea=seg(t,17.6,18.4)*(1-seg(t,23.8,24.4));g.fillStyle=rgba(INK,1);g.fillRect(0,0,W,H);
for(var i=0;i<60;i++){g.fillStyle=rgba(WHITE,.05);g.fillRect(0,i*34,W,1)}
var L=1000;g.save();g.translate(540,1060);g.scale(lerp(.9,1.04,eo(seg(t,17.6,23.8))),lerp(.9,1.04,eo(seg(t,17.6,23.8))));engine(t,0,0,L,ea);g.restore()}
/* Act 5 (23.8-28): climb-out and the facts */
if(t>=23.8){sky(t,1);clouds(t,1.2,lerp(0,260,eo(seg(t,23.8,28))),1);var cl2=eo(seg(t,23.8,27.5));plane(lerp(360,640,cl2),lerp(1420,1180,cl2),lerp(.78,.7,cl2),-.16,t);
for(var i=0;i<4;i++){for(var k=0;k<90;k++){var f=k/90;g.fillStyle=rgba(WHITE,.2*(1-f));var tx=lerp(360,640,cl2)-130-f*900*cl2-i*8,ty=lerp(1420,1180,cl2)+70+f*900*cl2*.3+i*10;g.beginPath();g.arc(tx,ty,4+f*16,0,6.283);g.fill();ELEMENTS++}}
var fade=1-seg(t,23.8,24.4);if(fade>0){g.fillStyle=rgba(INK,fade);g.fillRect(0,0,W,H)}}
captions(t);window.__rfElements=ELEMENTS};
`;

const CSS = `
.cap{position:absolute;left:84px;right:84px;opacity:0;color:#F4F6FA;font-family:"Inter Display",Inter,sans-serif;letter-spacing:-.02em;text-align:center}
.cap.top{top:250px}.cap.mid{top:420px}.cap.low{top:1500px}
.cap .k{font-size:34px;font-weight:500;color:#9FB3CC;letter-spacing:0;margin-bottom:22px;font-family:"JetBrains Mono","DejaVu Sans Mono",monospace}
.cap h2{margin:0;font-size:84px;line-height:1.02;font-weight:600}
.cap p{margin:0;font-size:56px;line-height:1.16;font-weight:500}
.cap b{color:#FF7A28;font-weight:600}.cap i{font-style:normal;color:#7ED6FF}
.big{font-size:210px!important;line-height:.9!important;font-weight:600;color:#FF7A28;letter-spacing:-.05em}
.lbl{position:absolute;opacity:0;font:500 34px/1 "JetBrains Mono","DejaVu Sans Mono",monospace;color:#F4F6FA;padding:10px 16px;border-radius:10px;background:rgba(11,22,38,.72);border:2px solid rgba(244,246,250,.22)}
.facts{position:absolute;left:84px;right:84px;top:300px;display:grid;gap:22px}
.fact{opacity:0;display:flex;justify-content:space-between;align-items:baseline;padding:26px 34px;border-radius:24px;background:rgba(11,22,38,.62);border:2px solid rgba(244,246,250,.16);color:#F4F6FA;font-family:"Inter Display",Inter,sans-serif}
.fact span{font-size:40px;color:#C9D4E3}.fact strong{font-size:64px;font-weight:600;letter-spacing:-.03em}
.brand{position:absolute;left:0;right:0;top:900px;text-align:center;opacity:0;font:500 32px/1 "JetBrains Mono","DejaVu Sans Mono",monospace;color:#C9D4E3}
`;

const HTML = `
<div class="cap top" data-in="0.4" data-out="4.6"><div class="k">A fully loaded 747 weighs about</div><h2 class="big"><span id="n400">0</span> t</h2></div>
<div class="cap" style="top:640px" data-in="2.9" data-out="4.7"><p>So how does it <b>stay in the air?</b></p></div>
<div class="cap top" data-in="5.9" data-out="7.4"><div class="k">A slice through the wing</div><h2>Watch the air</h2></div>
<div class="cap top" data-in="7.4" data-out="9.1"><p>Air over the curved top<br>travels <i>faster</i></p></div>
<div class="cap top" data-in="9.1" data-out="10.6"><p>Faster air, <i>lower pressure</i>.<br>Below, pressure stays <b>high</b></p></div>
<div class="cap top" data-in="10.6" data-out="12.3"><p>High below, low above:<br>the wing is pushed up. <b>Lift.</b></p></div>
<div class="cap top" data-in="12.6" data-out="14.6"><p>Now tilt the wing<br>a few degrees</p></div>
<div class="cap top" data-in="14.6" data-out="17.5"><p>It throws air <i>down</i>,<br>so the plane goes <b>up</b></p><div class="k" style="margin-top:22px">Newton's third law</div></div>
<div class="cap top" data-in="18" data-out="20.6"><div class="k">Each engine swallows about</div><h2 class="big" style="font-size:180px!important"><span id="nkg">0</span> kg</h2><p style="margin-top:14px">of air every second</p></div>
<div class="cap top" data-in="20.6" data-out="23.6"><p><i>Squeeze</i> it, <b>burn</b> it,<br>blast it out the back</p></div>
<div class="lbl" style="left:40px;top:1440px" data-in="19" data-out="23.6">Fan</div>
<div class="lbl" style="left:250px;top:1520px" data-in="19.6" data-out="23.6">Compressor</div>
<div class="lbl" style="left:520px;top:1440px" data-in="20.2" data-out="23.6">Combustor</div>
<div class="lbl" style="left:770px;top:1520px" data-in="20.8" data-out="23.6">Turbine</div>
<div class="facts">
 <div class="fact" data-in="24.6" data-out="28.4"><span>Weight</span><strong>≈ 400 t</strong></div>
 <div class="fact" data-in="25.1" data-out="28.4"><span>Wingspan</span><strong>≈ 64 m</strong></div>
 <div class="fact" data-in="25.6" data-out="28.4"><span>Take-off</span><strong>≈ 300 km/h</strong></div>
 <div class="fact" data-in="26.1" data-out="28.4"><span>Lift</span><strong style="color:#FF7A28">≥ weight</strong></div>
</div>
<div class="brand" data-in="26.6" data-out="28.4">Rendered with ReelForge</div>
`;

export const PLANE: FlagshipReel = {
  slug: 'how-a-plane-flies',
  title: 'How does a 400-tonne plane fly?',
  category: 'How it works',
  tags: ['science', 'aviation', 'explainer', 'physics'],
  description: 'Lift, angle of attack and a jet engine cutaway, with 1,400 air particles in the stream.',
  prompt:
    'Make a 28-second vertical explainer: how a fully loaded 747 (about 400 tonnes) stays in the air. Hook with the plane above the clouds, then a slice of the wing in a stream of air showing faster flow and lower pressure on top and lift, then the angle of attack throwing air down (Newton), then a cutaway of a turbofan (fan, compressor, combustor, turbine) and finish with the plane climbing and four facts.',
  duration: DUR,
  music: 'ambient',
  html: composition(DUR, HTML, CSS, SCRIPT),
};
