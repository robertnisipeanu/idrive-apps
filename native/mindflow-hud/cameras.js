/* Fixed camera data and route matching shared by the browser and Node 8 HUD. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.HudCameras=factory();})(typeof window==='object'?window:this,function(){
 'use strict';
 const Regions=typeof window==='object'?window.HudCameraRegions:require('./camera_regions'),TTL=3600000;
 const ENDPOINTS=['https://overpass-api.de/api/interpreter','https://overpass.private.coffee/api/interpreter','https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
 const local=(p,o)=>[(p[0]-o[0])*111320*Math.cos(o[1]*Math.PI/180),(p[1]-o[1])*111320];
 function normalize(data){
  if(!data||!Array.isArray(data.elements)||data.remark)throw Error('Incomplete camera response');
  const ways=new Map();
  data.elements.filter(e=>e.type==='way'&&e.tags&&e.tags.highway&&Array.isArray(e.nodes)&&Array.isArray(e.geometry)&&e.nodes.length===e.geometry.length).forEach(w=>{
   w.nodes.forEach((id,i)=>{const a=w.geometry[Math.max(0,i-1)],b=w.geometry[Math.min(w.geometry.length-1,i+1)];if(!a||!b)return;const d=local([b.lon,b.lat],[a.lon,a.lat]);if(!d.every(Number.isFinite)||Math.hypot(d[0],d[1])<.1)return;if(!ways.has(id))ways.set(id,[]);ways.get(id).push(Math.atan2(d[0],d[1]));});
  });
  const seen=new Set(),result=[];
  for(const e of data.elements){const t=e.tags||{};
   if(e.type!=='node'||!Number.isSafeInteger(e.id)||seen.has(e.id)||t.highway!=='speed_camera'||['yes','true','1'].indexOf(t.disused)>=0||t.operational_status==='out_of_order'||!Number.isFinite(e.lon)||Math.abs(e.lon)>180||!Number.isFinite(e.lat)||Math.abs(e.lat)>85)continue;
   seen.add(e.id);let limit=null;const raw=String(t.maxspeed||'').trim(),m=/^(\d{1,3})(?:\s*(mph|km\/h|kph))?$/.exec(raw);
   if(!t['maxspeed:conditional']&&m&&+m[1]>0&&+m[1]<=300)limit=m[1]+' '+(m[2]==='mph'?'mph':'km/h');
   result.push({id:'osm:node:'+e.id,coordinates:[e.lon,e.lat],limit,headings:ways.get(e.id)||[]});
  }
  return result;
 }
 async function transport(query,fetcher){
  const get=fetcher||Regions.request;let error;
  for(const endpoint of ENDPOINTS){try{const data=JSON.parse(Regions.text(await get(endpoint+'?data='+encodeURIComponent(query),5*1024*1024)));normalize(data);return data;}catch(e){error=e;}}
  throw error||Error('All camera providers unavailable');
 }
 class Feed{
  constructor(fetcher,clock,regional){this.regional=regional===false?null:regional||(!fetcher?new Regions.Feed({clock}):null);this.fetcher=fetcher||transport;this.clock=clock||(()=>Date.now());this.cameras=[];this.center=null;this.at=null;this.pending=null;this.retryAt=0;this.failed=false;}
  ensure(point){if(this.regional)return this.regional.ensure(point).then(ok=>ok?undefined:this.ensureOverpass(point));return this.ensureOverpass(point);}
  ensureOverpass(point){const t=this.clock();if(!Array.isArray(point)||!point.every(Number.isFinite)||Math.abs(point[0])>180||Math.abs(point[1])>85)return Promise.resolve();
   const moved=this.center?Math.hypot.apply(null,local(point,this.center)):Infinity;
   if(this.pending)return this.pending;if(t<this.retryAt||(this.at!==null&&t-this.at<TTL&&moved<2000))return Promise.resolve();
   // Bounded 5 km area; no route/destination or credentials are sent to Overpass.
   const query='[out:json][timeout:15];node["highway"="speed_camera"](around:5000,'+point[1].toFixed(5)+','+point[0].toFixed(5)+')->.cameras;(.cameras;way(bn.cameras)["highway"];);out body geom;';
   this.pending=Promise.resolve().then(()=>this.fetcher(query)).then(data=>{this.cameras=normalize(data);this.center=point.slice();this.at=this.clock();this.failed=false;this.retryAt=0;},()=>{this.failed=true;this.retryAt=this.clock()+120000;}).catch(()=>{this.failed=true;this.retryAt=this.clock()+120000;}).then(()=>{this.pending=null;});return this.pending;
  }
  snapshot(point){const regional=this.regional&&this.regional.snapshot(point);if(regional)return regional;const age=this.at===null?Infinity:this.clock()-this.at,covered=this.center&&point&&Math.hypot.apply(null,local(point,this.center))<=3500;
   return {status:age>=0&&age<TTL&&covered?'available':this.pending?'loading':'unavailable',age_s:age/1000,cameras:age>=0&&age<TTL&&covered?this.cameras:[],cached:this.failed,source:'OpenStreetMap'};
  }
 }
 function projections(p,points){const hits=[];let along=0;for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],dx=b[0]-a[0],dy=b[1]-a[1],n=dx*dx+dy*dy,length=Math.sqrt(n);if(length<.01)continue;const raw=((p[0]-a[0])*dx+(p[1]-a[1])*dy)/n,t=Math.max(0,Math.min(1,raw)),q=[a[0]+dx*t,a[1]+dy*t];hits.push({point:q,distance:Math.hypot(p[0]-q[0],p[1]-q[1]),along:along+t*length,heading:Math.atan2(dx,dy),raw});along+=length;}return hits;}
 function select(snapshot,routeGeo,origin,pose){
  const empty={icons:[],warning:null,status:snapshot&&snapshot.status||'unavailable'};
  if(!snapshot||snapshot.status!=='available'||!Number.isFinite(snapshot.age_s)||snapshot.age_s<0||(!snapshot.regional&&snapshot.age_s>=3600)||!Array.isArray(snapshot.cameras)||routeGeo.length<2)return empty;
  const points=routeGeo.map(p=>local(p,origin)),matches=projections(pose,points).sort((a,b)=>a.distance-b.distance),car=matches[0];if(!car||car.distance>30)return empty;
  // A second nearby route occurrence (loop/parallel return) is ambiguous.
  if(matches.some(h=>h.distance<=car.distance+3&&Math.abs(h.along-car.along)>60))return empty;
  const found=[],ids=new Set();
  for(const c of snapshot.cameras){if(!c||typeof c.id!=='string'||ids.has(c.id)||!Array.isArray(c.coordinates)||c.coordinates.length!==2||!c.coordinates.every(Number.isFinite))continue;
   const p=local(c.coordinates,origin),hits=projections(p,points).filter(h=>h.raw>=0&&h.raw<=1).sort((a,b)=>a.distance-b.distance),h=hits[0];if(!h||h.distance>20)continue;
   if(hits.some(v=>v.distance<=h.distance+3&&Math.abs(v.along-h.along)>60))continue;
   // Parent-road direction excludes a camera on a crossing road; the camera's
   // own facing tag is NOT assumed to be the enforced driving direction.
   if(Array.isArray(c.headings)&&c.headings.length&&!c.headings.some(a=>Number.isFinite(a)&&Math.abs(Math.cos(a-h.heading))>=Math.cos(Math.PI/6)))continue;
   const ahead=h.along-car.along;if(ahead<-5||ahead>1000)continue;
   ids.add(c.id);found.push({id:c.id,point:p,distance_m:Math.max(0,Math.round(ahead/10)*10),limit:typeof c.limit==='string'&&/^\d{1,3} (km\/h|mph)$/.test(c.limit)?c.limit:null});
  }
  found.sort((a,b)=>a.distance_m-b.distance_m);const warning=found.length&&found[0].distance_m<=500?found[0]:null;
  return {icons:found.slice(0,3),warning,status:'available'};
 }
 function warningText(w){return w?'Fixed speed camera '+(w.distance_m<10?'ahead':'in '+w.distance_m+' m')+(w.limit?' · '+w.limit:''):'';}
 return {Feed,normalize,select,warningText,transport};
});
