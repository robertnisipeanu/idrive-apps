'use strict';
const scene=require('./scene'),cameras=require('./cameras'),Settings=require('./settings');
const VS='attribute vec3 a_position;attribute vec3 a_normal;attribute vec2 a_texcoord;attribute vec4 a_color;uniform vec3 u_pose;uniform vec3 u_camera;uniform vec4 u_view;uniform vec4 u_map;varying vec2 v_uv;varying vec4 v_color;void main(){vec2 anchor=vec2(0.);if(a_normal.z>.5){vec2 d=(a_normal.xy-u_pose.xy)*u_view.x;float c=cos(u_pose.z),s=sin(u_pose.z),x=d.x*c-d.y*s,z=d.x*s+d.y*c;anchor=vec2(400.+x*700./(z+u_camera.y),u_camera.x+u_camera.z/(z+u_camera.y));anchor.x=400.+(anchor.x-400.)*u_map.x;float dy=anchor.y-u_map.z;anchor.y=u_map.z+min(dy,0.)*u_map.y+max(dy,0.);if(z<15.||z>(a_normal.z>1.5?1000.:450.))anchor=vec2(-5000.);}vec2 p=a_position.xy+anchor;p=(p-vec2(400.,240.))*u_view.y+vec2(400.,240.)+u_view.zw;gl_Position=vec4(p.x/400.-1.,1.-p.y/240.,0.,1.);v_uv=a_texcoord;v_color=a_color;}';
const FS='precision mediump float;uniform sampler2D u_font;varying vec2 v_uv;varying vec4 v_color;void main(){float a=v_uv.x<0.?1.:texture2D(u_font,v_uv).r;gl_FragColor=vec4(v_color.rgb,v_color.a*a);}';
function build(roads,pose,font,traffic,cameraState,settings,guidance){const cfg=settings||Settings.defaults,anchorY=cfg.horizon+40770/cfg.distance,shiftY=anchorY-322;
 const g={positions:[],normals:[],texcoords:[],colors:[],indices:[]};
 function triangle(a,b,c,color,anchor,uv){[a,b,c].forEach((p,i)=>{g.indices.push(g.indices.length);g.positions.push(p[0],p[1],0);g.normals.push.apply(g.normals,anchor||[0,0,0]);g.colors.push.apply(g.colors,color);g.texcoords.push.apply(g.texcoords,uv?uv[i]:[-1,-1]);});}
 function box(x,y,w,h,r,color,anchor){const points=[];for(let corner=0;corner<4;corner++){const cx=x+(corner===0||corner===3?w-r:r),cy=y+(corner<2?h-r:r);for(let j=0;j<=6;j++){const angle=(corner*90+j*15)*Math.PI/180;points.push([cx+Math.cos(angle)*r,cy+Math.sin(angle)*r]);}}for(let i=0;i<points.length;i++)triangle([x+w/2,y+h/2],points[i],points[(i+1)%points.length],color,anchor);}
 function border(x,y,w,h,r,stroke,color,anchor){const outer=[],inner=[];for(let corner=0;corner<4;corner++){const cx=x+(corner===0||corner===3?w-r:r),cy=y+(corner<2?h-r:r);for(let j=0;j<=6;j++){const a=(corner*90+j*15)*Math.PI/180;outer.push([cx+Math.cos(a)*r,cy+Math.sin(a)*r]);inner.push([cx+Math.cos(a)*(r-stroke),cy+Math.sin(a)*(r-stroke)]);}}for(let i=0;i<outer.length;i++){const n=(i+1)%outer.length;triangle(outer[i],outer[n],inner[i],color,anchor);triangle(inner[i],outer[n],inner[n],color,anchor);}}
 function measure(text,size){return Array.from(text).reduce((n,ch)=>n+(font.glyphs[ch]||font.glyphs['?']).advance*size/32,0);}
 function text(value,x,y,size,color,anchor){let at=x;for(const ch of Array.from(value)){const f=font.glyphs[ch]||font.glyphs['?'],scale=size/32,w=f.w*scale,h=f.h*scale,uv=[[f.x/font.w,f.y/font.h],[(f.x+f.w)/font.w,f.y/font.h],[(f.x+f.w)/font.w,(f.y+f.h)/font.h],[f.x/font.w,(f.y+f.h)/font.h]],p=[[at,y],[at+w,y],[at+w,y+h],[at,y+h]];triangle(p[0],p[1],p[2],color,anchor,[uv[0],uv[1],uv[2]]);triangle(p[0],p[2],p[3],color,anchor,[uv[0],uv[2],uv[3]]);at+=f.advance*scale;}}
 function shorten(s,size,max){let value=Array.from(s);while(value.length>1&&measure(value.join(''),size)>max)value.pop();return value.join('');}
 const named=roads.filter(r=>r.name);let current=null;
 named.forEach(r=>{const n=scene.nearest(pose,r.points);if(n&&(!current||n.distance<current.distance))current=Object.assign({road:r},n);});
 // map-only HUD: the current road's name, or no box at all off-road
 const name=current&&current.distance<12?shorten(current.road.name,19,365):'',w=measure(name,19)+28;
 if(name&&cfg.currentStreetVisible!==false){border(400-w/2,351+shiftY,w,34,16,1.5,[.46,.9,1,1]);box(401.5-w/2,352.5+shiftY,w-3,31,14.5,[.025,.34,.47,.86]);text(name,400-measure(name,19)/2,355+shiftY,19,[1,1,1,1]);}
 const used=new Set(current&&current.distance<12?[current.road.name]:[]),candidates=[];
 named.forEach(r=>{if(used.has(r.name))return;let best=null;for(let i=1;i<r.points.length;i++)for(let t=0;t<=1;t+=.25){const a=r.points[i-1],b=r.points[i],p=[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])],q=scene.project(p,pose,cfg);if(q.z<40||q.z>400||q.x<110||q.x>680||q.y<135||q.y>300)continue;const score=Math.abs(q.x-520)+Math.abs(q.y-230)*.3;if(!best||score<best.score)best={point:p,q,score,name:r.name};}if(best)candidates.push(best);});
 candidates.sort((a,b)=>a.score-b.score);const drawn=[];
 for(const c of candidates){if(used.has(c.name)||drawn.some(q=>Math.abs(q.q.y-c.q.y)<52))continue;const label=shorten(c.name,17,270),w=measure(label,17)+18,anchor=[c.point[0],c.point[1],1];border(-w/2,-30,w,29,9,1.3,[.88,.93,.97,1],anchor);box(-w/2+1.3,-28.7,w-2.6,26.4,7.7,[.125,.157,.184,.78],anchor);text(label,-measure(label,17)/2,-26,17,[1,1,1,1],anchor);used.add(c.name);drawn.push(c);if(drawn.length===2)break;}
 // Upright chevron; no raster map pixels are used.
 triangle([400,309+shiftY],[424,337+shiftY],[400,330+shiftY],[1,1,1,1]);triangle([400,309+shiftY],[400,330+shiftY],[376,337+shiftY],[1,1,1,1]);
 triangle([400,313+shiftY],[419,334+shiftY],[400,327+shiftY],[0,.67,.95,1]);triangle([400,313+shiftY],[400,327+shiftY],[381,334+shiftY],[0,.67,.95,1]);
 if(cameraState){
  for(const c of cameraState.icons){const q=scene.project(c.point,pose,cfg);if(q.z<15||q.z>1000||q.x<25||q.x>775||q.y<40||q.y>335)continue;const anchor=[c.point[0],c.point[1],2];
   border(-15,-36,30,30,8,1.5,[1,1,1,1],anchor);box(-13.5,-34.5,27,27,6.5,[.08,.08,.08,.85],anchor);
   border(-9,-27,18,14,2,1.7,[1,.12,.12,1],anchor);box(-4,-30,8,4,1,[1,.12,.12,1],anchor);border(-4,-24,8,8,4,1.6,[1,.12,.12,1],anchor);
   // Compact sign; center visible glyph ink rather than padded atlas quads.
   const limit=cameraState.warning&&cameraState.warning.id===c.id&&/^(\d{1,3}) (km\/h|mph)$/.exec(c.limit||'');
   if(limit){
    const x=q.x+105<=790?30:-105,y=Math.max(10-q.y,Math.min(-58.5,470-q.y-75));
    box(x,y,75,75,37.5,[1,1,1,1],anchor);
    border(x,y,75,75,37.5,5,[.95,0,0,1],anchor);
    const ink={'0':[3,8,19,31],'1':[5,8,14,31],'2':[3,8,18,31],'3':[3,8,19,31],'4':[2,8,19,31],'5':[3,8,19,31],'6':[3,8,19,31],'7':[3,8,19,31],'8':[3,8,19,31],'9':[3,8,19,31],'m':[4,14,27,31],'p':[4,14,19,37],'h':[4,8,18,31]};
    function centered(value,size,cx,cy){let at=0,left=Infinity,right=0,top=Infinity,bottom=0;for(const ch of value){const b=ink[ch];left=Math.min(left,at+b[0]);right=Math.max(right,at+b[2]);top=Math.min(top,b[1]);bottom=Math.max(bottom,b[3]);at+=font.glyphs[ch].advance;}text(value,cx-(left+right)*size/64,cy-(top+bottom)*size/64,size,[0,0,0,1],anchor);}
    centered(limit[1],limit[1].length>2?28:36,x+37.5,y+(limit[2]==='mph'?32:37.5));
    if(limit[2]==='mph')centered('mph',13,x+37.5,y+53);
   }
  }

 }
 // Turn guidance (map HUD): BMW navigation's HUD maneuver (guidance_feed.js), drawn
 // by this layer because the HUD slot shows either BMW's guidance or this scene.
 function guidancePanel(m){
  const cx=95,cy=74,white=[1,1,1,1],dim=[.62,.8,.9,1];
  // no background: only the arrow, distance and road over the map
  const pt=(x,y)=>[cx+x,cy+y];
  function seg(a,b,w,color){const dx=b[0]-a[0],dy=b[1]-a[1],n=Math.hypot(dx,dy)||1,ux=dx/n,uy=dy/n,px=-uy*w/2,py=ux*w/2,a2=[a[0]-ux*w/2,a[1]-uy*w/2],b2=[b[0]+ux*w/2,b[1]+uy*w/2];
   triangle([a2[0]+px,a2[1]+py],[b2[0]+px,b2[1]+py],[b2[0]-px,b2[1]-py],color);triangle([a2[0]+px,a2[1]+py],[b2[0]-px,b2[1]-py],[a2[0]-px,a2[1]-py],color);}
  function line(points,w,color){for(let i=1;i<points.length;i++)seg(points[i-1],points[i],w,color);}
  function head(at,angle,color){const s=Math.sin(angle),c=-Math.cos(angle),tip=[at[0]+s*16,at[1]+c*16],l=[at[0]-c*13,at[1]+s*13],r=[at[0]+c*13,at[1]-s*13];triangle(tip,l,r,color);}
  const ANG={STRAIGHT_ON:0,NONE:0,SLIGHT_RIGHT:45,RIGHT:90,HARD_RIGHT:135,SLIGHT_LEFT:-45,LEFT:-90,HARD_LEFT:-135};
  function arrow(deg){const a=deg*Math.PI/180,bend=pt(0,6),end=[bend[0]+Math.sin(a)*30,bend[1]-Math.cos(a)*30];line([pt(0,32),bend,end],9,white);head(end,a,white);}
  let dir=m.direction;
  if(m.kind==='branch'||m.kind==='laneChange'){const v=String(m.branch||m.side||'');dir=/LEFT/.test(v)?'SLIGHT_LEFT':/RIGHT/.test(v)?'SLIGHT_RIGHT':'STRAIGHT_ON';}
  if(m.kind==='roundabout'){
   const r=17,c=pt(0,0),ring=[];for(let i=0;i<=24;i++){const t=i/24*Math.PI*2;ring.push([c[0]+Math.sin(t)*r,c[1]-Math.cos(t)*r]);}
   line(ring,6,white);line([pt(0,34),pt(0,r)],9,white);
   const deg=Number.isFinite(m.angle)&&m.angle>0?(m.side==='LEFT'?-m.angle:m.angle)-180:90,a=deg*Math.PI/180,from=[c[0]+Math.sin(a)*r,c[1]-Math.cos(a)*r],to=[c[0]+Math.sin(a)*(r+20),c[1]-Math.cos(a)*(r+20)];
   line([from,to],9,white);head(to,a,white);
   if(m.exit!==null&&m.exit!==undefined){const n=String(m.exit);text(n,c[0]-measure(n,18)/2,c[1]-11,18,white);}
  }else if(m.kind==='destinationManeuver'){
   line([pt(-14,32),pt(-14,-24)],5,white);triangle(pt(-12,-24),pt(24,-12),pt(-12,0),white);
  }else if(dir==='UTURN_LEFT'||dir==='UTURN_RIGHT'){
   // up the stem, over a half circle, back down: a left U-turn turns over to the left
   const sx=dir==='UTURN_LEFT'?12:-12,pts=[pt(sx,32),pt(sx,-4)];for(let i=1;i<=12;i++){const t=i/12*Math.PI;pts.push(pt(sx*Math.cos(t),-4-12*Math.sin(t)));}
   pts.push(pt(-sx,14));line(pts,8,white);head(pt(-sx,14),Math.PI,white);
  }else if(ANG[dir]!==undefined)arrow(ANG[dir]);
  else{const k=String(m.kind);text(shorten(k,14,130),cx-measure(shorten(k,14,130),14)/2,cy-8,14,white);}
  const U={METER:'m',KM:'km',MILE_UK:'mi',MILE_US:'mi',YARD:'yd',FEET:'ft'};
  const d=m.distance!==''&&m.distance!==undefined&&m.distance!==null?String(m.distance)+(U[m.unit]?' '+U[m.unit]:''):'';
  if(d)text(d,cx-measure(d,26)/2,120,26,white);

 }
 if(guidance){
  const start=g.positions.length;guidancePanel(guidance);
  const sc=(cfg.turnSize||100)/100,panel=Settings.panel(cfg,'turn'),ox=panel.x,oy=panel.y;
  const v=Settings.view(cfg),k=v[1]||1;
  for(let i=start;i<g.positions.length;i+=3){
   const sx=ox+(g.positions[i]-20)*sc,sy=oy+(g.positions[i+1]-20)*sc;
   g.positions[i]=(sx-400-v[2])/k+400;g.positions[i+1]=(sy-240-v[3])/k+240;
  }
 }
 if(guidance&&guidance.text&&cfg.streetVisible!==false){
  const start=g.positions.length,layout=streetLayout(guidance.text,font,cfg);
  layout.lines.forEach(l=>text(l.text,l.x,l.y,layout.size,[.62,.8,.9,1]));
  const v=Settings.view(cfg),k=v[1]||1;
  for(let i=start;i<g.positions.length;i+=3){g.positions[i]=(g.positions[i]-400-v[2])/k+400;g.positions[i+1]=(g.positions[i+1]-240-v[3])/k+240;}
 }
 if(traffic)text(traffic,24,24,16,[1,.8,.48,1]);
 return g;
}
// Bottom-anchored word wrapping. Account for glyph atlas padding as well as advance,
// so every quad stays inside the box, including long unbroken street names.
function streetLayout(value,font,cfg){
 const size=15*(cfg.streetSize||100)/100,scale=size/32,width=300*(cfg.streetWidth||100)/100,height=60*(cfg.streetHeight||100)/100;
 const panel=Settings.panel(cfg,'street'),left=panel.x,top=panel.y,right=left+width,bottom=top+height;
 const glyph=ch=>font.glyphs[ch]||font.glyphs['?'];
 const extent=s=>{let advance=0,end=0;Array.from(s).forEach(ch=>{const f=glyph(ch);end=Math.max(end,advance+f.w*scale);advance+=f.advance*scale;});return end;};
 const lineHeight=Math.max.apply(null,Object.keys(font.glyphs).map(ch=>font.glyphs[ch].h*scale)),capacity=Math.floor(height/lineHeight),lines=[];
 if(!capacity)return {lines:[],size,left,top,right,bottom};
 let line='';
 String(value).trim().split(/\s+/).filter(Boolean).forEach(word=>{
  if(line&&extent(line+' '+word)<=width){line+=' '+word;return;}
  if(line){lines.push(line);line='';}
  Array.from(word).forEach(ch=>{if(line&&extent(line+ch)>width){lines.push(line);line='';}if(extent(ch)<=width)line+=ch;});
 });
 if(line)lines.push(line);
 if(lines.length>capacity){lines.length=capacity;let chars=Array.from(lines[capacity-1]);while(chars.length&&extent(chars.join('')+'...')>width)chars.pop();lines[capacity-1]=chars.join('')+'...';}
 return {size,left,top,right,bottom,lines:lines.map((t,i)=>({text:t,x:right-extent(t),y:bottom-(lines.length-i)*lineHeight}))};
}
module.exports={VS,FS,build,streetLayout};
