'use strict';
// Short geometry-only fallback. Never extends beyond an ambiguous junction.
const scene=require('./scene');
const MAX_SEGMENTS=8000,CELL_M=50;   // road segments within 800 m considered; crossing-search grid cell
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const angle=(a,b)=>Math.atan2(b[0]-a[0],b[1]-a[1]);
const delta=(a,b)=>Math.atan2(Math.sin(a-b),Math.cos(a-b));
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
function build(roads,origin,pose,phone){
 const empty=reason=>({coordinates:null,reason});
 if(!phone||!pose.every(Number.isFinite))return empty('waiting for fresh phone guidance');
 const unit={METER:1,KM:1000,MILE_UK:1609.34,MILE_US:1609.34,YARD:.9144,FEET:.3048};
 const raw=Number(String(phone.distance===undefined?'':phone.distance).replace(',','.'));
 const turn=unit[phone.unit]&&Number.isFinite(raw)&&raw>=0?raw*unit[phone.unit]:null;
 const direction=String(phone.direction||phone.branch||phone.side||'');
 const side=/LEFT/.test(direction)?-1:/RIGHT/.test(direction)?1:0;
 const supported=phone.kind!=='roundabout'&&!/UTURN/.test(direction)&&phone.kind!=='destinationManeuver';
 const segments=[];
 for(const road of roads){const pts=road.points.map(p=>scene.local(p,origin));for(let i=1;i<pts.length;i++){
  const a=pts[i-1],b=pts[i],hit=scene.nearest(pose,[a,b]);
  if(hit&&hit.distance<800&&dist(a,b)>1)segments.push({a,b,road,cuts:[0,1]});
  if(segments.length>MAX_SEGMENTS)return empty('local road graph exceeds bound');
 }}
 if(!segments.length)return empty('waiting for road tiles');
 // Split true geometric crossings only on the same road level/structure. Only segments
 // sharing a grid cell can cross: dense city geometry (thousands of short segments)
 // stays linear instead of comparing every pair.
 const cells=new Map(),pairs=new Set(),n=segments.length;
 segments.forEach((s,i)=>{
  const x0=Math.floor(Math.min(s.a[0],s.b[0])/CELL_M),x1=Math.floor(Math.max(s.a[0],s.b[0])/CELL_M),y0=Math.floor(Math.min(s.a[1],s.b[1])/CELL_M),y1=Math.floor(Math.max(s.a[1],s.b[1])/CELL_M);
  for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const k=x+','+y,list=cells.get(k);if(list){for(const j of list)pairs.add(j*n+i);list.push(i);}else cells.set(k,[i]);}
 });
 for(const key of pairs){
  const a=segments[Math.floor(key/n)],b=segments[key%n];if((a.road.layer||0)!==(b.road.layer||0)||(a.road.structure||'none')!==(b.road.structure||'none'))continue;
  const ux=a.b[0]-a.a[0],uy=a.b[1]-a.a[1],vx=b.b[0]-b.a[0],vy=b.b[1]-b.a[1],den=ux*vy-uy*vx;
  if(Math.abs(den)<1e-8)continue;
  const dx=b.a[0]-a.a[0],dy=b.a[1]-a.a[1],t=(dx*vy-dy*vx)/den,u=(dx*uy-dy*ux)/den;
  if(t>=0&&t<=1&&u>=0&&u<=1){a.cuts.push(t);b.cuts.push(u);}
 }
 const nodes=[],grid=new Map();
 function node(p,road){const key=[Math.round(p[0]),Math.round(p[1]),road.layer||0,road.structure||'none'].join(',');if(grid.has(key))return grid.get(key);const n={p,edges:[],id:nodes.length};nodes.push(n);grid.set(key,n);return n;}
 function edge(a,b,road){if(a===b||a.edges.some(e=>e.to===b))return;a.edges.push({to:b,road});}
 // Match within 20 m; with a poor GPS fix (urban drift) widen to 35 m before giving up.
 // The ambiguity check below still refuses when two roads are equally plausible.
 let candidates=[];
 for(const radius of [20,35]){
  for(const s of segments){const h=scene.nearest(pose,[s.a,s.b]),bearing=angle(s.a,s.b),one=s.road.oneway;
   for(const rev of [false,true]){if(one===true&&rev||one===-1&&!rev)continue;const d=Math.abs(delta(bearing+(rev?Math.PI:0),pose[2]));if(h.distance<=radius&&d<Math.PI/3)candidates.push({s,h,rev,score:h.distance+d*12});}
  }
  if(candidates.length)break;
 }
 candidates.sort((a,b)=>a.score-b.score);if(!candidates.length)return empty('no road matches car heading');
 const best=candidates[0];if(candidates.some(c=>c.score-best.score<3&&dist(c.h.point,best.h.point)>4))return empty('ambiguous current road');
 best.s.cuts.push(best.h.t);
 let start;
 for(const s of segments){s.cuts.sort((a,b)=>a-b);const ns=s.cuts.map(t=>node([s.a[0]+(s.b[0]-s.a[0])*t,s.a[1]+(s.b[1]-s.a[1])*t],s.road));
  if(s===best.s)start=ns[s.cuts.indexOf(best.h.t)];
  for(let i=1;i<ns.length;i++){if(s.road.oneway!==-1)edge(ns[i-1],ns[i],s.road);if(s.road.oneway!==true)edge(ns[i],ns[i-1],s.road);}
 }
 // Walk the matched road in its own direction: just after a turn the car's (smoothed, 1 Hz)
 // heading is still between the two roads and would reject the road it is already on.
 let current=start,heading=angle(best.s.a,best.s.b)+(best.rev?Math.PI:0),along=0,turned=false,after=0,reason='current road only';const path=[start.p],seen=new Set([start.id]);
 const tolerance=turn===null?0:Math.max(20,Math.min(60,turn*.2));
 for(let step=0;step<150;step++){
  const choices=current.edges.filter(e=>!seen.has(e.to.id)).map(e=>({e,change:delta(angle(current.p,e.to.p),heading)}));
  let selected;
  if(!turned&&supported&&side&&turn!==null&&Math.abs(along-turn)<=tolerance){
   const turns=choices.filter(c=>c.change*side>Math.PI/6&&c.change*side<Math.PI*.85);
   const named=turns.filter(c=>norm(phone.text)&&norm(c.e.road.name)===norm(phone.text));
   const options=named.length?named:turns;
   if(options.length===1){selected=options[0];turned=true;reason='current road and next segment';}
   else if(options.length>1){reason='ambiguous next turn';break;}
  }
  if(!selected){const straight=choices.filter(c=>Math.abs(c.change)<Math.PI/6).sort((a,b)=>Math.abs(a.change)-Math.abs(b.change));
   if(!straight.length)break;
   if(straight.length>1&&Math.abs(straight[1].change)-Math.abs(straight[0].change)<.2){reason='ambiguous continuation';break;}
   // Do not pass the indicated turn if it cannot be identified.
   if(!turned&&turn!==null&&along>=Math.max(0,turn-5))break;
   selected=straight[0];
  }
  const next=selected.e.to,len=dist(current.p,next.p),remaining=turned?100-after:Math.min(650,turn===null?200:turn)-along;
  if(remaining<=0)break;
  if(len>remaining+.01){path.push([current.p[0]+(next.p[0]-current.p[0])*remaining/len,current.p[1]+(next.p[1]-current.p[1])*remaining/len]);break;}
  path.push(next.p);along+=len;if(turned)after+=len;heading=angle(current.p,next.p);current=next;seen.add(next.id);
 }
 if(path.length<2||path.reduce((n,p,i)=>n+(i?dist(p,path[i-1]):0),0)<3)return empty('no confirmed forward segment');
 return {coordinates:path.map(p=>[origin[0]+p[0]/(111320*Math.cos(origin[1]*Math.PI/180)),origin[1]+p[1]/111320]),reason};
}
module.exports={build};
