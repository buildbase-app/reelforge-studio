/**
 * Flagship reel: "Your heart never takes a day off". One HyperFrames
 * composition, 30 s, drawn on a canvas by a pure function of time (seeked by
 * the runtime through window.__hfAnime). Six acts: the hook (a beating heart
 * pushing cells out and pulling them back in), a cutaway of the four chambers
 * through one slowed-down cardiac cycle (atria, then ventricles, valves in
 * sync), lap one through the lungs (blue cells turn red), lap two through the
 * body (a branching arterial and venous tree), a capillary where cells pass in
 * single file and hand over oxygen, and the payoff facts around the Earth.
 * An ECG trace runs under the first four acts, locked to the same beat clock
 * that drives the valves and the flow.
 *
 * Facts used (general, well known; stated with "about"): a resting heart beats
 * about 100,000 times a day and pumps about 7,000 litres a day; about
 * 2.5 billion beats in a lifetime; the blood vessels of an adult laid end to
 * end run to about 100,000 km, about two and a half times around the Earth.
 * The cutaway is shown three times slower than a 72 bpm beat (0.83 s).
 */
import { composition, type FlagshipReel } from './kit';

const DUR = 30;

const SCRIPT = String.raw`
var cv=document.getElementById('cv'),g=cv.getContext('2d'),W=1080,H=1920;
var sd=1628;function R(){sd=(sd+0x6d2b79f5)>>>0;var t=sd;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296}
function cl(x){return x<0?0:x>1?1:x}
function seg(t,a,b){return cl((t-a)/(b-a))}
function eo(x){x=cl(x);return 1-Math.pow(1-x,3)}
function eio(x){x=cl(x);return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2}
function sm(x){x=cl(x);return x*x*(3-2*x)}
function lerp(a,b,f){return a+(b-a)*f}
function rgba(c,a){return 'rgba('+c[0]+','+c[1]+','+c[2]+','+a+')'}
function mix(c1,c2,f){return [Math.round(lerp(c1[0],c2[0],f)),Math.round(lerp(c1[1],c2[1],f)),Math.round(lerp(c1[2],c2[2],f))]}
var BG=[14,11,28],BG2=[26,19,48],RED=[238,74,82],RED2=[186,38,60],BLU=[108,140,244],BLU2=[68,94,204],AMB=[255,204,112],CREAM=[252,234,222],WHITE=[246,240,244];
var MUS=[204,78,96],MUSD=[146,42,72],MUSL=[234,124,132],ART=[214,72,88],ARTD=[150,40,64],VEN=[84,104,198],VEND=[52,62,140];
var LUMR=[30,26,62],LUML=[58,20,46];
var ELEMENTS=0;

/* ---------- the beat clock: 72 bpm, three times slower during the cutaway ---------- */
var P1=.83,P2=2.5,C0=5,C1=13.4;
function BT(t){return Math.min(t,C0)/P1+cl((t-C0)/(C1-C0))*(C1-C0)/P2+Math.max(0,t-C1)/P1}
function fr(b){return b-Math.floor(b)}
/* cycle phase f in [0,1): 0-.15 atrial systole, .17-.5 ventricular systole, then both relax */
function aAV(f){return .4*eio(seg(f,0,.15))+.6*eio(seg(f,.55,1))}
function aOUT(f){return eio(seg(f,.2,.45))}
function DAV(b){return Math.floor(b)+aAV(fr(b))}
function DOUT(b){return Math.floor(b)+aOUT(fr(b))}
function sqA(f){return eio(seg(f,0,.07))*(1-eio(seg(f,.08,.24)))}
function sqV(f){return eio(seg(f,.17,.3))*(1-eio(seg(f,.42,.62)))}
function oAV(f){return f<.15?1:f<.19?1-eio(seg(f,.15,.19)):f<.55?0:eio(seg(f,.55,.62))}
function oSL(f){return f<.2?0:f<.25?eio(seg(f,.2,.25)):f<.44?1:f<.49?1-eio(seg(f,.44,.49)):0}
function ecgV(f){function gs(c,w,a){var d=(f-c)/w;return a*Math.exp(-d*d)}return gs(.03,.025,.16)+gs(.15,.012,-.12)+gs(.175,.013,1)+gs(.2,.012,-.28)+gs(.4,.045,.3)}

/* ---------- geometry helpers ---------- */
function chaikin(p,it){for(var k=0;k<it;k++){var q=[p[0]];for(var i=0;i<p.length-1;i++){var a=p[i],b=p[i+1],u=[],v=[];for(var j=0;j<a.length;j++){u.push(a[j]*.75+b[j]*.25);v.push(a[j]*.25+b[j]*.75)}q.push(u,v)}q.push(p[p.length-1]);p=q}return p}
function mkPath(p){var L=[0];for(var i=1;i<p.length;i++)L.push(L[i-1]+Math.hypot(p[i][0]-p[i-1][0],p[i][1]-p[i-1][1]));return{p:p,L:L,len:L[L.length-1]}}
var AT=[0,0,0,0];
function at(P,s){var L=P.L,p=P.p,lo=0,hi=L.length-1;if(s<=0)s=0;if(s>=P.len)s=P.len-.001;while(hi-lo>1){var m=(lo+hi)>>1;if(L[m]<=s)lo=m;else hi=m}var a=p[lo],b=p[hi],f=(s-L[lo])/((L[hi]-L[lo])||1);AT[0]=lerp(a[0],b[0],f);AT[1]=lerp(a[1],b[1],f);AT[2]=a.length>2?lerp(a[2],b[2],f):0;AT[3]=Math.atan2(b[1]-a[1],b[0]-a[0]);return AT}
function blob(pts,ox,oy,s){var n=pts.length;function P(i){var p=pts[(i+n)%n];return[ox+(p[0]-ox)*s,oy+(p[1]-oy)*s]}g.beginPath();var a=P(n-1),b=P(0);g.moveTo((a[0]+b[0])/2,(a[1]+b[1])/2);for(var i=0;i<n;i++){var p=P(i),q=P(i+1);g.quadraticCurveTo(p[0],p[1],(p[0]+q[0])/2,(p[1]+q[1])/2)}g.closePath()}
function line(P){g.beginPath();for(var i=0;i<P.length;i++){i?g.lineTo(P[i][0],P[i][1]):g.moveTo(P[i][0],P[i][1])}}
function rr(x,y,w,h,r){g.beginPath();g.moveTo(x+r,y);g.arcTo(x+w,y,x+w,y+h,r);g.arcTo(x+w,y+h,x,y+h,r);g.arcTo(x,y+h,x,y,r);g.arcTo(x,y,x+w,y,r);g.closePath()}
function inPoly(x,y,P){var c=false;for(var i=0,j=P.length-1;i<P.length;j=i++){if(((P[i][1]>y)!=(P[j][1]>y))&&(x<(P[j][0]-P[i][0])*(y-P[i][1])/(P[j][1]-P[i][1])+P[i][0]))c=!c}return c}

/* ---------- blood cells, batched by colour (0 = blue, 1 = red) ---------- */
var NB=9,BK=[];for(var i=0;i<NB;i++)BK.push([]);
var CF=[],CD=[];for(var i=0;i<NB;i++){CF.push(rgba(mix(BLU,RED,i/(NB-1)),1));CD.push(rgba(mix(BLU2,RED2,i/(NB-1)),1))}
function cell(x,y,r,f){if(r<.6)return;BK[Math.round(cl(f)*(NB-1))].push(x,y,r);ELEMENTS++}
function flush(alpha){g.globalAlpha=alpha===undefined?1:alpha;for(var b=0;b<NB;b++){var a=BK[b];if(!a.length)continue;
g.fillStyle=CF[b];g.beginPath();for(var i=0;i<a.length;i+=3){g.moveTo(a[i]+a[i+2],a[i+1]);g.arc(a[i],a[i+1],a[i+2],0,6.283)}g.fill();
g.fillStyle=CD[b];g.beginPath();for(var i=0;i<a.length;i+=3){var r=a[i+2]*.48,x=a[i]+a[i+2]*.1,y=a[i+1]+a[i+2]*.12;g.moveTo(x+r,y);g.arc(x,y,r,0,6.283)}g.fill();
BK[b]=[]}g.globalAlpha=1}

/* ---------- background ---------- */
function bg(c1,c2){var gr=g.createLinearGradient(0,0,0,H);gr.addColorStop(0,rgba(c1,1));gr.addColorStop(1,rgba(c2,1));g.fillStyle=gr;g.fillRect(0,0,W,H)}

/* ---------- ECG strip, locked to the beat clock ---------- */
var EBIN=12;
function ecg(B,alpha){if(alpha<=0)return;g.save();g.globalAlpha=alpha;
g.fillStyle=rgba([9,7,20],.82);rr(56,1688,968,176,30);g.fill();ELEMENTS++;
g.strokeStyle=rgba(WHITE,.06);g.lineWidth=2;g.beginPath();for(var i=0;i<23;i++){var x=100+i*40;g.moveTo(x,1708);g.lineTo(x,1846);ELEMENTS++}for(var j=0;j<4;j++){g.moveTo(84,1716+j*40);g.lineTo(996,1716+j*40);ELEMENTS++}g.stroke();
var N=300,x0=96,x1=984,y0=1806,amp=84,pts=[];for(var i=0;i<=N;i++){var b=B-(1-i/N)*2.2;pts.push([lerp(x0,x1,i/N),y0-amp*ecgV(fr(b))])}
g.lineWidth=5;g.lineCap='butt';g.lineJoin='round';for(var k=0;k<EBIN;k++){var a0=Math.floor(k*N/EBIN),a1=Math.floor((k+1)*N/EBIN);g.strokeStyle=rgba(AMB,.12+.88*Math.pow((k+1)/EBIN,1.6));g.beginPath();g.moveTo(pts[a0][0],pts[a0][1]);for(var i=a0+1;i<=a1;i++){g.lineTo(pts[i][0],pts[i][1]);ELEMENTS++}g.stroke()}
var e=pts[N];g.fillStyle=rgba(AMB,1);g.beginPath();g.arc(e[0],e[1],9,0,6.283);g.fill();ELEMENTS++;g.restore()}

/* ---------- the heart: local units, origin mid-heart, apex down and to the right ---------- */
function ccw(P){var a=0;for(var i=0,j=P.length-1;i<P.length;j=i++)a+=(P[j][0]-P[i][0])*(P[j][1]+P[i][1]);return a<0?P.slice().reverse():P}
var SIL=ccw([[-250,-215],[-110,-252],[40,-236],[190,-256],[320,-172],[354,-10],[314,180],[222,352],[104,468],[24,452],[-120,362],[-250,232],[-314,62],[-320,-92]]);
var RA=ccw([[-292,-152],[-200,-196],[-122,-146],[-104,-30],[-132,58],[-235,64],[-294,-30]]);
var RV=ccw([[-224,96],[-122,72],[-88,-30],[-80,-108],[-8,-108],[-4,40],[-2,120],[-28,262],[-88,352],[-168,282],[-226,184]]);
var LA=ccw([[100,-194],[194,-216],[292,-162],[302,-62],[246,26],[122,26],[98,-60]]);
var LV=ccw([[12,-108],[76,-108],[86,4],[200,42],[290,112],[272,252],[192,372],[112,420],[50,360],[16,200]]);
function sm3(p){return chaikin(p,3)}
var FIB=[];for(var i=0;i<16;i++){var u=i/15;FIB.push([lerp(-300,300,u),lerp(-120,-240,Math.abs(u-.5)*2)+R()*20,lerp(-200,180,u)+R()*30,lerp(150,60,u),lerp(-40,150,u)+R()*20,lerp(330,470,1-Math.abs(u-.6))])}
var V_SVC=sm3([[-200,-540],[-198,-330],[-194,-150]]),V_IVC=sm3([[-262,600],[-264,380],[-250,190]]);
var V_PV1=sm3([[520,-160],[380,-150],[250,-120]]),V_PV2=sm3([[520,-40],[380,-46],[250,-70]]);
var V_AO=sm3([[42,-104],[40,-300],[62,-405],[160,-452],[252,-412],[284,-300],[284,-130]]);
var V_AOF=V_AO.slice(0,10),V_AOD=V_AO.slice(V_AO.length-16);
var V_AOB=[sm3([[92,-425],[76,-580]]),sm3([[160,-448],[162,-594]]),sm3([[226,-428],[252,-570]])];
var V_PAR=sm3([[-40,-104],[-40,-210],[-100,-282],[-156,-306]]),V_PAL=sm3([[-40,-104],[-40,-210],[40,-264],[186,-290]]);
var COR=[sm3([[-14,-206],[6,-60],[40,110],[72,300],[100,452]]),sm3([[18,10],[110,60],[200,150]]),sm3([[48,190],[150,262],[224,300]]),sm3([[-96,-198],[-210,-70],[-262,120],[-160,320],[-10,440]]),sm3([[-210,10],[-130,80],[-60,170]])];
var CORV=[sm3([[-50,-150],[-70,60],[-46,300]]),sm3([[120,-200],[160,-60],[250,60]])];
function endCap(P,w,col,startEnd){var n=P.length,a=startEnd?P[0]:P[n-1],b=startEnd?P[1]:P[n-2];var ang=Math.atan2(a[1]-b[1],a[0]-b[0]);g.fillStyle=rgba(col,1);g.beginPath();g.ellipse(a[0],a[1],w*.18,w*.5,ang,0,6.283);g.fill();ELEMENTS++}
function tubeExt(P,w,col,dark,capEnd,capStart){g.lineCap='butt';g.lineJoin='round';g.strokeStyle=rgba(dark,1);g.lineWidth=w+8;line(P);g.stroke();g.strokeStyle=rgba(col,1);g.lineWidth=w;line(P);g.stroke();
g.save();g.translate(-w*.14,-w*.14);g.strokeStyle=rgba(mix(col,WHITE,.35),.55);g.lineWidth=w*.2;line(P);g.stroke();g.restore();ELEMENTS+=3;
if(capEnd)endCap(P,w,mix(dark,[0,0,0],.3),false);if(capStart)endCap(P,w,mix(dark,[0,0,0],.3),true)}
function shadeSil(s){g.save();g.translate(0,80);g.scale(s,s);g.translate(0,-80);blob(SIL,0,0,1);g.fillStyle=rgba(MUSD,1);g.fill();g.clip();blob(SIL,-26,-30,.95);g.fillStyle=rgba(MUS,1);g.fill();
g.strokeStyle=rgba(MUSL,.16);g.lineWidth=4;g.lineCap='round';for(var i=0;i<FIB.length;i++){var f=FIB[i];g.beginPath();g.moveTo(f[0],f[1]);g.quadraticCurveTo(f[2],f[3],f[4],f[5]);g.stroke();ELEMENTS++}
g.fillStyle=rgba(MUSL,.5);g.beginPath();g.ellipse(-150,-120,120,56,-.6,0,6.283);g.fill();g.restore();ELEMENTS+=3}
/* outside view */
function heartExt(th){g.save();
tubeExt(V_IVC,70,VEN,VEND,true);tubeExt(V_PV1,48,ART,ARTD,true);tubeExt(V_PV2,48,ART,ARTD,true);tubeExt(V_AOD,78,ART,ARTD,true);
shadeSil(1+.04*th);
g.save();g.translate(0,80);g.scale(1+.04*th,1+.04*th);g.translate(0,-80);
g.lineCap='round';for(var i=0;i<CORV.length;i++){g.strokeStyle=rgba(VEN,.9);g.lineWidth=7;line(CORV[i]);g.stroke();ELEMENTS++}
for(var i=0;i<COR.length;i++){g.strokeStyle=rgba([246,150,120],1);g.lineWidth=i===0||i===3?11:7;line(COR[i]);g.stroke();ELEMENTS++}
g.restore();
tubeExt(V_SVC,72,VEN,VEND,false,true);
for(var i=0;i<3;i++)tubeExt(V_AOB[i],34,ART,ARTD,true);tubeExt(V_AO,78,ART,ARTD,false);
tubeExt(V_PAR,58,VEN,VEND,true);tubeExt(V_PAL,58,VEN,VEND,true);
g.restore()}
/* the cut-open view: lumens are clipped so no cell ever sits on muscle */
function tpoly(P,w){var A=[],Bq=[];for(var i=0;i<P.length;i++){var a=P[Math.max(0,i-1)],b=P[Math.min(P.length-1,i+1)];var an=Math.atan2(b[1]-a[1],b[0]-a[0]);var nx=-Math.sin(an)*w/2,ny=Math.cos(an)*w/2;A.push([P[i][0]+nx,P[i][1]+ny]);Bq.push([P[i][0]-nx,P[i][1]-ny])}return ccw(A.concat(Bq.reverse()))}
function addPoly(Q){g.moveTo(Q[0][0],Q[0][1]);for(var i=1;i<Q.length;i++)g.lineTo(Q[i][0],Q[i][1]);g.closePath()}
function addBlob(pts,ox,oy,s){var n=pts.length;function P(i){var p=pts[(i+n)%n];return[ox+(p[0]-ox)*s,oy+(p[1]-oy)*s]}var a=P(n-1),b=P(0);g.moveTo((a[0]+b[0])/2,(a[1]+b[1])/2);for(var i=0;i<n;i++){var p=P(i),q=P(i+1);g.quadraticCurveTo(p[0],p[1],(p[0]+q[0])/2,(p[1]+q[1])/2)}g.closePath()}
var TP={svc:tpoly(V_SVC,50),ivc:tpoly(V_IVC,50),pv1:tpoly(V_PV1,38),pv2:tpoly(V_PV2,38),ao:tpoly(V_AO,52),par:tpoly(V_PAR,46),pal:tpoly(V_PAL,46)};
var CH=[{pts:RA,o:[-170,60],f:0,a:1},{pts:RV,o:[-110,20],f:0,a:0},{pts:LA,o:[170,24],f:1,a:1},{pts:LV,o:[80,0],f:1,a:0}];
for(var i=0;i<CH.length;i++){var C=CH[i];C.pool=[];var x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;C.pts.forEach(function(p){x0=Math.min(x0,p[0]);x1=Math.max(x1,p[0]);y0=Math.min(y0,p[1]);y1=Math.max(y1,p[1])});
var tries=0;while(C.pool.length<(C.a?70:110)&&tries<5000){tries++;var x=lerp(x0,x1,R()),y=lerp(y0,y1,R());if(inPoly(x,y,C.pts)&&inPoly(lerp(x,C.o[0],.12)+(x-C.o[0])*.0,y,C.pts))C.pool.push([x,y,R()*6.283,.8+R()*.35])}}
var SEGS=[
{p:[[-200,-560,46],[-198,-330,46],[-190,-150,60],[-185,-60,90]],law:0,f:0,n:52},
{p:[[-262,620,46],[-264,380,46],[-252,190,50],[-210,20,90]],law:0,f:0,n:52},
{p:[[-190,-60,110],[-176,30,90],[-170,70,60],[-150,160,120],[-118,262,100],[-96,322,60]],law:1,f:0,n:80},
{p:[[-96,316,70],[-56,200,80],[-40,60,56],[-40,-104,50],[-40,-210,44],[-100,-282,40],[-160,-308,38]],law:2,f:0,n:110,front:1},
{p:[[-40,40,56],[-40,-104,50],[-40,-210,44],[40,-264,40],[196,-292,38]],law:2,f:0,n:80,front:1},
{p:[[540,-160,34],[380,-150,36],[250,-120,60],[190,-100,100]],law:0,f:1,n:48},
{p:[[540,-40,34],[380,-46,36],[250,-70,60],[190,-88,90]],law:0,f:1,n:48},
{p:[[186,-96,110],[172,-6,92],[168,30,60],[164,150,130],[170,290,120],[134,376,60]],law:1,f:1,n:90},
{p:[[140,368,70],[82,250,90],[46,100,60],[42,-104,50],[40,-300,50],[62,-405,50],[160,-452,50],[252,-412,50],[284,-300,50],[284,-120,50]],law:2,f:1,n:190}];
for(var i=0;i<SEGS.length;i++){var S=SEGS[i];S.P=mkPath(chaikin(S.p,3));S.c=[];for(var k=0;k<S.n;k++)S.c.push([(k+R()*.7)/S.n,R()*2-1,.82+R()*.3])}
var STRIDE=[.32,.55,.5];
function segCells(S,B){var D=S.law===0?B:S.law===1?DAV(B):DOUT(B);var len=S.P.len,st=STRIDE[S.law]*len;
for(var k=0;k<S.c.length;k++){var c=S.c[k];var s=((c[0]*len+D*st)%len+len)%len;var p=at(S.P,s);var nx=-Math.sin(p[3]),ny=Math.cos(p[3]);var o=c[1]*p[2]*.4;var r=9.5*c[2]*sm(s/40)*sm((len-s)/40);cell(p[0]+nx*o,p[1]+ny*o,r,S.f)}}
function poolCells(C,s,B){var w=B*6.283*.5;for(var i=0;i<C.pool.length;i++){var p=C.pool[i];var x=C.o[0]+(p[0]-C.o[0])*s+Math.cos(w*.4+p[2])*5,y=C.o[1]+(p[1]-C.o[1])*s+Math.sin(w*.3+p[2]*1.3)*5;cell(x,y,9*p[3],C.f)}}
var VALVES=[[-234,66,-120,72,0,1],[104,26,240,30,0,1],[-76,-104,-4,-104,0,-1],[14,-104,74,-104,0,-1]];
function valve(v,o){var hx=[v[0],v[2]],hy=[v[1],v[3]];var span=Math.hypot(v[2]-v[0],v[3]-v[1]);g.strokeStyle=rgba(CREAM,1);g.lineWidth=13;g.lineCap='round';
for(var s=0;s<2;s++){var a0=Math.atan2(hy[1-s]-hy[s],hx[1-s]-hx[s]);var best=null;for(var sg=-1;sg<=1;sg+=2){var a=a0+sg*o*1.35;var tx=Math.cos(a),ty=Math.sin(a);if(!best||tx*v[4]+ty*v[5]>best[2])best=[tx,ty,tx*v[4]+ty*v[5]]}
var L=span*.5-3;g.beginPath();g.moveTo(hx[s],hy[s]);g.quadraticCurveTo(hx[s]+best[0]*L*.6+v[4]*6,hy[s]+best[1]*L*.6+v[5]*6,hx[s]+best[0]*L,hy[s]+best[1]*L);g.stroke();ELEMENTS++}
g.fillStyle=rgba(MUSD,1);for(var s=0;s<2;s++){g.beginPath();g.arc(hx[s],hy[s],14,0,6.283);g.fill();ELEMENTS++}}
function tubeCut(P,w,lum){g.lineCap='butt';g.lineJoin='round';g.strokeStyle=rgba(lum,1);g.lineWidth=w;line(P);g.stroke();ELEMENTS++}
function tubeWall(P,w,col){g.lineCap='butt';g.lineJoin='round';g.strokeStyle=rgba(col,1);g.lineWidth=w+24;line(P);g.stroke();g.strokeStyle=rgba(mix(col,WHITE,.22),1);g.lineWidth=w+9;line(P);g.stroke();ELEMENTS+=2}
function chamber(pts,ox,oy,s,lum){blob(pts,ox,oy,s);g.fillStyle=rgba(lum,1);g.fill();g.strokeStyle=rgba(MUSL,.5);g.lineWidth=7;g.stroke();ELEMENTS++}
function heartCut(B){var f=fr(B),sa=sqA(f),sv=sqV(f);var S=[1-.13*sa,1-.12*sv,1-.13*sa,1-.12*sv];
tubeWall(V_PV1,38,ARTD);tubeWall(V_PV2,38,ARTD);tubeWall(V_IVC,50,VEND);tubeWall(V_SVC,50,VEND);tubeWall(V_AOD,52,ARTD);
shadeSil(1-.025*sv);tubeWall(V_AO,52,ARTD);for(var i=0;i<3;i++)tubeExt(V_AOB[i],30,ART,ARTD,true);
tubeCut(V_PV1,38,LUML);tubeCut(V_PV2,38,LUML);tubeCut(V_IVC,50,LUMR);tubeCut(V_SVC,50,LUMR);
for(var i=0;i<4;i++)chamber(CH[i].pts,CH[i].o[0],CH[i].o[1],S[i],CH[i].f?LUML:LUMR);
tubeCut(V_AO,52,LUML);
g.save();g.beginPath();addPoly(TP.svc);addPoly(TP.ivc);addPoly(TP.pv1);addPoly(TP.pv2);addPoly(TP.ao);for(var i=0;i<4;i++)addBlob(CH[i].pts,CH[i].o[0],CH[i].o[1],S[i]);g.clip();
for(var i=0;i<4;i++)poolCells(CH[i],S[i],B);for(var i=0;i<SEGS.length;i++)if(!SEGS[i].front)segCells(SEGS[i],B);flush();g.restore();
tubeWall(V_PAR,46,VEND);tubeWall(V_PAL,46,VEND);tubeCut(V_PAR,46,LUMR);tubeCut(V_PAL,46,LUMR);
g.save();g.beginPath();addPoly(TP.par);addPoly(TP.pal);addBlob(RV,-110,20,S[1]);g.clip();segCells(SEGS[3],B);segCells(SEGS[4],B);flush();g.restore();
endCap(V_PAR,46,LUMR,false);endCap(V_PAL,46,LUMR,false);
var oa=oAV(f),os=oSL(f);valve(VALVES[0],oa);valve(VALVES[1],oa);valve(VALVES[2],os);valve(VALVES[3],os)}

/* ---------- act 1: cells pushed out and pulled in by each beat ---------- */
var RC=[];for(var i=0;i<1700;i++)RC.push([R()*6.283,R(),.75+R()*.5,i%3,i%2]);
function hookCells(B,alpha,cx,cy){if(alpha<=0)return;var D=B*.3+.7*DOUT(B);var SZ=[3.4,5.4,8];
for(var l=0;l<3;l++){for(var i=l;i<RC.length;i+=3){var c=RC[i];var q=fr(c[1]+D*.085*c[2]);var inw=c[4];var u=inw?1-q:q;var dist=170+u*900;var ang=c[0]+(inw?-.5:.5)*u;var x=cx+Math.cos(ang)*dist,y=cy+Math.sin(ang)*dist*1.05;
if(y<740||x<-10||x>1090||y>1930)continue;var r=SZ[l]*sm(u*6)*sm((1-u)*2.5)*sm((y-740)/120);cell(x,y,r,inw?0:1)}flush(alpha*[.32,.58,1][l])}}

/* ---------- capillary-bed trees (shared by the lungs and the body) ---------- */
function buildTree(leaves,root,frac){var edges=[],paths=[];function wOf(n){return 2.4+2.5*Math.sqrt(n)}
function rec(ids,par,pp){var n=ids.length;if(n===1){var q=leaves[ids[0]];edges.push([par[0],par[1],q[0],q[1],wOf(1)]);paths[ids[0]]=pp.concat([[q[0],q[1],wOf(1)]]);return}
var cx=0,cy=0;for(var i=0;i<n;i++){cx+=leaves[ids[i]][0];cy+=leaves[ids[i]][1]}cx/=n;cy/=n;var p=[lerp(par[0],cx,frac),lerp(par[1],cy,frac),wOf(n)];edges.push([par[0],par[1],p[0],p[1],wOf(n)]);
var vx=0,vy=0;for(var i=0;i<n;i++){vx+=Math.pow(leaves[ids[i]][0]-cx,2);vy+=Math.pow(leaves[ids[i]][1]-cy,2)}var ax=vx>vy?0:1;var s=ids.slice().sort(function(a,b){return leaves[a][ax]-leaves[b][ax]});var h=n>>1;var np=pp.concat([p]);rec(s.slice(0,h),p,np);rec(s.slice(h),p,np)}
var ids=[];for(var i=0;i<leaves.length;i++)ids.push(i);rec(ids,root,[[root[0],root[1],wOf(leaves.length)]]);return{e:edges,p:paths}}
function bed(leaves,ra,rv,frac,ncell){return bedFrom(buildTree(leaves,ra,frac),buildTree(leaves,rv,frac*.92),leaves,ncell)}
function bedFrom(A,V,leaves,ncell){var P=[];for(var i=0;i<leaves.length;i++){var a=A.p[i],v=V.p[i].slice().reverse();var path=mkPath(a.concat(v.slice(1)));path.split=mkPath(a).len;P.push(path)}
var C=[];for(var i=0;i<ncell;i++)C.push([Math.floor(R()*leaves.length),R(),R()*2-1,.8+R()*.4]);return{A:A,V:V,P:P,C:C,leaves:leaves}}
function edges(E,col,dark,alpha){if(!E.bk){E.bk={};E.keys=[];for(var i=0;i<E.length;i++){var k=Math.round(E[i][4]*2)/2;if(!E.bk[k]){E.bk[k]=[];E.keys.push(k)}E.bk[k].push(E[i])}}
g.lineCap='round';g.globalAlpha=alpha;for(var pass=0;pass<2;pass++){g.strokeStyle=rgba(pass?col:dark,1);for(var j=0;j<E.keys.length;j++){var k=E.keys[j],L=E.bk[k];g.lineWidth=pass?k:k+5;g.beginPath();for(var i=0;i<L.length;i++){var e=L[i];g.moveTo(e[0],e[1]);g.lineTo(e[2],e[3])}g.stroke()}}ELEMENTS+=E.length;g.globalAlpha=1}
function bedCells(BD,B,f0,f1,rad,pxPerBeat){var D=B*.45+.55*DOUT(B);for(var i=0;i<BD.C.length;i++){var c=BD.C[i];var P=BD.P[c[0]];var len=P.len;var s=((c[1]*len+D*pxPerBeat*c[3])%len+len)%len;var p=at(P,s);var nx=-Math.sin(p[3]),ny=Math.cos(p[3]);var o=c[2]*p[2]*.36;var f=lerp(f0,f1,sm((s-P.split+14)/34));
cell(p[0]+nx*o,p[1]+ny*o,rad*sm(s/24)*sm((len-s)/24),f)}flush()}
function hero(BD,leaf,u,f0,f1,rad){var P=BD.P[leaf];var s=u*P.len;var p=at(P,s);var x=p[0],y=p[1];var f=lerp(f0,f1,sm((s-P.split+14)/34));
g.strokeStyle=rgba(AMB,1);g.lineWidth=6;g.beginPath();g.arc(x,y,rad*3.4,0,6.283);g.stroke();cell(x,y,rad*1.35,f);flush();ELEMENTS++;return[x,y]}
function nearest(L,x,y){var b=0,bd=1e9;for(var i=0;i<L.length;i++){var d=Math.hypot(L[i][0]-x,L[i][1]-y);if(d<bd){bd=d;b=i}}return b}
function sample(n,test,x0,x1,y0,y1,minD){var out=[],tries=0;while(out.length<n&&tries<40000){tries++;var x=lerp(x0,x1,R()),y=lerp(y0,y1,R());if(!test(x,y))continue;var ok=true;for(var i=0;i<out.length;i++){if(Math.hypot(out[i][0]-x,out[i][1]-y)<minD){ok=false;break}}if(ok)out.push([x,y])}return out}

function routedTree(GROUPS,LEAVES,root,off,frac){var E=[],paths=[];function wOf(n){return 2.4+2.5*Math.sqrt(n)}
GROUPS.forEach(function(G){var n=G.ids.length;if(!n)return;var rt=[[root[0],root[1]]].concat(G.route.map(function(p){return[p[0]+off[0],p[1]+off[1]]}));
for(var i=1;i<rt.length;i++)E.push([rt[i-1][0],rt[i-1][1],rt[i][0],rt[i][1],wOf(n)]);
var anchor=rt[rt.length-1];var T=buildTree(G.ids.map(function(i){return LEAVES[i]}),anchor,frac);E=E.concat(T.e);
var pre=rt.slice(0,-1).map(function(p){return[p[0],p[1],wOf(n)]});G.ids.forEach(function(id,k){paths[id]=pre.concat(T.p[k])})});return{e:E,p:paths}}
/* ---------- act 3a: the lungs ---------- */
var LUNGL=[[440,660],[350,668],[250,760],[180,930],[146,1130],[156,1310],[236,1420],[360,1432],[446,1366],[474,1180],[476,900],[466,720]];
var LUNGR=LUNGL.map(function(p){return[1080-p[0],p[1]]});
var LLEAF=sample(136,function(x,y){return inPoly(x,y,LUNGL)||inPoly(x,y,LUNGR)},120,960,700,1400,40);
var LGROUPS=[{ids:[],route:[[516,1250],[468,1176]]},{ids:[],route:[[556,1250],[612,1176]]}];for(var i=0;i<LLEAF.length;i++)LGROUPS[LLEAF[i][0]<540?0:1].ids.push(i);
var LUNG=bedFrom(routedTree(LGROUPS,LLEAF,[532,1340],[0,0],.4),routedTree(LGROUPS,LLEAF,[600,1372],[14,14],.36),LLEAF,1150);
var ALV=[];for(var i=0;i<LLEAF.length;i++){for(var k=0;k<5;k++){var a=R()*6.283,d=10+R()*10;ALV.push([LLEAF[i][0]+Math.cos(a)*d,LLEAF[i][1]+Math.sin(a)*d,9+R()*6])}}
var LHERO=nearest(LLEAF,300,880);
var TRA=sm3([[540,600],[540,770]]),BRL=sm3([[540,760],[480,800],[420,850]]),BRR=sm3([[540,760],[600,800],[660,850]]);
function lungs(t,B){bg([18,12,36],[30,18,52]);
for(var s=0;s<2;s++){var L=s?LUNGR:LUNGL;blob(L,540,1000,1);g.fillStyle=rgba([70,44,94],1);g.fill();g.save();g.clip();blob(L,s?560:520,980,.93);g.fillStyle=rgba([84,54,110],1);g.fill();g.restore();ELEMENTS+=2}
g.fillStyle=rgba([112,76,138],1);g.beginPath();for(var i=0;i<ALV.length;i++){var a=ALV[i];g.moveTo(a[0]+a[2],a[1]);g.arc(a[0],a[1],a[2],0,6.283);ELEMENTS++}g.fill();
g.fillStyle=rgba([132,94,158],1);g.beginPath();for(var i=0;i<ALV.length;i++){var a=ALV[i];g.moveTo(a[0]+a[2]*.5-2,a[1]-3);g.arc(a[0]-2,a[1]-3,a[2]*.5,0,6.283)}g.fill();
g.lineCap='round';g.strokeStyle=rgba([160,128,178],1);g.lineWidth=34;line(TRA);g.stroke();g.lineWidth=22;line(BRL);g.stroke();line(BRR);g.stroke();ELEMENTS+=3;
g.strokeStyle=rgba([120,92,146],1);g.lineWidth=4;for(var y=612;y<760;y+=18){g.beginPath();g.moveTo(524,y);g.lineTo(556,y);g.stroke();ELEMENTS++}
g.save();g.translate(546,1440);g.scale(.3,.3);heartExt(thump(fr(B)));g.restore();
edges(LUNG.V.e,[132,40,70],[64,16,38],1);edges(LUNG.A.e,[70,88,196],[30,34,92],1);
bedCells(LUNG,B,0,1,5.6,300);
return hero(LUNG,LHERO,seg(t,13.7,17.6),0,1,5.6)}

/* ---------- act 3b: the body ---------- */
var FT=[[410,830],[670,830],[702,950],[672,1150],[642,1282],[438,1282],[408,1150],[378,950]];
var ARMS=[[[398,866],[334,1066],[306,1290]],[[682,866],[746,1066],[774,1290]]],LEGS=[[[482,1250],[468,1450],[458,1640]],[[598,1250],[612,1450],[622,1640]]];
function dSeg(x,y,a,b){var dx=b[0]-a[0],dy=b[1]-a[1];var u=cl(((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy));return Math.hypot(x-a[0]-u*dx,y-a[1]-u*dy)}
function dLimb(x,y,L){return Math.min(dSeg(x,y,L[0],L[1]),dSeg(x,y,L[1],L[2]))}
function region(x,y){if(Math.hypot(x-540,y-724)<64)return 0;for(var i=0;i<2;i++){if(dLimb(x,y,ARMS[i])<24&&(i?x>676:x<404))return 1+i;if(dLimb(x,y,LEGS[i])<34&&y>1290)return 3+i}if(inPoly(x,y,FT)&&x>412&&x<668&&y<1270)return 5;return -1}
var BLEAF=sample(176,function(x,y){return region(x,y)>=0},260,820,650,1660,30);
var ROUTES=[[[556,880],[548,800],[544,772]],[[520,900],[440,880],[402,884]],[[610,900],[650,880],[678,884]],[[552,1040],[548,1200],[492,1286]],[[552,1040],[548,1200],[604,1286]],[]];
var GROUPS=[];for(var r=0;r<6;r++)GROUPS.push({ids:[],route:ROUTES[r]});for(var i=0;i<BLEAF.length;i++)GROUPS[region(BLEAF[i][0],BLEAF[i][1])].ids.push(i);
var BODY=bedFrom(routedTree(GROUPS,BLEAF,[562,948],[0,0],.42),routedTree(GROUPS,BLEAF,[592,964],[16,8],.36),BLEAF,1750);
var BHERO=nearest(BLEAF,776,1286);
function figShape(){g.beginPath();g.arc(540,724,84,0,6.283);g.fill();g.stroke();g.fillRect(506,790,68,60);blob(FT,540,1050,1);g.fill();g.stroke();
var lw=g.lineWidth;g.lineWidth=lw+76;for(var i=0;i<2;i++){line(ARMS[i]);g.stroke()}g.lineWidth=lw+100;for(var i=0;i<2;i++){line(LEGS[i]);g.stroke()}g.lineWidth=lw;
for(var i=0;i<2;i++){var a=ARMS[i][2];g.beginPath();g.ellipse(a[0]+(i?6:-6),a[1]+30,38,46,i?-.2:.2,0,6.283);g.fill();g.stroke();var l=LEGS[i][2];g.beginPath();g.ellipse(l[0]+(i?22:-22),l[1]+42,62,26,0,0,6.283);g.fill();g.stroke()}}
function figure(){g.lineCap='round';g.lineJoin='round';
g.fillStyle=rgba([66,54,112],1);g.strokeStyle=rgba([66,54,112],1);g.lineWidth=14;figShape();
g.fillStyle=rgba([40,32,76],1);g.strokeStyle=rgba([40,32,76],1);g.lineWidth=0.01;figShape();
g.fillStyle=rgba([50,40,92],1);g.beginPath();g.arc(512,698,48,0,6.283);g.fill();ELEMENTS+=22}
function body(t,B){bg([14,11,30],[24,17,46]);figure();
edges(BODY.V.e,[58,70,170],[26,26,72],1);edges(BODY.A.e,[150,40,70],[66,16,40],1);
bedCells(BODY,B,1,0,5,330);
g.save();g.translate(578,958);g.scale(.2,.2);heartExt(thump(fr(B)));g.restore();
return hero(BODY,BHERO,seg(t,17.6,20.8)*BODY.P[BHERO].split/BODY.P[BHERO].len,1,0,5)}

/* ---------- act 3c: a capillary, cells in single file ---------- */
function capY(x){return 1090+120*Math.sin(x*.0054+.5)}
var CAPP=[];for(var x=-80;x<=1160;x+=10)CAPP.push([x,capY(x)]);
var TIS=[];for(var row=0;row<28;row++){for(var col=0;col<14;col++){var x=col*86+(row%2)*43-20+(R()-.5)*22,y=row*74+(R()-.5)*20-10;if(Math.abs(y-capY(x))<96)continue;var v=[];var rad=38+R()*6;for(var k=0;k<7;k++){var a=k/7*6.283+R()*.3;v.push([x+Math.cos(a)*rad*(.86+R()*.2),y+Math.sin(a)*rad*(.86+R()*.2)])}TIS.push({x:x,y:y,v:v,n:[x+(R()-.5)*14,y+(R()-.5)*14,9+R()*5],s:R()<.5?0:1})}}
var O2=[];for(var i=0;i<900&&O2.length<340;i++){var x0=R()*1080;var keep=R()<1-x0/1250;var side=R()<.5?-1:1,ph=R(),sp=.32+R()*.3,wb=R()*6.283,ang=(R()-.5)*.8;if(keep)O2.push([x0,side,ph,sp,wb,ang])}
var PL=[];for(var i=0;i<280;i++)PL.push([R()*1240,R()*2-1,2+R()*2.5]);
function rbc(x,y,ang,f,sq){var c=mix(BLU,RED,f),d=mix(BLU2,RED2,f);g.save();g.translate(x,y);g.rotate(ang);g.fillStyle=rgba(c,1);g.beginPath();g.moveTo(-34*sq,-26);g.quadraticCurveTo(40,-34,40,0);g.quadraticCurveTo(40,34,-34*sq,26);g.quadraticCurveTo(-22,0,-34*sq,-26);g.fill();
g.fillStyle=rgba(d,1);g.beginPath();g.moveTo(-14*sq,-18);g.quadraticCurveTo(6,0,-14*sq,18);g.quadraticCurveTo(-30,0,-14*sq,-18);g.fill();g.fillStyle=rgba(mix(c,WHITE,.3),.7);g.beginPath();g.ellipse(18,-15,10,4,.3,0,6.283);g.fill();g.restore();ELEMENTS+=3}
function capillary(t){bg([16,11,32],[22,15,42]);var z=lerp(1,1.08,eio(seg(t,20.8,24.8)));g.save();g.translate(540,1090);g.scale(z,z);g.translate(-540,-1090);
for(var s=0;s<2;s++){g.fillStyle=rgba(s?[56,40,88]:[48,35,78],1);g.beginPath();for(var i=0;i<TIS.length;i++){var c=TIS[i];if(c.s!==s)continue;var v=c.v;g.moveTo((v[6][0]+v[0][0])/2,(v[6][1]+v[0][1])/2);for(var k=0;k<7;k++){var p=v[k],q=v[(k+1)%7];g.quadraticCurveTo(p[0],p[1],(p[0]+q[0])/2,(p[1]+q[1])/2)}ELEMENTS++}g.fill()}
g.fillStyle=rgba([88,64,124],1);g.beginPath();for(var i=0;i<TIS.length;i++){var n=TIS[i].n;g.moveTo(n[0]+n[2],n[1]);g.arc(n[0],n[1],n[2],0,6.283);ELEMENTS++}g.fill();
/* oxygen leaving the capillary: O2 as two joined dots */
g.fillStyle=rgba(AMB,1);g.beginPath();for(var i=0;i<O2.length;i++){var o=O2[i];var u=fr(o[2]+t*o[3]);var x0=o[0],dy=Math.cos(x0*.0054+.5)*120*.0054;var nl=Math.hypot(1,dy);var nx=-dy/nl*o[1],ny=1/nl*o[1];var d=46+u*230;var ca=Math.cos(o[5]),sa=Math.sin(o[5]);var dx=nx*ca-ny*sa,dyy=nx*sa+ny*ca;var x=x0+dx*d+Math.sin(o[4]+t*2)*8,y=capY(x0)+dyy*d;var r=4.8*sm(u*8)*sm((1-u)*3);if(r<.6)continue;var a=o[4]+t;g.moveTo(x+Math.cos(a)*r+r,y+Math.sin(a)*r);g.arc(x+Math.cos(a)*r,y+Math.sin(a)*r,r,0,6.283);g.moveTo(x-Math.cos(a)*r+r,y-Math.sin(a)*r);g.arc(x-Math.cos(a)*r,y-Math.sin(a)*r,r,0,6.283);ELEMENTS++}g.fill();
g.lineCap='round';g.lineJoin='round';g.strokeStyle=rgba([176,92,124],1);g.lineWidth=116;line(CAPP);g.stroke();g.strokeStyle=rgba([206,122,148],1);g.lineWidth=98;line(CAPP);g.stroke();ELEMENTS+=2;
g.strokeStyle=rgba([150,74,104],1);g.lineWidth=4;for(var x=-40;x<1140;x+=84){var y=capY(x),sl=Math.cos(x*.0054+.5)*120*.0054,nl=Math.hypot(1,sl),nx=-sl/nl,ny=1/nl;for(var s=-1;s<=1;s+=2){g.beginPath();g.moveTo(x+nx*s*38,y+ny*s*38);g.lineTo(x+nx*s*56,y+ny*s*56);g.stroke();ELEMENTS++}}
g.fillStyle=rgba([226,150,170],1);for(var x=2;x<1140;x+=84){var s=(Math.round(x/84)%2)?1:-1;var y=capY(x),sl=Math.cos(x*.0054+.5)*120*.0054,nl=Math.hypot(1,sl);g.beginPath();g.ellipse(x-sl/nl*s*47,y+1/nl*s*47,16,6,Math.atan(sl),0,6.283);g.fill();ELEMENTS++}
g.strokeStyle=rgba([62,18,44],1);g.lineWidth=76;line(CAPP);g.stroke();ELEMENTS++;
g.fillStyle=rgba([120,52,84],1);g.beginPath();for(var i=0;i<PL.length;i++){var p=PL[i];var x=((p[0]+t*260)%1240)-80;var y=capY(x)+p[1]*28;g.moveTo(x+p[2],y);g.arc(x,y,p[2],0,6.283);ELEMENTS++}g.fill();
var hx=0,hy=0;for(var i=0;i<12;i++){var x=((i*118+(t-21)*150+200)%1416+1416)%1416-160;var y=capY(x);var ang=Math.atan(Math.cos(x*.0054+.5)*120*.0054);var f=1-sm((x-260)/560);rbc(x,y,ang,f,.9+.1*Math.sin(t*6+i));if(i===0){hx=x;hy=y}}
g.strokeStyle=rgba(AMB,1);g.lineWidth=6;g.beginPath();g.arc(hx,hy,60,0,6.283);g.stroke();ELEMENTS++;
g.restore();
var gr=g.createLinearGradient(0,0,0,780);gr.addColorStop(0,rgba([16,11,32],.97));gr.addColorStop(.72,rgba([16,11,32],.94));gr.addColorStop(1,rgba([16,11,32],0));g.fillStyle=gr;g.fillRect(0,0,W,780)}

/* ---------- act 4: the facts, vessels wrapped around the Earth ---------- */
var LAND=[];for(var i=0;i<20;i++){var lo=R()*6.283,la=(R()-.5)*2.1;var n=6+Math.floor(R()*8);for(var k=0;k<n;k++)LAND.push([lo+(R()-.5)*.6,la+(R()-.5)*.45,.07+R()*.1])}
var STARS=[];for(var i=0;i<220;i++){var y=R()*1920;if(y>220&&y<1150)continue;STARS.push([R()*1080,y,1+R()*2.2,R()*6.283])}
var WR=[];for(var r=0;r<2;r++)for(var i=0;i<680;i++)WR.push([r,(i+R()*.6)/680,R()*2-1,.8+R()*.4]);
function earth(t){var cx=540,cy=1500,r=280;
g.fillStyle=rgba([30,36,90],1);g.beginPath();g.arc(cx,cy,r,0,6.283);g.fill();g.save();g.clip();
g.fillStyle=rgba([62,72,150],1);g.beginPath();for(var i=0;i<LAND.length;i++){var l=LAND[i];var lo=l[0]+t*.18;var z=Math.cos(lo)*Math.cos(l[1]);if(z<0)continue;var x=cx+r*Math.sin(lo)*Math.cos(l[1]),y=cy-r*Math.sin(l[1]);var rr2=r*l[2]*(.4+.6*z);g.moveTo(x+rr2,y);g.arc(x,y,rr2,0,6.283);ELEMENTS++}g.fill();
g.fillStyle=rgba([8,6,20],.3);g.beginPath();g.arc(cx+200,cy+150,r*1.1,0,6.283);g.fill();g.restore();g.strokeStyle=rgba([84,96,190],1);g.lineWidth=5;g.beginPath();g.arc(cx,cy,r+6,0,6.283);g.stroke();ELEMENTS+=3}
function wraps(t,front){var cx=540,cy=1500;for(var w=0;w<2;w++){var tl=w?.36:-.32,rx=346,ry=76;g.save();g.translate(cx,cy);g.rotate(tl);g.strokeStyle=rgba([120,30,54],front?1:.6);g.lineWidth=18;g.beginPath();if(front)g.ellipse(0,0,rx,ry,0,0,Math.PI);else g.ellipse(0,0,rx,ry,0,Math.PI,2*Math.PI);g.stroke();ELEMENTS++;g.restore()}
for(var i=0;i<WR.length;i++){var c=WR[i];var tl=c[0]?.36:-.32;var th=(c[1]+t*.07*(c[0]?1:-1))*6.283;var sn=Math.sin(th);if((sn>0)!==front)continue;var ex=346*Math.cos(th),ey=76*sn+c[2]*5;var x=cx+ex*Math.cos(tl)-ey*Math.sin(tl),y=cy+ex*Math.sin(tl)+ey*Math.cos(tl);cell(x,y,(front?6:4.6)*c[3],1)}flush(front?1:.55)}
function facts(t){bg([12,10,26],[26,18,50]);
for(var i=0;i<STARS.length;i++){var s=STARS[i];g.fillStyle=rgba(WHITE,.25+.25*Math.sin(s[3]+t*1.5));g.fillRect(s[0],s[1],s[2],s[2]);ELEMENTS++}
var q=eo(seg(t,24.7,26.4));g.save();g.translate(0,(1-q)*120);wraps(t,false);earth(t);wraps(t,true);g.restore()}

function thump(f){return eio(seg(f,.16,.23))*(1-eio(seg(f,.25,.6)))+.35*eio(seg(f,0,.05))*(1-eio(seg(f,.05,.16)))}

/* ---------- captions (DOM), driven by the seek ---------- */
var CAP=[].slice.call(document.querySelectorAll('[data-in]'));
function fmt(n){return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g,',')}
function captions(t){CAP.forEach(function(el){var a=+el.dataset.in,b=+el.dataset.out;var o=Math.min(seg(t,a,a+.45),1-seg(t,b-.35,b));el.style.opacity=o.toFixed(3);el.style.transform='translateY('+((1-eo(seg(t,a,a+.6)))*34).toFixed(1)+'px)'});
var n=document.getElementById('nbeat');if(n)n.textContent=fmt(Math.round(100000*eo(seg(t,.5,3.2))/10)*10);
var f=fr(BT(t)),sa=sqA(f),sv=sqV(f);var ph=document.getElementById('phase');if(ph){var txt=f<.16?'Atria squeeze':f<.5?'Ventricles squeeze':'Both relax and refill';if(ph.textContent!==txt)ph.textContent=txt}
[['lra',sa],['lla',sa],['lrv',sv],['llv',sv]].forEach(function(p){var el=document.getElementById(p[0]);if(el)el.style.borderColor='rgba(255,204,112,'+(.22+.78*cl(p[1]*1.6)).toFixed(2)+')'})}

function cover(cx,cy){return Math.max(Math.hypot(cx,cy),Math.hypot(W-cx,cy),Math.hypot(cx,H-cy),Math.hypot(W-cx,H-cy))+4}
function bodyHero(t){var P=BODY.P[BHERO];var p=at(P,seg(t,17.6,20.8)*P.split);return[p[0],p[1]]}
/* iris transitions: once an iris covers the frame, the outgoing scene is not drawn at all */
function iris(t,a,b,cx,cy,R){var r=t>=a?eio(seg(t,a,b))*R:0;return{r:r,x:cx,y:cy,full:t>=b||r>=cover(cx,cy)}}
function irisClip(I){if(!I.full){g.beginPath();g.arc(I.x,I.y,I.r,0,6.283);g.clip()}}
var draw=function(t){ELEMENTS=0;g.setTransform(1,0,0,1,0,0);g.globalAlpha=1;var B=BT(t);
var I1=iris(t,13.4,14.1,480,1110,1500),I2=iris(t,17.4,18.1,546,1440,1700),h3=bodyHero(20.8),I3=iris(t,20.8,21.5,h3[0],h3[1],1900);
/* Acts 1-2: the hook, then the heart splits open into the cutaway */
if(t<14.1&&!I1.full){bg(BG,BG2);
var q=eio(seg(t,4.4,5.6));hookCells(B,1-seg(t,4.4,5.2),540,1230);
var hx=540,hy=lerp(1230,1180,q),hs=lerp(.8,1.1,q);
if(t>=4.4){g.save();g.translate(hx,hy);g.scale(hs,hs);heartCut(B);g.restore()}
if(t<5.6){var th=thump(fr(B));g.save();g.translate(hx,hy);g.scale(hs,hs);
if(q<=0)heartExt(th);else{for(var s=-1;s<=1;s+=2){g.save();g.globalAlpha=1-seg(q,.5,1);g.translate(s*q*760,q*60);g.rotate(s*q*.3);g.beginPath();if(s<0)g.rect(-2000,-2000,1990,4000);else g.rect(-10,-2000,2010,4000);g.clip();heartExt(0);g.restore()}}g.restore()}}
/* Act 3a: lungs, through an iris from the pulmonary artery */
if(t>=13.4&&t<18.1&&!I2.full){g.save();irisClip(I1);lungs(t,B);g.restore()}
/* Act 3b: the body */
if(t>=17.4&&t<21.5&&!I3.full){g.save();irisClip(I2);body(t,B);g.restore()}
/* Act 3c: into a capillary at the hand */
if(t>=20.8&&t<24.8){g.save();irisClip(I3);capillary(t);g.restore()}
/* ECG under acts 1-3 */
ecg(B,1-seg(t,20.6,21.1));
/* Act 4: facts */
if(t>=24.4&&t<24.8){g.fillStyle=rgba([6,5,14],seg(t,24.4,24.8));g.fillRect(0,0,W,H)}
if(t>=24.8){facts(t);var k=1-seg(t,24.8,25.2);if(k>0){g.fillStyle=rgba([6,5,14],k);g.fillRect(0,0,W,H)}}
captions(t);window.__rfElements=ELEMENTS};
`;

const CSS = `
.cap{position:absolute;left:84px;right:84px;opacity:0;color:#F6F0F4;font-family:"Inter Display",Inter,sans-serif;letter-spacing:-.02em;text-align:center}
.cap.top{top:250px}
.cap .k{font-size:36px;font-weight:500;color:#B9AEC8;letter-spacing:0;margin-bottom:20px;font-family:"JetBrains Mono","DejaVu Sans Mono",monospace}
.cap h2{margin:0;font-size:80px;line-height:1.04;font-weight:600}
.cap p{margin:0;font-size:56px;line-height:1.16;font-weight:500}
.cap b{color:#FF6B74;font-weight:600}.cap i{font-style:normal;color:#8EA6FF}
.big{font-size:200px!important;line-height:.92!important;font-weight:600;color:#FF6B74;letter-spacing:-.05em;font-variant-numeric:tabular-nums}
.lbl{position:absolute;opacity:0;font:500 34px/1 "JetBrains Mono","DejaVu Sans Mono",monospace;color:#F6F0F4;padding:12px 18px;border-radius:12px;background:rgba(14,11,28,.8);border:3px solid rgba(255,204,112,.22);white-space:nowrap}
.pill{position:absolute;left:0;right:0;top:436px;text-align:center;opacity:0}
.pill span{display:inline-block;font:500 36px/1 "JetBrains Mono","DejaVu Sans Mono",monospace;color:#FFCC70;padding:14px 26px;border-radius:40px;background:rgba(14,11,28,.85);border:3px solid rgba(255,204,112,.55)}
.facts{position:absolute;left:84px;right:84px;top:360px;display:grid;gap:20px}
.fact{opacity:0;display:flex;justify-content:space-between;align-items:baseline;padding:24px 32px;border-radius:24px;background:rgba(14,11,28,.7);border:2px solid rgba(246,240,244,.14);color:#F6F0F4;font-family:"Inter Display",Inter,sans-serif}
.fact span{font-size:38px;color:#CFC4DA}.fact strong{font-size:60px;font-weight:600;letter-spacing:-.03em}
.brand{position:absolute;left:0;right:0;top:1056px;text-align:center;opacity:0;font:500 34px/1 "JetBrains Mono","DejaVu Sans Mono",monospace;color:#B9AEC8}
`;

const HTML = `
<div class="cap top" data-in="0.1" data-out="4.6"><div class="k">Your heart beats about</div><h2 class="big"><span id="nbeat">0</span></h2><p style="margin-top:10px">times a day</p></div>
<div class="cap" style="top:640px" data-in="2.5" data-out="4.6"><p style="font-size:44px;color:#CFC4DA">and it never takes a day off</p></div>
<div class="cap top" data-in="5.1" data-out="7.8"><div class="k">Cut one open</div><h2>Four chambers,<br><b>two pumps</b></h2></div>
<div class="cap top" data-in="7.8" data-out="10.4"><p>In: <i>blue</i> from the body,<br><b>red</b> from the lungs</p></div>
<div class="cap top" data-in="10.4" data-out="13.4"><p>Atria squeeze first,<br>then the ventricles</p></div>
<div class="pill" data-in="7.8" data-out="13.4"><span id="phase">Atria squeeze</span></div>
<div class="lbl" id="lra" style="left:96px;top:1100px" data-in="6" data-out="13.3">Right atrium</div>
<div class="lbl" id="lrv" style="left:150px;top:1404px" data-in="6.3" data-out="13.3">Right ventricle</div>
<div class="lbl" id="lla" style="left:660px;top:1046px" data-in="6.6" data-out="13.3">Left atrium</div>
<div class="lbl" id="llv" style="left:590px;top:1446px" data-in="6.9" data-out="13.3">Left ventricle</div>
<div class="cap top" data-in="14" data-out="15.9"><div class="k">Lap one: the lungs</div><p>Blood drops CO₂ and<br>picks up <b>oxygen</b></p></div>
<div class="cap top" data-in="15.9" data-out="17.6"><p><b>Red</b> and refuelled,<br>it heads back to the heart</p></div>
<div class="cap top" data-in="18" data-out="19.6"><div class="k">Lap two: the body</div><p>The left side fires it<br>out through the <b>arteries</b></p></div>
<div class="cap top" data-in="19.6" data-out="21.2"><p>They branch into smaller<br>and smaller vessels</p></div>
<div class="cap top" data-in="21.5" data-out="23"><div class="k">Capillaries</div><p>So narrow that cells<br>go in <b>single file</b></p></div>
<div class="cap top" data-in="23" data-out="24.5"><p>Oxygen out, then <i>blue</i><br>and back to the heart</p></div>
<div class="cap top" data-in="25" data-out="30.6"><p style="font-size:54px">Your heart never takes a day off</p></div>
<div class="facts">
 <div class="fact" data-in="25.4" data-out="30.6"><span>Beats a day</span><strong>≈ 100,000</strong></div>
 <div class="fact" data-in="25.8" data-out="30.6"><span>Pumped a day</span><strong>≈ 7,000 L</strong></div>
 <div class="fact" data-in="26.2" data-out="30.6"><span>Beats in a life</span><strong>≈ 2.5 billion</strong></div>
 <div class="fact" data-in="26.6" data-out="30.6"><span>Vessels, end to end</span><strong style="color:#FF6B74">≈ 100,000 km</strong></div>
</div>
<div class="cap" style="top:968px" data-in="27.2" data-out="30.6"><p style="font-size:44px;color:#CFC4DA">enough to wrap around Earth twice</p></div>
<div class="brand" data-in="28" data-out="30.6">Rendered with ReelForge</div>
`;

export const HEART: FlagshipReel = {
  slug: 'your-heart-never-stops',
  title: 'Your heart never takes a day off',
  category: 'How it works',
  tags: ['science', 'biology', 'explainer', 'human body'],
  description:
    'A cutaway of the four chambers through one slowed-down beat, then one blood cell through the lungs, the body and a capillary, with 1,700 cells in the vessel tree and an ECG in sync.',
  prompt:
    'Make a 30-second vertical explainer about the heart. Hook with a beating heart and a counter to about 100,000 beats a day, then cut it open: four chambers, valves opening and closing in sync, blue blood in from the body and red blood from the lungs, atria then ventricles, with an ECG line locked to the beat. Follow one cell through the lungs (blue to red), out through a branching tree of arteries to the body, and into a capillary in single file where it hands over oxygen. End on four well-known facts with "about", no medical advice.',
  duration: DUR,
  music: 'pulse',
  html: composition(DUR, HTML, CSS, SCRIPT),
};
