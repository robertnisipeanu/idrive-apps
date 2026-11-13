'use strict';
const kernel=require('./kernel'),Settings=require('./settings');
const calibration={horizon:20,distance:135,opacity:.85,focal:700,anchor:322};
function local(c,origin){return [(c[0]-origin[0])*111320*Math.cos(origin[1]*Math.PI/180),(c[1]-origin[1])*111320];}
function nearest(point,points){let best=null;for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],dx=b[0]-a[0],dy=b[1]-a[1],n=dx*dx+dy*dy;if(n<.01)continue;const t=Math.max(0,Math.min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dy)/n)),q=[a[0]+t*dx,a[1]+t*dy],d=Math.hypot(q[0]-point[0],q[1]-point[1]);if(!best||d<best.distance)best={distance:d,point:q,index:i,t,heading:Math.atan2(dx,dy)};}return best;}
function project(p,pose,settings){const v=settings||Settings.defaults,k=v.zoom/100,dx=(p[0]-pose[0])*k,dy=(p[1]-pose[1])*k,c=Math.cos(pose[2]),s=Math.sin(pose[2]),x=dx*c-dy*s,z=dx*s+dy*c;const q=Settings.mapPoint([400+x*700/(z+v.distance),v.horizon+40770/(z+v.distance)],v);return {x:q[0],y:q[1],z};}
function nearby(points,center,radius){
 const runs=[];let run=[];
 for(let i=1;i<points.length;i++){
  const a=points[i-1],b=points[i],hit=nearest(center,[a,b]);
  if(hit&&hit.distance<radius){if(!run.length)run.push(a);run.push(b);}else if(run.length){runs.push(run);run=[];}
 }if(run.length)runs.push(run);return runs;
}
function geometry(flat){
 const chunks=[];for(let start=0;start<flat.length;start+=120000){const positions=[],indices=[];const end=Math.min(flat.length,start+120000);for(let i=start;i<end;i+=2){positions.push(flat[i],flat[i+1],0);indices.push(indices.length);}if(indices.length)chunks.push({positions,indices});}return chunks;
}
function compact(points){const result=[];for(const p of points){while(result.length>1){const a=result[result.length-2],b=result[result.length-1],ux=b[0]-a[0],uy=b[1]-a[1],vx=p[0]-b[0],vy=p[1]-b[1];if(ux*vx+uy*vy<0||Math.abs(ux*vy-uy*vx)>1e-8*Math.max(1,Math.hypot(ux,uy)*Math.hypot(vx,vy)))break;result.pop();}result.push(p);}return result;}
function trafficEdges(route){const t=route.traffic,edges=[];let end=0;
 if(!t||t.status!=='available'||!Number.isFinite(t.age_s)||t.age_s<0||t.age_s>600||!Array.isArray(t.intervals))return [];
 for(const v of t.intervals){if(!Number.isInteger(v.start)||!Number.isInteger(v.end)||v.start!==end||v.end<=end||v.end>=route.coordinates.length||['NORMAL','SLOW','TRAFFIC_JAM'].indexOf(v.speed)<0)return [];for(let i=v.start;i<v.end;i++)edges[i]=v.speed;end=v.end;}
 return end===route.coordinates.length-1?edges:[];
}
function build(roadGeo,route,origin,pose,settings){const opacity=(settings||Settings.defaults).opacity/100;
 // map-only feed (map_feed.js): the stub ahead of the car is no route; draw roads only
 const all=route.mapOnly?[]:route.coordinates.map(p=>local(p,origin)),match=nearest(pose,all),start=match&&match.distance<30?match.index-1:0;
 const roads=[];roadGeo.forEach(r=>nearby(r.points.map(p=>local(p,origin)),pose,1600).forEach(points=>roads.push(Object.assign({},r,{points}))));
 const routeRuns=nearby(all,pose,1800),routeNear=[];
 // Reconcile each continuous route portion separately; never join distant loops.
 let displayed=roads,stats={replacedMeters:0};
 routeRuns.forEach(points=>{const a=kernel.reconcile(displayed,points);displayed=a.roads;stats.replacedMeters+=a.stats.replacedMeters;routeNear.push(points);});
 const ground=[],groundEdge=[],bed=[],edge=[],bins={NORMAL:[],SLOW:[],TRAFFIC_JAM:[]};
 displayed.forEach(r=>{const width=Math.max(3.2,Math.min(7,r.width*2.6)),points=compact(r.points);kernel.ribbon(points,width+.8,groundEdge);kernel.ribbon(points,width,ground);});
 routeNear.forEach(points=>{kernel.ribbon(points,7.8,groundEdge);kernel.ribbon(points,7,ground);});
 const speeds=trafficEdges(route);
 // Keep original route-edge indexing while restricting GPU uploads to the local area.
 let run=[],runStart=0;
 const flush=()=>{if(run.length>1){kernel.ribbon(run,5.2,bed);kernel.ribbon(run,3.1,edge);kernel.ribbon(run,2.4,null,i=>bins[speeds[runStart+i]||'NORMAL']);}run=[];};
 for(let i=start;i<all.length-1;i++){
  let a=i===start&&match&&match.distance<30?match.point:all[i],b=all[i+1];
  // A later loop may be ahead in route order but behind the car in the view.
  // Keep road context there, but never draw it as an immediate cyan instruction.
  const forward=p=>(p[0]-pose[0])*Math.sin(pose[2])+(p[1]-pose[1])*Math.cos(pose[2]);
  const za=forward(a),zb=forward(b),rear=-3;
  if(za<rear&&zb<rear){flush();continue;}
  if(za<rear||zb<rear){
   const t=(rear-za)/(zb-za),cut=[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])];
   if(za<rear){flush();a=cut;}else b=cut;
  }
  const near=nearest(pose,[a,b]);if(near&&near.distance<1800){if(!run.length){run=[a];runStart=i;}run.push(b);}else flush();
  if(zb<rear)flush();
 }flush();
 const groups=[[groundEdge,[.66,.67,.68,.24*opacity]],[ground,[.75,.76,.77,.9*opacity]],[bed,[.53,.54,.55,.42*opacity]],[edge,[.72,.74,.76,.9*opacity]],[bins.NORMAL,[0,.83,.98,1]],[bins.SLOW,[1,.57,.08,1]],[bins.TRAFFIC_JAM,[1,.15,.12,1]]];
 const parts=[];groups.forEach(g=>geometry(g[0]).forEach(geometry=>parts.push({geometry,color:g[1]})));
 if(parts.length>24)throw Error('Nearby scene exceeds mesh-part budget');
 let alert=null,distance=match?match.distance:Infinity;
 if(speeds.length&&match&&match.distance<30)for(let i=start;i<all.length-1&&distance<=1000;i++){const speed=speeds[i];if(speed==='SLOW'||speed==='TRAFFIC_JAM'){const meters=Math.round(distance/10)*10;alert=(speed==='SLOW'?'Slow traffic':'Traffic jam')+(meters<20?' here':' in '+meters+' m');break;}const a=i===start?match.point:all[i];distance+=Math.hypot(all[i+1][0]-a[0],all[i+1][1]-a[1]);}
 return {parts,roads,match,stats,traffic:speeds.length>0,alert};
}
module.exports={calibration,local,nearest,project,nearby,geometry,build,trafficEdges};
