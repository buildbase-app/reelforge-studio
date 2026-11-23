/**
 * Flagship reel: "How a rocket gets to orbit (and lands back)". One
 * HyperFrames composition, 33 s, drawn on a canvas by a pure function of time
 * (seeked by the runtime through window.__hfAnime). A generic two-stage
 * reusable rocket, no real vehicle, company or livery. Nine shots: the pad at
 * dawn, ignition and liftoff with a following camera, the climb through the
 * clouds and Max Q, a wide shot of the gravity turn over the curve of the
 * Earth, stage separation, payload release, Newton's cannon (orbit is falling
 * and missing), the booster's flip and entry burn, and the landing on a ship
 * at sea, then the facts. Captions and the speed readout are DOM text, also
 * driven from the seek, so every frame is reproducible.
 *
 * Every particle (exhaust, smoke, vapour, ice, sparks) is computed from the
 * scene time and its seeded birth time, never from the previous frame.
 *
 * Facts used (general, well known): space starts around 100 km up (the
 * Karman line); low Earth orbit is about 400 km up; orbital speed there is
 * about 7.8 km/s, about 28,000 km/h; one orbit takes about 90 minutes.
 */
import { composition, type FlagshipReel } from './kit';

const DUR = 33;

const SCRIPT = String.raw`
var cv=document.getElementById('cv'),g=cv.getContext('2d'),W=1080,H=1920;g.lineCap='round';g.lineJoin='round';
var sd=1957;function R(){sd=(sd+0x6d2b79f5)>>>0;var t=sd;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296}
function cl(x){return x<0?0:x>1?1:x}
function seg(t,a,b){return cl((t-a)/(b-a))}
function eo(x){x=cl(x);return 1-Math.pow(1-x,3)}
function eio(x){x=cl(x);return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2}
function lerp(a,b,f){return a+(b-a)*f}
function mix(c1,c2,f){return [Math.round(lerp(c1[0],c2[0],f)),Math.round(lerp(c1[1],c2[1],f)),Math.round(lerp(c1[2],c2[2],f))]}
var GA=1;
function rgba(c,a){return 'rgba('+c[0]+','+c[1]+','+c[2]+','+Math.round(cl(a*GA)*1000)/1000+')'}
var INK=[7,11,24],NAVY=[16,26,58],DAWN1=[44,54,110],DAWN2=[124,100,152],DAWN3=[236,146,116],DAWN4=[255,198,146],SUN=[255,228,176],
WHITE=[246,243,238],HULL=[234,233,228],HULLS=[168,172,188],DARK=[38,42,56],STEEL=[92,98,116],SOOT=[52,46,50],
ORANGE=[255,122,48],AMBER=[255,186,96],CORE=[255,249,230],SMOKEL=[240,226,214],SMOKES=[150,136,148],
OCEAN=[30,74,140],LAND1=[92,128,96],LAND2=[146,140,102],CLOUD=[238,242,248],ICE=[150,206,255],GROUND=[38,38,56];
var ELEMENTS=0;
function circ(x,y,r,c,a){if(a<=.004||r<=.3)return;g.fillStyle=rgba(c,a);g.beginPath();g.arc(x,y,r,0,6.2832);g.fill();ELEMENTS++}
function ell(x,y,rx,ry,rot,c,a){if(a<=.004)return;g.fillStyle=rgba(c,a);g.beginPath();g.ellipse(x,y,rx,ry,rot,0,6.2832);g.fill();ELEMENTS++}
function rect(x,y,w,h,c,a){g.fillStyle=rgba(c,a==null?1:a);g.fillRect(x,y,w,h);ELEMENTS++}
function poly(p,c,a){g.fillStyle=rgba(c,a==null?1:a);g.beginPath();g.moveTo(p[0],p[1]);for(var i=2;i<p.length;i+=2)g.lineTo(p[i],p[i+1]);g.closePath();g.fill();ELEMENTS++}
function line(x1,y1,x2,y2,c,a,w){if(a<=.004)return;g.strokeStyle=rgba(c,a);g.lineWidth=w;g.beginPath();g.moveTo(x1,y1);g.lineTo(x2,y2);g.stroke();ELEMENTS++}
function ring(x,y,r,c,a,w,a0,a1){if(a<=.004)return;g.strokeStyle=rgba(c,a);g.lineWidth=w;g.beginPath();g.arc(x,y,r,a0==null?0:a0,a1==null?6.2832:a1);g.stroke();ELEMENTS++}
function vgrad(y0,y1,st,band){var gr=g.createLinearGradient(0,y0,0,y1);for(var i=0;i<st.length;i+=2)gr.addColorStop(st[i],rgba(st[i+1],1));g.fillStyle=gr;if(band)g.fillRect(-200,y0,W+400,y1-y0+400);else g.fillRect(-200,-200,W+400,H+400);ELEMENTS++}
function arrow(x,y,len,ang,c,w,al){if(al<=.01||len<w*2)return;g.save();g.translate(x,y);g.rotate(ang);rect(-w/2,-len+w*1.4,w,len-w*1.4,c,al);poly([-w*1.7,-len+w*1.8,0,-len-w*.6,w*1.7,-len+w*1.8],c,al);g.restore()}

/* ---------- seeded tables ---------- */
var PS=[];for(var i=0;i<4096;i++)PS.push([R(),R(),R(),R(),R(),R()]);
var STARS=[];for(var i=0;i<720;i++){var z=R();STARS.push([R()*W,R()*H,z<.85?2:z<.97?3:4,R()])}
/* particles born at a steady rate between t0 and t1; fn(P,birth,age,ageFraction) for the live ones, oldest first */
function emit(t,t0,t1,rate,l0,l1,seed,fn){if(t<t0)return;var n0=Math.max(0,Math.floor((t-l1-t0)*rate)-1),n1=Math.min(Math.ceil((t1-t0)*rate),Math.ceil((t-t0)*rate));
for(var i=n0;i<=n1;i++){var P=PS[(i*7+seed)%4096];var b=t0+(i+P[0]*.9)/rate;if(b>t1||b>t)continue;var a=t-b,L=l0+(l1-l0)*P[1];if(a>L)continue;fn(P,b,a,a/L)}}
function stars(al,t,n,dy){if(al<=.01)return;for(var i=0;i<n;i++){var s=STARS[i];var y=s[1]+(dy||0);if(y<-4||y>H+4)continue;rect(s[0],y,s[2],s[2],WHITE,al*(.3+.45*s[3]+.25*Math.sin(t*2.1+i*1.7)))}}
function streaks(t,n,F,fx,fy,al,col,lk){for(var j=0;j<n;j++){var P=PS[(3000+j)%4096];var off=F*(.5+P[2]);var x=((P[0]*1500+fx*off)%1500+1500)%1500-210,y=((P[1]*2300+fy*off)%2300+2300)%2300-190;var L=(30+140*P[3])*lk;line(x,y,x-fx*L,y-fy*L,col,al*(.25+.75*P[4]),1.5+2.5*P[5])}}
function puffs(x,y,s,p,sh,lit,al){if(al<=.01)return;g.fillStyle=rgba(sh,al);g.beginPath();for(var k=0;k<p.length;k++){var q=p[k];g.moveTo(x+q[0]*s+q[2]*s,y+q[1]*s);g.arc(x+q[0]*s,y+q[1]*s,q[2]*s,0,6.2832);ELEMENTS++}g.fill();
g.fillStyle=rgba(lit,al);g.beginPath();for(var k=0;k<p.length;k++){var q=p[k];var r=q[2]*s*.8;g.moveTo(x+q[0]*s-r*.15+r,y+q[1]*s-r*.25);g.arc(x+q[0]*s-r*.15,y+q[1]*s-r*.25,r,0,6.2832);ELEMENTS++}g.fill()}
function mkCloud(n,w,h,r0,r1){var p=[];for(var k=0;k<n;k++)p.push([(R()-.5)*w,(R()-.5)*h,r0+R()*(r1-r0)]);return p}

/* ---------- the rocket (local units, engine plane at y=0, nose up) ---------- */
function bell(x,y,w0,w1,h,c,a){poly([x-w0/2,y,x+w0/2,y,x+w1/2,y+h,x-w1/2,y+h],c,a)}
function leg(s,lg){var a=2.5*eio(lg);var dx=s*Math.sin(a),dy=-Math.cos(a);var hx=s*27,hy=-52,L=200;var ex=hx+dx*L,ey=hy+dy*L;
if(lg>.02){var mx=hx+dx*L*.55,my=hy+dy*L*.55;line(s*27,-200,mx,my,STEEL,1,7)}
var nx=-dy*7,ny=dx*7;poly([hx+nx,hy+ny,ex+nx*.7,ey+ny*.7,ex-nx*.7,ey-ny*.7,hx-nx,hy-ny],[30,32,44],1);if(lg>.6)rect(ex-14,ey-4,28,8,[30,32,44],cl((lg-.6)*4))}
function booster(o){var lg=o.legs||0,fn=o.fins||0,so=o.soot||0;
for(var k=-1;k<=1;k++)bell(k*19,-6,13,21,32,STEEL);
rect(-31,-36,62,36,DARK);rect(-28,-520,56,484,HULL);
if(so>0)poly([-28,-36,28,-36,28,-250-80*so,16,-232-100*so,4,-262-90*so,-10,-226-110*so,-28,-256-80*so],SOOT,.88*so);
rect(12,-520,16,484,HULLS,.45);for(var k=1;k<5;k++)rect(-28,-36-k*96,56,2,HULLS,.7);
for(var s=-1;s<=1;s+=2){var w=6+42*eio(fn);var x0=s>0?28:-28-w;rect(x0,-514,w,30,DARK);if(fn>.3){for(var j=1;j<4;j++)rect(x0+w*j/4-1.5,-514,3,30,STEEL,cl((fn-.3)*3))}}
rect(-29,-580,58,62,DARK);rect(12,-580,17,62,[22,24,34]);
for(var s=-1;s<=1;s+=2)leg(s,lg)}
function fairingHalf(s,fo){g.save();var hx=s*31,hy=-200;if(fo>0){g.translate(hx+s*fo*150,hy+fo*60);g.rotate(s*fo*.9);g.translate(-hx,-hy)}
g.fillStyle=rgba(s<0?HULL:[214,214,214],1);g.beginPath();g.moveTo(0,-200);g.lineTo(s*31,-200);g.lineTo(s*31,-320);g.quadraticCurveTo(s*31,-400,0,-436);g.closePath();g.fill();ELEMENTS++;g.restore()}
function satellite(d,rot,un){g.save();g.translate(0,-272-d);g.rotate(rot);
for(var s=-1;s<=1;s+=2){var n=6,u=un*n;for(var k=0;k<n;k++){var f=cl(u-k);if(f<=0)break;var x0=s>0?22+k*30:-22-k*30-30*f;rect(x0,-40,30*f-2,80,[34,56,118]);if(f>.5){rect(x0,-1,30*f-2,2,ICE,.7);rect(x0+(30*f-2)/2-1,-40,2,80,ICE,.5)}}if(un>0)rect(s>0?20:-24,-3,4,6,STEEL)}
rect(-21,-56,42,112,[208,212,222]);rect(-21,-56,42,8,DARK);rect(6,-48,15,104,HULLS,.5);for(var k=0;k<4;k++)rect(-14,-36+k*22,24,12,[70,78,98]);
circ(0,-70,14,[226,226,232],1);rect(-1,-84,2,16,STEEL);g.restore()}
function upper(o){var fo=o.fairing||0;
bell(0,0,22,66,92,STEEL);bell(0,6,14,56,86,[30,32,44]);if(o.hot)bell(0,54,44,62,38,ORANGE,.55*o.hot);
rect(-28,-200,56,200,HULL);rect(12,-200,16,200,HULLS,.45);rect(-28,-104,56,2,HULLS,.7);
if(fo>0||o.pay){poly([-16,-200,16,-200,10,-214,-10,-214],DARK,1);satellite(o.pd||0,o.pr||0,o.un||0)}
fairingHalf(-1,fo);fairingHalf(1,fo)}
function stack(o){g.save();g.translate(0,-580);upper(o.u||{});g.restore();booster(o.b||{})}
/* exhaust flame shape below an exit plane at y=y0, length L, width w */
function flame(L,w,t,y0,diam){if(L<=2)return;var fl=1+.07*Math.sin(t*37)+.05*Math.sin(t*61+1);var Ls=[[ORANGE,.55,1,1],[AMBER,.85,.78,.72],[CORE,1,.52,.42]];
for(var i=0;i<3;i++){var c=Ls[i];var len=L*fl*c[2],ww=w*c[3];g.fillStyle=rgba(c[0],c[1]);g.beginPath();g.moveTo(-ww*.5,y0);g.quadraticCurveTo(-ww*.78,y0+len*.33,0,y0+len);g.quadraticCurveTo(ww*.78,y0+len*.33,ww*.5,y0);g.closePath();g.fill();ELEMENTS++}
if(diam)for(var k=0;k<4;k++){var yy=y0+L*(.1+k*.1),dw=w*.2*(1-k*.17);poly([0,yy-dw*1.3,dw,yy,0,yy+dw*1.3,-dw,yy],WHITE,.85)}}
function fireCol(f){return f<.3?mix(CORE,AMBER,f/.3):mix(AMBER,ORANGE,(f-.3)/.7)}

/* ---------- Earth: the limb seen from altitude, and the whole globe ---------- */
var LST=[];for(var i=0;i<600;i++)LST.push([R(),R(),R(),R()]);
function limb(cx,cy,Rr,t,flow,dawn){var k;
for(k=0;k<8;k++)ring(cx,cy,Rr+5+k*7,[110,170,255],.07,7);
if(dawn>0)for(k=0;k<6;k++)ring(cx,cy,Rr+4+k*5,k<2?ORANGE:AMBER,.12*dawn,6,-Math.PI/2-1.2,-Math.PI/2-.12-k*.07);
circ(cx,cy,Rr,OCEAN,1);
g.save();g.beginPath();g.arc(cx,cy,Rr,0,6.2832);g.clip();
var span=2*Math.asin(Math.min(1,(W*.8)/Rr)),om=flow/Rr;
for(var i=0;i<600;i++){var P=LST[i];var d=P[1];var land=i<110;var ph=((P[0]*span+om*t*(.45+d))%span+span)%span-span/2;var ang=-Math.PI/2+ph;var rr=Rr-4-Math.pow(d,1.5)*Math.min(Rr*.3,560);
var x=cx+Math.cos(ang)*rr,y=cy+Math.sin(ang)*rr;if(x<-140||x>W+140||y<-60||y>H+60)continue;var sc=Math.sqrt(Rr/1700);var rx=(land?44+80*P[2]:14+40*P[2])*(.3+1.1*d)*sc,ry=rx*(land?.12+.3*d:.06+.14*d);
ell(x,y,rx,ry,ang+Math.PI/2+(land?0:(P[3]-.5)*.3),land?(P[3]<.5?LAND1:LAND2):CLOUD,land?1:.7)}
ring(cx,cy,Rr-6,[150,196,255],.4,14);g.restore()}
var GLP=[];var CONT=[[.7,.2],[-.3,1.3],[.3,2.5],[-.6,3.5],[.9,4.4],[.05,5.3],[-1.1,.6]];for(var c=0;c<CONT.length;c++)for(var k=0;k<38;k++)GLP.push([CONT[c][0]+(R()+R()-1)*.42,CONT[c][1]+(R()+R()-1)*.62,.035+.06*R(),R()]);
var GCL=[];for(var i=0;i<560;i++)GCL.push([Math.asin(R()*2-1),R()*6.2832,.02+.04*R(),R()]);
function sph(lat,lon){var c=Math.cos(lat);var x=c*Math.sin(lon),y=-Math.sin(lat),z=c*Math.cos(lon);var T=.38,ct=Math.cos(T),st=Math.sin(T);return [x,y*ct-z*st,y*st+z*ct]}
function globe(cx,cy,Rr,rot,t){for(var k=0;k<7;k++)ring(cx,cy,Rr+4+k*6,[110,170,255],.08,6);
circ(cx,cy,Rr,OCEAN,1);g.save();g.beginPath();g.arc(cx,cy,Rr,0,6.2832);g.clip();
var nx=cx+Rr*1.02,ny=cy+Rr*.6,nr=Rr*1.3;
for(var i=0;i<GLP.length;i++){var p=GLP[i];var v=sph(p[0],p[1]+rot);if(v[2]<-.05)continue;circ(cx+v[0]*Rr,cy+v[1]*Rr,p[2]*Rr*(.4+.6*cl(v[2])),p[3]<.55?LAND1:LAND2,1)}
for(var i=0;i<GCL.length;i++){var p=GCL[i];var v=sph(p[0],p[1]+rot*1.2+.4);if(v[2]<0)continue;ell(cx+v[0]*Rr,cy+v[1]*Rr,p[2]*Rr*1.8,p[2]*Rr*(.18+.3*v[2]),.2,CLOUD,.6)}
circ(nx,ny,nr,[5,9,26],.62);
for(var i=0;i<GLP.length;i+=2){var p=GLP[i];var v=sph(p[0],p[1]+rot);if(v[2]<.05)continue;var x=cx+v[0]*Rr,y=cy+v[1]*Rr;var dx=x-nx,dy=y-ny;if(dx*dx+dy*dy>nr*nr*.9)continue;circ(x,y,1.6+Rr*.004,AMBER,.85)}
ring(cx,cy,Rr-4,[190,226,255],.5,6,-Math.PI*1.05,-Math.PI*.25);g.restore()}

/* ================= 1. pad at dawn, ignition, liftoff (0 - 9.6) ================= */
var RX=470,RS=.82;
function hAlt(t){var d=t-5;return d>0?70*d*d+38*d*d*d:0}
function smx(x,k){return x<=-k?0:x>=k?x:(x+k)*(x+k)/(4*k)}
var GRASS=[];for(var i=0;i<170;i++)GRASS.push([R()*1180-50,R(),R()]);
var BUSH=[];for(var i=0;i<80;i++)BUSH.push([R()*2600-800,10+R()*24,R()]);
var DCL=[];for(var i=0;i<20;i++)DCL.push({x:R()*1500-200,y:560+R()*760,p:mkCloud(12,380,40,24,48),s:.55+R()*.6});
var WCD=[];for(var i=0;i<28;i++)WCD.push({x:R()*2200-700,y:-2300-R()*3300,p:mkCloud(11,420,80,40,84),s:.8+R()*.6,f:R()<.4});
function pad(t){var h=hAlt(t),rise=smx(h-210,60);var Z=lerp(1,1.045,eo(seg(t,0,4.4)))*lerp(1,.6,eio(seg(t,5.4,9.6)));var cx=lerp(540,RX+40,eio(seg(t,5.2,8)));var cy=-480-rise;
var sh=seg(t,4.2,4.5)*(1-seg(t,5.6,7.6));var sx=Math.sin(t*53)*6*sh,sy=Math.cos(t*41)*5*sh;
var k=cl(rise/5200),hz=1490+rise*.2,gy=(0-cy)*Z+1080+sy;
vgrad(0,hz,[0,mix(DAWN1,NAVY,k),.45,mix(DAWN2,DAWN1,k),.8,mix(DAWN3,DAWN2,k*.8),1,mix(DAWN4,DAWN3,k)]);
stars((1-seg(t,0,5))*.55,t,150);
if(hz<H+300){for(var i=5;i>0;i--)circ(200,hz+4,46+i*34,SUN,.07);circ(200,hz+4,46,SUN,1)}
for(var i=0;i<DCL.length;i++){var c=DCL[i];var x=((c.x+t*9*c.s)%1600+1600)%1600-260,y=c.y+rise*.1;if(y>H+80)continue;
g.save();g.translate(x,y);g.scale(1,.45);puffs(0,0,c.s,c.p,mix([96,82,132],DAWN2,.35),mix(DAWN3,DAWN4,.35),.94);g.restore()}
if(hz<H){rect(0,hz,W,H-hz,mix([104,96,146],[46,52,98],k));for(var i=0;i<140;i++){var P=PS[i];var yy=hz+3+P[1]*P[1]*80;if(yy>gy)continue;rect(200+(P[0]-.5)*(40+520*P[1])-6,yy,8+22*P[1],2,SUN,.25+.5*Math.abs(Math.sin(t*2.6+i)))}}
var ox=540+sx-cx*Z,oy=1080+sy-cy*Z;g.setTransform(Z,0,0,Z,ox,oy);
function vis(y,r){var s=y*Z+oy;return s+r*Z>-40&&s-r*Z<H+40}
/* masts and wires */
var MX=[RX-330,RX+430,RX+760];for(var i=0;i<3;i++){if(vis(-600,700)){line(MX[i],0,MX[i],-1150,[34,36,54],1,6);rect(MX[i]-5,-1160,10,14,[34,36,54])}}
if(vis(-1100,80)){g.strokeStyle=rgba([34,36,54],.8);g.lineWidth=2;g.beginPath();g.moveTo(MX[0],-1150);g.quadraticCurveTo((MX[0]+RX+106)/2,-1020,RX+106,-1130);g.quadraticCurveTo((RX+106+MX[1])/2,-1020,MX[1],-1150);g.quadraticCurveTo((MX[1]+MX[2])/2,-1040,MX[2],-1150);g.stroke();ELEMENTS++}
/* treeline and ground */
if(vis(0,60))for(var i=0;i<BUSH.length;i++){var b=BUSH[i];circ(b[0],-2,b[1],mix(GROUND,[60,56,84],b[2]*.5),1)}
if(vis(200,260)){rect(-1400,0,4000,3000,GROUND);rect(RX-300,-8,600,14,[92,90,112]);rect(RX-56,-4,112,16,[12,12,20]);rect(RX-50,-42,14,40,DARK);rect(RX+36,-42,14,40,DARK);rect(RX-52,-46,104,8,DARK)}
/* service tower, two faces */
var TX=RX+66,TW=80,NL=36;
for(var f=0;f<2;f++){var c=f?[26,28,42]:[66,64,92],dx=f?0:16,dy=f?0:-10;if(!vis(-540,620))break;
line(TX+dx,dy,TX+dx,-1080+dy,c,1,7);line(TX+TW+dx,dy,TX+TW+dx,-1080+dy,c,1,7);
for(var l=0;l<NL;l++){var y0=-l*30+dy,y1=y0-30;if(!vis(y0,40))continue;line(TX+dx,y1,TX+TW+dx,y1,c,1,3);line(TX+dx,y0,TX+TW+dx,y1,c,1,2.5);line(TX+TW+dx,y0,TX+dx,y1,c,1,2.5)}}
if(vis(-1100,80)){line(TX+40,-1080,TX+40,-1230,[26,28,42],1,4);for(var i=0;i<6;i++)circ(i<2?TX+40:TX+(i%2?TW:0),i<2?-1230+i*150:-1080+(i-2)*190,6,ORANGE,.45+.45*Math.sin(t*4+i*1.3))}
/* crew arm retracts (foreshortens), umbilicals drop at liftoff */
var arm=Math.cos(eio(seg(t,1.4,3.4))*1.35);var ay=-40-(580+330)*RS-h;if(vis(-786,40)){var al=TX-(RX+26);rect(TX-al*arm,-800,al*arm,26,[30,32,46]);for(var j=0;j<5;j++)line(TX-al*arm*j/5,-800,TX-al*arm*(j+1)/5,-774,STEEL,arm,2)}
var drop=eio(seg(t,5,5.8));for(var j=0;j<3;j++){var uy=-120-j*170;var ex=lerp(RX+22,TX-8,drop),ey=lerp(uy-h,uy+150,drop);if(vis(uy,200))line(TX,uy-20,ex,ey,[30,32,46],1,5)}
/* vents: cold vapour before ignition */
emit(t,-4,4.4,74,2.2,3.4,500,function(P,b,a,f){var s=P[2]<.5?1:-1;var vx=RX+s*24*RS,vy=-40-(s>0?780:470)*RS-h;var x=vx+s*46*(1-Math.exp(-a))-34*a,y=vy+16*a+12*a*a;if(!vis(y,40))return;circ(x,y,5+30*f+8*P[3],[234,230,244],.5*(1-f)*cl(a*4))});
/* exhaust: smoke billows out of the flame trench, then a trail as it climbs */
function smoke(back){emit(t,4.2,9.6,170,3.4,6.6,2000,function(P,b,a,f){if((P[5]<.45)!=back)return;var hb=hAlt(b);var nx=RX,ny=-40-hb+26*RS;var s=2200*.22*(1-Math.exp(-a/.22)),d0=-ny,q=P[3],x,y,r,heat;
if(s>d0){var rr=s-d0,side=P[2]<.5?-1:1;x=nx+side*(rr*1.3+230*q*Math.sqrt(a))-14*a;y=-14-rr*.12-(26+56*q)*a;r=(26+150*(1-Math.exp(-a/1.4)))*(.5+.6*P[4]);heat=Math.exp(-a/.45)}
else{x=nx+(q-.5)*.3*s-26*a;y=ny+s+4*a;r=(14+80*(1-Math.exp(-a/1.1)))*(.5+.6*P[4]);heat=.4*Math.exp(-a/.35)}
if(!vis(y,r))return;var al=.92*cl((1-f)*2.4);circ(x,y,r,mix(SMOKES,ORANGE,heat*.6),al);circ(x-r*.16,y-r*.2,r*.8,mix(SMOKEL,AMBER,heat),al)})}
function wclouds(front){for(var i=0;i<WCD.length;i++){var c=WCD[i];if(c.f!=front||!vis(c.y,160*c.s))continue;puffs(c.x,c.y,c.s,c.p,mix([150,128,176],[104,104,160],k),mix([255,222,206],[236,236,246],k),front?.9:.95)}}
wclouds(false);smoke(true);
g.save();g.translate(RX,-40-h);g.scale(RS,RS);stack({});
var ig=eo(seg(t,4.2,4.7));if(ig>0){g.beginPath();g.rect(-500,-1200,1000,(40+h)/RS+1200);g.clip();flame(ig*(360+70*seg(t,5,7)),70,t,24,seg(t,6,8))}
g.restore();
emit(t,4.2,9.6,260,.25,.5,1000,function(P,b,a,f){var nx=RX+(P[2]-.5)*34,ny=-40-hAlt(b)+26*RS;var s=2600*.3*(1-Math.exp(-a/.3)),d0=-ny,x,y;
if(s>d0){var side=P[3]<.5?-1:1;x=nx+side*(s-d0)*1.25;y=-12-(s-d0)*.07}else{x=nx+(P[3]-.5)*.22*s;y=ny+s}
if(!vis(y,40))return;circ(x,y,(9+30*f)*(.7+.5*P[4]),fireCol(f),.92*(1-f))});
smoke(false);wclouds(true);
g.setTransform(1,0,0,1,0,0);
streaks(t,180,rise*Z*.9,0,1,.35*seg(t,6.4,8),WHITE,.3);
/* foreground grass and birds */
for(var i=0;i<GRASS.length;i++){var q=GRASS[i];var by=gy+110+q[1]*260+rise*Z*.3;if(by>H+40)continue;var bx=q[0]+(cx-540)*-.3,hh=18+30*q[2];
poly([bx-8,by,bx-2,by-hh,bx+1,by,bx+4,by-hh*.8,bx+9,by,bx+14,by-hh*.6,bx+16,by],[22,22,36],1)}
for(var i=0;i<26;i++){var P=PS[i+300];var tt=t-4.4-P[2]*.5;if(tt<=0)continue;var bx=60+P[0]*380-(120+170*P[0])*tt,by=gy-14-P[1]*40-(160+120*P[1])*tt+rise*Z*.4;if(by<-20||bx<-20)continue;var w=Math.sin(t*19+i*1.7)*7;
g.strokeStyle=rgba([30,30,48],1);g.lineWidth=3;g.beginPath();g.moveTo(bx-10,by-w);g.lineTo(bx,by);g.lineTo(bx+10,by-w);g.stroke();ELEMENTS++}}

/* ================= 2. climbing through the clouds, Max Q (9.3 - 13) ================= */
var ACL=[];for(var i=0;i<46;i++){var par=.5+R()*1.25;ACL.push({p:mkCloud(13,420,70,30,66),par:par,Tc:9.1+R()*2.1,mx:R()*1300-110,my:200+R()*1500,s:.7+par*.5})}
function aF(t){var d=t-9;return 1500*d+260*d*d}
function ascent(t){var k=seg(t,9.2,13.2),th=lerp(.05,.42,eio(seg(t,9.3,13.4))),q=Math.sin(Math.PI*seg(t,10.3,12.9));
vgrad(0,H,[0,mix([22,32,70],[7,11,28],k),.55,mix([66,72,132],[16,26,62],k),1,mix([128,120,172],[36,54,108],k)]);
stars(seg(t,11.4,13)*.6,t,300);
var fx=-Math.sin(th),fy=Math.cos(th),F=aF(t);
function clouds(near){for(var i=0;i<ACL.length;i++){var c=ACL[i];if((c.par>1.25)!=near)continue;var d=(F-aF(c.Tc))*c.par;var x=c.mx+fx*d,y=c.my+fy*d;if(y<-300||y>H+300||x<-500||x>W+500)continue;
g.save();g.translate(x,y);g.scale(1,.6);puffs(0,0,c.s,c.p,mix([150,146,192],[120,130,180],k),[240,236,244],near?.95:.9);g.restore()}}
clouds(false);
streaks(t,150,F*.6,fx,fy,.08+.22*q,WHITE,.2+.3*q);
var C=[540,1040],SC=.5;
emit(t,8.6,13.2,230,1.2,1.8,2300,function(P,b,a,f){var tb=lerp(.05,.42,eio(seg(b,9.3,13.4)));var dx=-Math.sin(tb),dy=Math.cos(tb);var s=330+700*a,sp=(P[2]-.5)*(50+150*a);var x=C[0]+dx*s-dy*sp,y=C[1]+dy*s+dx*sp;if(y>H+120)return;var r=(24+70*f)*(.6+.6*P[3]);circ(x,y,r,mix([170,160,186],[120,124,170],k),.75*(1-f));circ(x-r*.15,y-r*.2,r*.78,mix(SMOKEL,[214,214,232],k),.75*(1-f))});
/* plume: particles leave the nozzle and stream away behind the rocket */
emit(t,9.0,13.2,520,.7,1.1,1400,function(P,b,a,f){var tb=lerp(.05,.42,eio(seg(b,9.3,13.4)));var dx=-Math.sin(tb),dy=Math.cos(tb);var s=263+1800*.12*(1-Math.exp(-a/.12))+820*a;var sp=(P[2]-.5)*(40+260*a);
var x=C[0]+dx*s-dy*sp,y=C[1]+dy*s+dx*sp;if(y>H+80)return;circ(x,y,(8+44*f)*(.6+.6*P[3]),f<.25?fireCol(f*2.5):mix(mix(AMBER,SMOKEL,.6),SMOKES,(f-.25)/.75),.85*(1-f))});
g.save();g.translate(C[0],C[1]);g.rotate(th);g.scale(SC,SC);g.translate(0,500);
flame((420-150*q)*(1+k*.5),70*(1+k*1.2),t,24,1);stack({});
if(q>.02){poly([-34,-790,34,-790,150,-480,-150,-480],WHITE,.16*q);
emit(t,10,13,240,.5,.9,2600,function(P,b,a,f){var s=P[2]<.5?-1:1;var x=s*(34+130*f)*(.4+.7*P[3]),y=-800+f*330+(P[4]-.5)*20;circ(x,y,10+26*f,WHITE,.5*q*(1-f))});
for(var j=0;j<4;j++){var ay=-1020-j*34,ax=70+j*44;g.strokeStyle=rgba(WHITE,.55*q*(1-j*.2));g.lineWidth=5;g.beginPath();g.moveTo(-ax,ay+120+j*24);g.quadraticCurveTo(0,ay-30,ax,ay+120+j*24);g.stroke();ELEMENTS++}}
g.restore();
clouds(true)}

/* ================= 3. wide: gravity turn over the curve of the Earth (12.75 - 16) ================= */
function bz(p,u){var v=1-u;return [v*v*v*p[0]+3*v*v*u*p[2]+3*v*u*u*p[4]+u*u*u*p[6],v*v*v*p[1]+3*v*v*u*p[3]+3*v*u*u*p[5]+u*u*u*p[7]]}
function bzd(p,u){var v=1-u;return [3*v*v*(p[2]-p[0])+6*v*u*(p[4]-p[2])+3*u*u*(p[6]-p[4]),3*v*v*(p[3]-p[1])+6*v*u*(p[5]-p[3])+3*u*u*(p[7]-p[5])]}
function wPath(t){var z=eio(seg(t,12.75,16));var Rr=lerp(3400,1500,z),LT=lerp(1620,1470,z),cy=LT+Rr;var y0=cy-Math.sqrt(Rr*Rr-340*340);return {Rr:Rr,cy:cy,p:[200,y0,200,y0-520,330,y0-800,1010,y0-840]}}
function wProg(t){return lerp(.2,.84,eio(seg(t,12.75,16)))}
function wide(t){var k=seg(t,12.8,15.2),W0=wPath(t),p=W0.p;
vgrad(0,W0.cy-W0.Rr,[0,mix([14,22,54],INK,k),.7,mix([32,52,112],NAVY,k),1,mix([80,120,190],[40,74,150],k)]);
stars(.2+.7*seg(t,13,14.6),t,520);
limb(540,W0.cy,W0.Rr,t,40,1);
var u=wProg(t);
for(var i=0;i<=90;i++){var uu=u*i/90;var q=bz(p,uu);var age=1-i/90;circ(q[0],q[1],3+5*age+6*Math.max(0,1-uu*4),mix(SMOKEL,[150,170,210],age),.35+.4*(1-age))}
for(var uu=u+.03;uu<1;uu+=.028){var q=bz(p,uu),d=bzd(p,uu),n=Math.hypot(d[0],d[1]);line(q[0]-d[0]/n*7,q[1]-d[1]/n*7,q[0]+d[0]/n*7,q[1]+d[1]/n*7,ICE,.75,4)}
arrow(p[6]+6,p[7],34,Math.PI/2,ICE,6,.8);
emit(t,12.6,16,160,.8,1.3,3300,function(P,b,a,f){var ub=wProg(b);var q=bz(p,ub),d=bzd(p,ub),n=Math.hypot(d[0],d[1]);var tx=d[0]/n,ty=d[1]/n;var s=18+70*a,sp=(P[2]-.5)*(6+40*a);circ(q[0]-tx*s-ty*sp,q[1]-ty*s+tx*sp,(3+12*f),f<.2?fireCol(f*3):mix(AMBER,SMOKEL,cl(f*2)),.85*(1-f))});
var q=bz(p,u),d=bzd(p,u),n=Math.hypot(d[0],d[1]),ang=Math.atan2(d[1],d[0])+Math.PI/2;
g.save();g.translate(q[0],q[1]);g.rotate(ang);g.scale(.21,.21);g.translate(0,500);flame(380,90,t,24,0);stack({});g.restore();
var va=seg(t,13.6,14.2);arrow(q[0],q[1],230*d[0]/n*va+8,Math.PI/2,ORANGE,12,va);arrow(q[0],q[1],-230*d[1]/n*va+8,0,ICE,12,va*.9)}

/* ================= 4. stage separation (15.75 - 19.2) ================= */
function sep(t){vgrad(0,H,[0,INK,.6,[10,16,38],1,[20,34,76]]);stars(.85,t,520);
limb(260-36*(t-15.6),1520+1700,1700,t,90,1);
var th=.42,S=.72,ts=16.55,ti=17.3;
var sU=t<ts?0:26*(t-ts)+(t>ti?420*(t-ti)*(t-ti):0),sB=t<ts?0:120*(t-ts)+70*(t-ts)*(t-ts),bR=t<16.9?0:-.34*Math.pow(t-16.9,1.6);
g.save();g.translate(540,1010);g.rotate(th);g.scale(S,S);g.translate(0,sU*.5);
/* booster burning in thin air: the plume balloons wide, then cuts off */
emit(t,15.4,16.3,300,.5,.8,3600,function(P,b,a,f){var s=1500*.1*(1-Math.exp(-a/.1))+700*a,sp=(P[2]-.5)*2*s*.95;circ(sp,606+s+sB,10+.28*s,f<.2?fireCol(f*3):mix(AMBER,[255,226,196],f),.8*(1-f)*(1-f))});
g.save();g.translate(0,580+sB-290);g.rotate(bR);g.translate(0,290);
if(t<16.3)flame(260,120,t,24,0);
booster({fins:seg(t,17.6,18.2)});
emit(t,16.95,18.4,110,.5,.8,3900,function(P,b,a,f){if(((b-16.95)%.45)>.16)return;var s=P[2]<.5?-1:1;circ(s*(34+170*(1-Math.exp(-a/.18))),-548+(P[3]-.5)*40*(1+a*3),5+30*f,WHITE,.7*(1-f))});
g.restore();
/* upper stage lights and pulls away */
emit(t,ti,19.3,240,.5,.9,100,function(P,b,a,f){var sb=26*(b-ts)+420*(b-ti)*(b-ti);var s=1700*.12*(1-Math.exp(-a/.12))+500*a,sp=(P[2]-.5)*(30+.6*s);circ(sp,-sb+90+s,6+.1*s,f<.15?fireCol(f*3):mix([255,206,150],[200,206,236],f),.5*(1-f)*(1-f))});
g.save();g.translate(0,-sU);var ig=seg(t,ti,ti+.25);if(ig>0)flame(ig*(520+30*Math.sin(t*9)),70,t,90,0);upper({hot:ig});g.restore();
/* separation: ice and frost flakes from the interstage */
if(t>ts)for(var i=0;i<280;i++){var P=PS[(i+1700)%4096];var a=t-ts;var vx=(P[2]-.5)*340,vy=(P[3]-.5)*260+40;var x=(P[4]-.5)*56+vx*a,y=-6+vy*a+sB*.4;var al=1-seg(a,1.6+P[5],2.6+P[5]);if(al<=0)continue;
g.save();g.translate(x,y);g.rotate(P[0]*6+a*(P[1]-.5)*8);rect(-2.5,-5,5,10,P[5]<.5?WHITE:ICE,.85*al);g.restore()}
g.restore()}

/* ================= 5. payload release (18.95 - 21.2) ================= */
function payload(t){vgrad(0,H,[0,INK,.55,[10,16,38],1,[22,38,84]]);stars(.85,t,520);
limb(540,1360+2100,2100,t,-900,0);
var fo=eio(seg(t,19.3,20.1)),pd=t>19.9?80*(t-19.9)+30*(t-19.9)*(t-19.9):0,un=eo(seg(t,20.15,20.9));
g.save();g.translate(400+22*(t-18.95),1000);g.rotate(Math.PI/2-.14);g.scale(1.3,1.3);g.translate(0,165);
upper({fairing:fo,pay:1,pd:pd,pr:.18*Math.max(0,t-19.9),un:un});
emit(t,19.9,20.6,140,.4,.7,1200,function(P,b,a,f){var s=P[2]<.5?-1:1;circ(s*(30+200*(1-Math.exp(-a/.2))),-150+(P[3]-.5)*30,4+22*f,WHITE,.6*(1-f))});
g.restore()}

/* ================= 6. orbit is falling and missing (20.95 - 24.6) ================= */
var TRJ=[],SURF=.77;[.6,.75,.88,1].forEach(function(v){var x=0,y=-1,vx=v,vy=0,pts=[[0,-1]],dt=.002,acc=0,lx=0,ly=-1;for(var s=0;s<5000;s++){var r=Math.sqrt(x*x+y*y);var r3=r*r*r;vx-=x/r3*dt;vy-=y/r3*dt;x+=vx*dt;y+=vy*dt;acc+=Math.hypot(x-lx,y-ly);lx=x;ly=y;if(acc>=.032){pts.push([x,y]);acc=0}if(Math.sqrt(x*x+y*y)<SURF){pts.push([x,y]);break}if(v==1&&s*dt>6.283)break}TRJ.push(pts)});
var TST=[21.5,22.05,22.6,23.15],TDU=[.55,.55,.6,1.25];
function orbit(t){vgrad(0,H,[0,INK,1,[14,20,46]]);stars(.9,t,720);
var z=eio(seg(t,20.95,21.9)),Rg=lerp(1500,320,z),cy=lerp(2600,1080,z),cx=540,Ro=Rg*1.3;
globe(cx,cy,Rg,t*.25,t);
if(z>.98){for(var i=0;i<4;i++){var pts=TRJ[i];var pr=seg(t,TST[i],TST[i]+TDU[i]);if(pr<=0)continue;var n=Math.floor(pr*(pts.length-1));var done=pr>=1&&i<3;var fade=i<3?1-.55*seg(t,TST[i]+TDU[i]+.3,TST[i]+TDU[i]+.8):1;var col=i<3?[255,190,140]:ICE;
for(var j=0;j<=n;j+=1){if(i<3||j%2==0)circ(cx+pts[j][0]*Ro,cy+pts[j][1]*Ro,i<3?3.2:4,col,.85*fade)}
var hd=pts[n];if(!done&&i<3)circ(cx+hd[0]*Ro,cy+hd[1]*Ro,9,ORANGE,1);
if(done){var e=t-(TST[i]+TDU[i]);for(var k=0;k<10;k++){var an=k/10*6.283;circ(cx+hd[0]*Ro+Math.cos(an)*(6+60*eo(e*2)),cy+hd[1]*Ro+Math.sin(an)*(6+60*eo(e*2)),4,ORANGE,1-cl(e*1.6))}}}
var so=t<TST[3]?0:(t-TST[3])/TDU[3]*6.2832;var sxp=cx+Math.sin(so)*Ro,syp=cy-Math.cos(so)*Ro;
if(t>=TST[3]){for(var k=0;k<24;k++){var a2=so-k*.035;circ(cx+Math.sin(a2)*Ro,cy-Math.cos(a2)*Ro,6-k*.2,ICE,.6*(1-k/24))}}
g.save();g.translate(sxp,syp);g.rotate(so);rect(-9,-7,18,14,[220,222,230]);rect(-34,-4,22,8,[52,80,150]);rect(12,-4,22,8,[52,80,150]);g.restore();
arrow(cx,cy-Ro-30,90*seg(t,21.2,21.6)*(t<TST[3]?1:1-seg(t,TST[3],TST[3]+.3)),Math.PI/2,ORANGE,10,1)}}

/* ================= 7. the booster flips around (24.3 - 25.8) ================= */
function flip(t){vgrad(0,H,[0,[8,12,30],.55,[20,32,72],1,[44,70,130]]);stars(.55,t,720);
limb(540-60*(t-24.3),1600+2400,2400,t,260,.9);
var bx=580-34*(t-24.3),by=980,S=.78;function rot(tt){return .42+Math.PI*eio(seg(tt,24.4,25.3))}
emit(t,24.0,25.9,260,1,1.6,2200,function(P,b,a,f){var r=rot(b),ly=-P[3]*500-40,lx=P[2]<.5?-30:30;var c=Math.cos(r),s=Math.sin(r);var x=bx+(lx*c-ly*s)*S+(P[2]-.5)*120*a,y=by-290*S+(lx*s+ly*c)*S+290*S*0+60*a;rect(x,y,4,4,ICE,.8*(1-f))});
emit(t,24.35,25.3,170,.25,.42,2900,function(P,b,a,f){var r=rot(b),sd=P[2]<.5?-1:1;var lx=sd*(34+150*(1-Math.exp(-a/.12))),ly=-560+290+(P[3]-.5)*50*(1+a*2);var c=Math.cos(r),s=Math.sin(r);circ(bx+(lx*c-ly*s)*S,by+(lx*s+ly*c)*S,5+34*f,WHITE,.75*(1-f))});
var bb=seg(t,25.25,25.4);
emit(t,25.25,25.9,260,.3,.55,3100,function(P,b,a,f){var r=rot(b);var ly=290+26+1600*.1*(1-Math.exp(-a/.1))+500*a,lx=(P[2]-.5)*(20+.5*(ly-316));var c=Math.cos(r),s=Math.sin(r);circ(bx+(lx*c-ly*s)*S,by+(lx*s+ly*c)*S,(8+30*f),fireCol(f),.85*(1-f))});
g.save();g.translate(bx,by);g.rotate(rot(t));g.scale(S,S);g.translate(0,290);if(bb>0)flame(bb*280,80,t,24,0);booster({fins:seg(t,24.9,25.3),soot:.2});g.restore()}

/* ================= 8. entry burn (25.65 - 27.1) ================= */
var ECL=[];for(var i=0;i<22;i++){var par=.6+R()*1.2;ECL.push({p:mkCloud(10,340,70,34,70),par:par,Tc:26.6+R()*.6,mx:R()*1300-110,my:200+R()*1500,s:.8+par*.5})}
function eF(t){return 2200*(t-25.5)}
function entry(t){var k=seg(t,25.6,27.1);
vgrad(0,H,[0,mix([10,16,40],[30,40,86],k),.55,mix([28,44,96],[96,92,150],k),1,mix([62,84,150],[226,150,128],k)]);
stars((1-k)*.45,t,520);
streaks(t,220,eF(t),0,-1,.18+.14*k,WHITE,.45);
var bx=540+Math.sin(t*2.3)*8,by=1080,S=.8;
function plumeP(front){emit(t,25.6,26.95,560,.4,.7,700,function(P,b,a,f){if((P[5]<.5)!=front)return;var kx=(Math.floor(P[2]*3)-1)*19*S;var side=P[3]<.5?-1:1;
var x=bx+kx+side*(14+320*a*(.3+P[4])),y=by+26*S+150*(1-Math.exp(-a/.1))-980*a*a-60*a;circ(x,y,(10+46*f)*(.6+.6*P[4]),f<.3?fireCol(f*2):mix(ORANGE,[90,70,80],(f-.3)/.7),.88*(1-f))})}
plumeP(false);
emit(t,25.6,27,420,.5,.9,1900,function(P,b,a,f){var x=bx+(P[2]-.5)*(80+500*a),y=by+40-1300*a*(.6+.6*P[3]);rect(x,y,3,9,AMBER,.9*(1-f))});
for(var i=0;i<3;i++)ell(bx,by-10,(60+i*26)*S,(36+i*20)*S,0,ORANGE,.22-i*.06);
g.save();g.translate(bx,by);g.rotate(.02*Math.sin(t*3));g.scale(S,S);var eb=seg(t,25.6,25.8)*(1-seg(t,26.8,26.95));flame(eb*170,74,t,24,0);booster({fins:1,soot:.55});
for(var s=-1;s<=1;s+=2){g.save();g.translate(s*50,-499);g.rotate(s*.12*Math.sin(t*5));rect(-24,-2,48,4,STEEL);g.restore()}g.restore();
plumeP(true);
for(var i=0;i<ECL.length;i++){var c=ECL[i];var d=(eF(t)-eF(c.Tc))*c.par;var y=c.my-d,x=c.mx;if(y<-300||y>H+300)continue;puffs(x,y,c.s,c.p,[176,170,204],[246,240,244],.95)}}

/* ================= 9. landing on the ship, then the facts (26.9 - 33) ================= */
var HZ=980,DECK=1392,LS=.58;
var WCL=[];for(var i=0;i<20;i++)WCL.push({x:R()*1500-200,y:420+R()*480,p:mkCloud(12,380,40,24,48),s:.45+R()*.6});
function lY(t){return DECK-8-106*LS-1750*Math.pow(1-eo(seg(t,26.9,28.9)),1.15)}
function land(t){var Z=lerp(1,1.06,eio(seg(t,28.6,33)));g.setTransform(Z,0,0,Z,560-560*Z,1240-1240*Z);
vgrad(0,HZ,[0,[30,40,88],.5,[104,94,150],.88,[236,150,118],1,[255,202,152]]);stars(.35,t,120);
for(var i=5;i>0;i--)circ(210,HZ-26,46+i*34,SUN,.07);circ(210,HZ-26,46,SUN,1);
for(var i=0;i<WCL.length;i++){var c=WCL[i];var x=((c.x+t*8*c.s)%1600+1600)%1600-260;g.save();g.translate(x,c.y);g.scale(1,.45);puffs(0,0,c.s,c.p,mix([96,82,132],DAWN2,.35),mix(DAWN3,DAWN4,.35),.9);g.restore()}
vgrad(HZ,H,[0,[110,102,150],.25,[60,70,120],1,[18,30,62]],1);
for(var r=0;r<48;r++){var u=r/48,y=HZ+4+940*Math.pow(u,1.7),ps=.2+u*1.4;for(var j=0;j<13;j++){var P=PS[(r*13+j+900)%4096];var x=((P[0]*1300+t*(14+30*u)*(P[1]<.5?-1:1))%1300+1300)%1300-110;line(x,y,x+(14+60*ps)*(.5+P[2]),y,mix([150,140,190],[90,110,160],u),.35+.25*P[3],1.4+2.2*ps)}}
for(var i=0;i<130;i++){var P=PS[i+1300];var yy=HZ+3+Math.pow(P[1],1.6)*700;rect(210+(P[0]-.5)*(30+yy*.55-HZ*.55)-6,yy,8+30*P[1],2+2*P[1],SUN,.3+.55*Math.abs(Math.sin(t*2.4+i)))}
var bob=Math.sin(t*1.1)*4,sr=.008*Math.sin(t*1.3),SX=560;
g.save();g.translate(SX,DECK+bob);g.rotate(sr);g.translate(-SX,-DECK);
rect(SX-380,DECK+70,760,26,[12,18,40],.45);
poly([SX-400,DECK+8,SX+400,DECK+8,SX+380,DECK+70,SX-380,DECK+70],[26,30,44]);rect(SX-396,DECK+8,792,8,[62,64,86]);
poly([SX-400,DECK+8,SX+400,DECK+8,SX+372,DECK-22,SX-372,DECK-22],[128,128,146]);
g.strokeStyle=rgba(ORANGE,.9);g.lineWidth=5;g.beginPath();g.ellipse(SX,DECK-7,170,13,0,0,6.2832);g.stroke();g.beginPath();g.ellipse(SX,DECK-7,92,7,0,0,6.2832);g.stroke();ELEMENTS+=2;
for(var s=-1;s<=1;s+=2){rect(SX+s*388-(s>0?36:0),DECK-70,36,58,[44,48,64]);rect(SX+s*388-(s>0?36:0),DECK-70,36,6,[70,74,96]);line(SX+s*370,DECK-70,SX+s*370,DECK-130,[44,48,64],1,4);circ(SX+s*370,DECK-132,5,ORANGE,.5+.5*Math.sin(t*3+s))}
var ly=lY(t),bxx=SX+80*Math.pow(1-eo(seg(t,26.9,28.9)),1.2),tl=.07*Math.pow(1-eo(seg(t,26.9,28.7)),1.3);var landed=t>=28.9;var nzy=ly+26*LS;
/* landing burn: flame hits the deck and spreads, then steam drifts */
function lsmoke(back){emit(t,27.45,29,130,2,4.2,2500,function(P,b,a,f){if((P[5]<.45)!=back)return;var nb=lY(b)+26*LS,d0=DECK-10-nb,s=1800*.2*(1-Math.exp(-a/.2)),x,y,r,heat;if(d0>300)return;var xb=SX+80*Math.pow(1-eo(seg(b,26.9,28.9)),1.2);
if(s>d0){var rr=s-d0,side=P[2]<.5?-1:1;x=xb+side*(rr*1.5+160*P[3]*Math.sqrt(a))+30*a;y=DECK-14-rr*.1-(20+40*P[3])*a;r=(20+90*(1-Math.exp(-a/1.2)))*(.5+.6*P[4]);heat=Math.exp(-a/.4)}
else{x=xb+(P[3]-.5)*.3*s+20*a;y=nb+s-10*a;r=(12+60*(1-Math.exp(-a/1)))*(.5+.6*P[4]);heat=.6*Math.exp(-a/.4)}
var al=.9*cl((1-f)*2.2);circ(x,y,r,mix(SMOKES,ORANGE,heat*.6),al);circ(x-r*.16,y-r*.2,r*.8,mix(SMOKEL,AMBER,heat),al)})}
lsmoke(true);
g.save();g.translate(bxx,ly+(landed?bob*0:0));g.rotate(tl);g.scale(LS,LS);var lb=seg(t,27.45,27.6)*(1-seg(t,28.85,29));if(lb>0){g.save();g.beginPath();g.rect(-600,-1200,1200,(DECK-10-ly)/LS+1200);g.clip();flame(lb*(300+40*Math.sin(t*13)),40,t,24,1);g.restore()}
booster({fins:1,legs:seg(t,27.9,28.5),soot:.85});g.restore();
emit(t,27.45,28.95,240,.2,.4,3500,function(P,b,a,f){var nb=lY(b)+26*LS,d0=DECK-10-nb,s=2400*.25*(1-Math.exp(-a/.25)),xb=SX+80*Math.pow(1-eo(seg(b,26.9,28.9)),1.2),x,y;
if(s>d0){var side=P[3]<.5?-1:1;x=xb+side*(s-d0)*1.4;y=DECK-14-(s-d0)*.05}else{x=xb+(P[3]-.5)*.2*s;y=nb+s}circ(x,y,(6+20*f)*(.7+.5*P[4]),fireCol(f),.9*(1-f))});
lsmoke(false);
g.restore();
for(var i=0;i<90;i++){var P=PS[i+2600];var x=SX-390+((P[0]*800+t*30*(P[1]-.5))%800+800)%800;circ(x,DECK+72+bob+Math.sin(t*3+i)*3,3+5*P[2],WHITE,.35+.4*P[3])}
var fs=seg(t,29.6,30.3);if(fs>0){g.setTransform(1,0,0,1,0,0);var gr=g.createLinearGradient(0,0,0,1200);gr.addColorStop(0,rgba(INK,.72*fs));gr.addColorStop(.75,rgba(INK,.4*fs));gr.addColorStop(1,rgba(INK,0));g.fillStyle=gr;g.fillRect(0,0,W,1200);ELEMENTS++}}

/* ---------- captions and readouts (DOM), driven by the seek ---------- */
var CAP=[].slice.call(document.querySelectorAll('[data-in]'));
var SPD=[[5,0],[6,50],[7.5,230],[9,560],[10.5,1050],[11.6,1500],[13,2700],[14.5,5100],[16.2,8300],[17.3,8300],[18.3,14500],[19.2,27600],[19.5,28000]];
var ALT=[[5,0],[7,.3],[9,2.4],[11.6,12],[13,24],[14.5,45],[16.2,70],[17.3,82],[19.3,200]];
function key(t,K){if(t<=K[0][0])return K[0][1];for(var i=1;i<K.length;i++)if(t<=K[i][0])return lerp(K[i-1][1],K[i][1],(t-K[i-1][0])/(K[i][0]-K[i-1][0]));return K[K.length-1][1]}
function fmt(n){return String(n).replace(/\B(?=(\d{3})+(?!\d))/g,',')}
function captions(t){CAP.forEach(function(el){var a=+el.dataset.in,b=+el.dataset.out;var o=Math.min(seg(t,a,a+.35),1-seg(t,b-.3,b));el.style.opacity=o.toFixed(3);el.style.transform='translateY('+((1-eo(seg(t,a,a+.5)))*30).toFixed(1)+'px)'});
var s=document.getElementById('spd');if(s)s.textContent=fmt(Math.round(key(t,SPD)/10)*10);
var a=document.getElementById('alt');if(a){var v=key(t,ALT);a.textContent=v<10?v.toFixed(1):fmt(Math.round(v))}}

var SCN=[[0,pad],[9.3,ascent],[12.75,wide],[15.75,sep],[18.95,payload],[20.95,orbit],[24.3,flip],[25.65,entry],[26.9,land]],XF=.3;
var draw=function(t){ELEMENTS=0;
for(var i=0;i<SCN.length;i++){var s0=SCN[i][0],s1=i+1<SCN.length?SCN[i+1][0]+XF:1e9;if(t<s0||t>=s1)continue;GA=i?eio(seg(t,s0,s0+XF)):1;g.setTransform(1,0,0,1,0,0);SCN[i][1](t)}
GA=1;g.setTransform(1,0,0,1,0,0);captions(t);window.__rfElements=ELEMENTS};
`;

const CSS = `
.cap{position:absolute;left:84px;right:84px;opacity:0;color:#F4F2EE;font-family:"Inter Display",Inter,sans-serif;letter-spacing:-.02em;text-align:center}
.cap .bx{display:inline-block;padding:20px 32px 24px;border-radius:28px;background:rgba(7,11,24,.6)}
.cap .k{font:500 34px/1.2 "JetBrains Mono","DejaVu Sans Mono",monospace;color:#B9C3D6;letter-spacing:0;margin-bottom:12px}
.cap h2{margin:0;font-size:86px;line-height:1.02;font-weight:700}
.cap p{margin:0;font-size:56px;line-height:1.14;font-weight:600}
.cap b{color:#FF8A3D;font-weight:700}.cap i{font-style:normal;color:#96CEFF}
.hud{position:absolute;left:84px;right:84px;top:250px;opacity:0;display:flex;gap:16px;justify-content:center;font-family:"JetBrains Mono","DejaVu Sans Mono",monospace;color:#F4F2EE}
.hud div{display:flex;align-items:baseline;gap:12px;padding:14px 22px;border-radius:18px;background:rgba(7,11,24,.66)}
.hud span{font-size:34px;color:#B9C3D6}.hud strong{font-size:40px;font-weight:600;min-width:4ch;text-align:right}.hud em{font-style:normal;font-size:34px;color:#B9C3D6}
.lbl{position:absolute;opacity:0;font:600 36px/1 "Inter Display",Inter,sans-serif;color:#0B1226;padding:12px 20px;border-radius:14px;background:#96CEFF}
.facts{position:absolute;left:84px;right:84px;top:300px;display:grid;gap:22px}
.fact{opacity:0;display:flex;justify-content:space-between;align-items:baseline;padding:26px 34px;border-radius:24px;background:rgba(7,11,24,.7);border:2px solid rgba(244,242,238,.14);color:#F4F2EE;font-family:"Inter Display",Inter,sans-serif}
.fact span{font-size:40px;color:#C4CCDA}.fact strong{font-size:60px;font-weight:700;letter-spacing:-.03em}
.brand{position:absolute;left:0;right:0;top:1520px;text-align:center;opacity:0;font:500 34px/1 "JetBrains Mono","DejaVu Sans Mono",monospace;color:#E4E8F0}
.brand span{display:inline-block;padding:14px 24px;border-radius:16px;background:rgba(7,11,24,.6)}
`;

const HTML = `
<div class="cap" style="top:300px" data-in="0.3" data-out="2.4"><div class="bx"><div class="k">How a rocket reaches orbit</div><h2>Space is only<br>100 km up</h2></div></div>
<div class="cap" style="top:300px" data-in="2.4" data-out="4.3"><div class="bx"><p>But to <i>stay</i> there,<br>you need to go <b>sideways, fast</b></p></div></div>
<div class="cap" style="top:372px" data-in="4.3" data-out="5.25"><div class="bx"><h2>Ignition</h2></div></div>
<div class="cap" style="top:372px" data-in="5.25" data-out="6.8"><div class="bx"><h2>Liftoff</h2></div></div>
<div class="cap" style="top:372px" data-in="6.8" data-out="9.4"><div class="bx"><p>First it climbs straight up,<br>out of the thickest air</p></div></div>
<div class="cap" style="top:372px" data-in="9.5" data-out="10.5"><div class="bx"><p>Lighter and faster<br>every second</p></div></div>
<div class="cap" style="top:372px" data-in="10.5" data-out="12.7"><div class="bx"><p><b>Max Q:</b> the air<br>pushes hardest</p><div class="k" style="margin:14px 0 0">The engines throttle back to ride it out</div></div></div>
<div class="cap" style="top:372px" data-in="12.9" data-out="14.5"><div class="bx"><p>Then it tips over to go<br>sideways: the <i>gravity turn</i></p></div></div>
<div class="cap" style="top:372px" data-in="14.5" data-out="15.9"><div class="bx"><p>The sky turns black.<br>Earth's curve appears.</p></div></div>
<div class="cap" style="top:372px" data-in="16" data-out="17.5"><div class="bx"><p><b>Stage separation.</b><br>The booster's job is done.</p></div></div>
<div class="cap" style="top:372px" data-in="17.5" data-out="19.1"><div class="bx"><p>The upper stage lights up<br>and keeps pushing sideways</p></div></div>
<div class="cap" style="top:300px" data-in="19.4" data-out="21"><div class="bx"><p>Engine off.<br>The payload is released.</p></div></div>
<div class="cap" style="top:300px" data-in="21.2" data-out="24.3"><div class="bx"><p>Orbit = falling around the Earth<br><i>and always missing it</i></p></div></div>
<div class="lbl" style="left:600px;top:590px" data-in="23.6" data-out="24.3">7.8 km/s sideways</div>
<div class="cap" style="top:300px" data-in="24.45" data-out="25.8"><div class="bx"><p>Meanwhile, the booster<br>flips around</p></div></div>
<div class="cap" style="top:300px" data-in="25.8" data-out="27.1"><div class="bx"><p><b>Entry burn</b> to slow down<br>before the thick air</p></div></div>
<div class="cap" style="top:300px" data-in="27.2" data-out="28.4"><div class="bx"><p>Grid fins steer.<br>Legs unfold.</p></div></div>
<div class="cap" style="top:300px" data-in="28.4" data-out="29.7"><div class="bx"><p><b>Landing burn.</b><br>Touchdown, at sea.</p></div></div>
<div class="hud" data-in="5.3" data-out="19.4"><div><span>Speed</span><strong id="spd">0</strong><em>km/h</em></div><div><span>Altitude</span><strong id="alt">0</strong><em>km</em></div></div>
<div class="facts">
 <div class="fact" data-in="29.9" data-out="33.4"><span>Orbital speed</span><strong>≈ 28,000 km/h</strong></div>
 <div class="fact" data-in="30.3" data-out="33.4"><span>Every second</span><strong>≈ 7.8 km</strong></div>
 <div class="fact" data-in="30.7" data-out="33.4"><span>Low Earth orbit</span><strong>≈ 400 km up</strong></div>
 <div class="fact" data-in="31.1" data-out="33.4"><span>One lap</span><strong>≈ 90 min</strong></div>
</div>
<div class="brand" data-in="31.7" data-out="33.4"><span>Rendered with ReelForge</span></div>
`;

export const ROCKET: FlagshipReel = {
  slug: 'how-a-rocket-reaches-orbit',
  title: 'How a rocket gets to orbit (and lands back)',
  category: 'How it works',
  tags: ['science', 'space', 'explainer', 'rockets', 'physics'],
  description:
    'Liftoff, Max Q, the gravity turn, staging, orbit as falling and missing, and a booster landing at sea, with 1,000+ exhaust, smoke and cloud particles in every frame.',
  prompt:
    'Make a 33-second vertical explainer on how a rocket gets to orbit and how its booster comes back. Use a generic two-stage reusable rocket with no real brand: open on the pad at dawn with the hook that orbit means going sideways fast, then liftoff in a dense smoke plume with a following camera, Max Q, the gravity turn over the curve of the Earth with a live speed readout, stage separation and payload release. Explain orbit as falling around the Earth and always missing it, show the booster flipping, its entry burn and its landing on a ship at sea, and end on four facts: about 28,000 km/h, about 7.8 km/s, about 400 km up, about 90 minutes per lap.',
  duration: DUR,
  music: 'drive',
  html: composition(DUR, HTML, CSS, SCRIPT),
};
