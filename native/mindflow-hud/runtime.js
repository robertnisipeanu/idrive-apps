'use strict';
const fs=require('fs'),path=require('path'),http=require('http'),https=require('https'),url=require('url');
const {ClusterRender}=require('./cluster_render_client'),scene=require('./scene'),kernel=require('./kernel'),labels=require('./labels'),{Roads}=require('./roads');
const cameras=require('./cameras'),Settings=require('./settings');
const BUILD_MS=1500,GEOMETRY_GAP_MS=1300,RETRY_MS=[5000,15000,60000];
const now=()=>{const t=process.hrtime();return t[0]*1000+t[1]/1e6;};
function getJSON(address){return new Promise((resolve,reject)=>{
 const u=url.parse(address),transport=u.protocol==='https:'?https:http;
 const req=transport.get(u,res=>{if(res.statusCode!==200){res.resume();reject(Error('Feed HTTP '+res.statusCode));return;}let n=0,chunks=[];res.on('data',p=>{n+=p.length;if(n>8*1024*1024){req.destroy(Error('Oversized feed'));return;}chunks.push(p);});res.on('error',reject);res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){reject(Error('Invalid feed JSON'));}});});req.setTimeout(1800,()=>req.destroy(Error('Feed timeout')));req.on('error',()=>reject(Error('Feed unavailable')));
});}
function valid(route,state){const f=state&&state.fix,r=route&&route.route;
 if(!r||!Array.isArray(r.coordinates)||r.coordinates.length<2||r.coordinates.length>100000||!f||f.simulated)return false;
 const age=(f.sent_elapsed_ns-f.fix_elapsed_ns)/1e9+f.server_age_s;
 return Number.isFinite(age)&&age>=0&&age<=5&&Number.isFinite(f.accuracy_m)&&f.accuracy_m>=0&&f.accuracy_m<=30&&Number.isFinite(f.latitude)&&Math.abs(f.latitude)<=85&&Number.isFinite(f.longitude)&&Math.abs(f.longitude)<=180&&r.coordinates.every(p=>Array.isArray(p)&&p.length>=2&&Number.isFinite(p[0])&&Math.abs(p[0])<=180&&Number.isFinite(p[1])&&Math.abs(p[1])<=85);
}
class Runtime {
 constructor(options){
  this.options=options||{};this.settings=Settings.validate(Object.assign({enabled:true},this.options.settings||{}));this.cr=this.options.client||new ClusterRender('hud-google-route',this.options.socket);
  this.fetch=this.options.fetch||getJSON;this.feed=(this.options.feed||'http://127.0.0.1:8790').replace(/\/$/,'');
  this.clock=this.options.clock||now;this.roadSource=this.options.roadSource||null;
  this.cameraFeed=this.options.cameraFeed||new cameras.Feed();
  this.font=this.options.font||JSON.parse(fs.readFileSync(path.join(__dirname,'font.json'),'utf8'));
  this.pixels=this.options.pixels||fs.readFileSync(path.join(__dirname,'font.r8'));
  this.layer=0;this.labelLayer=0;this.fontRef=0;this.parts=[];this.geometries=[];this.lastBuild=-Infinity;this.lastFeed=-Infinity;this.lastTick=this.clock();this.nextRoads=0;this.roads=[];this.pose=[0,0,0];this.target=[0,0,0];this.origin=null;this.route=null;this.trip=null;this.error=false;this.closed=false;this.epoch=0;this.visible=false;this.pending=false;this.heading=null;
  this.cr.on('disconnected',()=>{this.hide();this.error=false;this.lastFeed=-Infinity;});
  this.cr.on('ready',()=>{this.error=false;this.lastBuild=-Infinity;});
  this.cr.on('refused',(op,ref,reason)=>{this.error=true;this.hide();this.scheduleRetry();this.lastRefusal={op:String(op||''),ref:ref,reason:String(reason||''),at:Date.now()};this.report('Renderer refused '+this.lastRefusal.op+(ref?' (ref '+ref+')':'')+': '+this.lastRefusal.reason);});
 }
 applySettings(value){this.settings=Settings.validate(value);if(!this.settings.enabled)this.clear();}
 report(message){if(this.options.report)this.options.report(message);}
 // The renderer replaces a part's geometry at most once a second and refuses a faster
 // replacement: every part upload is spaced GEOMETRY_GAP_MS apart, timed when sent.
 canUpload(key,t){return !this.geoAt||!this.geoAt[key]||t-this.geoAt[key]>=GEOMETRY_GAP_MS;}
 uploaded(key,t){(this.geoAt=this.geoAt||{})[key]=t;}
 // After a refusal the scene is rebuilt on its own: 5 s, 15 s, then every 60 s.
 scheduleRetry(){const now=this.clock();this.refusals=(this.refusals||[]).filter(x=>now-x<600000);this.refusals.push(now);this.retryAt=now+RETRY_MS[Math.min(this.refusals.length,RETRY_MS.length)-1];}
 hide(){
  this.geoAt={};
  if(this.layer){this.cr.set(this.layer,{visible:false});this.cr.drop(this.layer);}
  if(this.labelLayer){this.cr.set(this.labelLayer,{visible:false});this.cr.drop(this.labelLayer);}
  if(this.fontRef)this.cr.drop(this.fontRef);
  this.layer=0;this.labelLayer=0;this.fontRef=0;this.parts=[];this.geometries=[];this.visible=false;this.lastBuild=-Infinity;
 }
 clear(){this.epoch++;this.hide();this.route=null;this.trip=null;this.heading=null;this.lastFeed=-Infinity;}
 async poll(){
  if(this.pending||this.closed||!this.settings.enabled)return;this.pending=true;
  try{
   const values=await Promise.all([this.fetch(this.feed+'/route'),this.fetch(this.feed+'/state')]);if(this.closed||!this.settings.enabled)return;
   if(!valid(values[0],values[1])){this.clear();return;}
   const r=values[0],f=values[1].fix,t=this.clock(),trip=String(r.generation);
   if(this.trip!==trip){this.clear();this.trip=trip;this.roads=[];this.origin=null;this.nextRoads=0;}
   const p=[f.longitude,f.latitude],rebase=!this.origin||Math.hypot.apply(null,scene.local(p,this.origin))>800;
   if(rebase){this.hide();this.origin=p;this.pose=[0,0,this.pose[2]];}
   this.target=scene.local(p,this.origin).concat(this.target[2]);
   this.route=r.route;this.trafficReceived=t;
   const match=scene.nearest(this.target,r.route.coordinates.map(c=>scene.local(c,this.origin)));
   if(Number.isFinite(f.heading_deg)&&f.speed_mps>=1.5)this.heading=f.heading_deg*Math.PI/180;
   this.target[2]=this.heading!==null?this.heading:match&&match.distance<30?match.heading:0;
   if(!this.visible||rebase)this.pose=this.target.slice();
   this.lastFeed=t;this.cameraFeed.ensure(p);
   if(!this.roadSource){const config=await this.fetch(this.feed+'/mapbox-config');if(!config||typeof config.token!=='string'||config.token.indexOf('pk.')!==0)throw Error('Mapbox token unavailable');this.roadSource=new Roads(config.token);}
   if(t>=this.nextRoads&&!this.loadingRoads){
    const epoch=this.epoch;this.loadingRoads=true;this.nextRoads=t+10000;
    this.roadSource.near(p[0],p[1],this.target[2]).then(roads=>{if(!this.closed&&epoch===this.epoch)this.roads=roads;},()=>this.report('Mapbox roads unavailable; Google route remains visible')).then(()=>{this.loadingRoads=false;});
   }
  }catch(e){this.report('Navigation feed unavailable');if(this.clock()-this.lastFeed>2500)this.clear();}
  finally{this.pending=false;}
 }
 create(){
  const options={target:'hud',w:800,h:480,projection:'ortho',ortho_h:480,near:.1,far:10,visible:false,exclusive:false,prewarm:false,contend:false,guide_hold:false};
  this.layer=this.cr.mesh(options);this.labelLayer=this.cr.mesh(Object.assign({},options,{z:1}));
  this.fontRef=this.cr.asset({target:'hud',format:'r8',w:this.font.w,h:this.font.h,sampling:'bilinear'});
  if(!this.layer||!this.labelLayer||!this.fontRef)throw Error('HUD allocation failed');
  this.cr.pixels(this.fontRef,null,this.pixels);
  this.cr.part(this.labelLayer,1,{vs:labels.VS,fs:labels.FS,depth:false,cull:'none',blend:'alpha'});this.cr.bind(this.labelLayer,'u_font',this.fontRef,1);
 }
 tick(){
  if(this.closed||!this.settings.enabled)return;const t=this.clock(),dt=Math.max(0,Math.min(.1,(t-this.lastTick)/1000));this.lastTick=t;
  if(!this.route||t-this.lastFeed>2500){if(this.visible||this.layer)this.hide();return;}
  if(this.error&&this.retryAt&&t>=this.retryAt&&this.cr.ready){this.error=false;this.retryAt=0;this.lastBuild=-Infinity;}
  if(!this.cr.ready||this.error)return;
  // Never queue camera updates behind a blocked socket. A stuck renderer loses this client.
  if(this.cr.blocked){if(!this.blockedAt)this.blockedAt=t;if(t-this.blockedAt>2000){this.hide();this.cr.close();this.cr.connect();this.lastFeed=-Infinity;}return;}this.blockedAt=0;
  const k=1-Math.exp(-dt/.16);this.pose[0]+=(this.target[0]-this.pose[0])*k;this.pose[1]+=(this.target[1]-this.pose[1])*k;const dh=((this.target[2]-this.pose[2]+Math.PI*3)%(Math.PI*2))-Math.PI;this.pose[2]+=dh*k;
  try{
   if(!this.layer)this.create();
   if(t-this.lastBuild>=BUILD_MS){
    const route=Object.assign({},this.route,{traffic:Object.assign({},this.route.traffic,{age_s:(this.route.traffic&&this.route.traffic.age_s||0)+(t-this.trafficReceived)/1000})});
    const frame=scene.build(this.roads,route,this.origin,this.pose,this.settings);
    for(let i=0;i<frame.parts.length;i++){
     const part=frame.parts[i],id=i+1,signature=JSON.stringify(part.geometry);
     if(!this.parts[i]){this.cr.part(this.layer,id,{vs:Settings.worldVS(kernel.vs),fs:kernel.fs,depth:false,cull:'none',blend:'alpha'});this.parts[i]=true;}
     if(this.geometries[i]!==signature&&this.canUpload('w'+id,t)){if(!this.cr.geometry(this.layer,id,part.geometry))throw Error('HUD geometry rejected');this.geometries[i]=signature;this.uploaded('w'+id,t);}
     this.cr.uniform(this.layer,'u_color',part.color,{part:id});
    }
    for(let i=frame.parts.length;i<this.parts.length;i++)this.cr.uniform(this.layer,'u_color',[0,0,0,0],{part:i+1});
    this.cameraState=this.settings.cameras?cameras.select(this.cameraFeed.snapshot([this.origin[0]+this.pose[0]/(111320*Math.cos(this.origin[1]*Math.PI/180)),this.origin[1]+this.pose[1]/111320]),this.route.coordinates,this.origin,this.pose):{icons:[],warning:null};
    if(this.canUpload('l1',t)){if(!this.cr.geometry(this.labelLayer,1,labels.build(frame.roads,this.pose,this.font,this.route.mapOnly?null:frame.traffic?frame.alert:'Traffic unavailable',this.cameraState,this.settings,this.options.guidance?this.options.guidance():null)))throw Error('HUD labels rejected');this.uploaded('l1',t);}
    this.lastBuild=t;this.lastFrame=frame;
   }
   for(let i=0;i<this.parts.length;i++){this.cr.uniform(this.layer,'u_view',Settings.view(this.settings),{part:i+1});this.cr.uniform(this.layer,'u_pose',this.pose,{part:i+1});this.cr.uniform(this.layer,'u_camera',Settings.camera(this.settings),{part:i+1});}
   this.cr.uniform(this.labelLayer,'u_view',Settings.view(this.settings),{part:1});this.cr.uniform(this.labelLayer,'u_camera',Settings.camera(this.settings),{part:1});this.cr.uniform(this.labelLayer,'u_pose',this.pose,{part:1});
   if(!this.visible){this.cr.set(this.layer,{visible:true});this.cr.set(this.labelLayer,{visible:true});this.visible=true;this.report('HUD following active navigation');}
  }catch(e){this.error=true;this.hide();this.scheduleRetry();this.lastError=String(e&&e.message||e);this.report('HUD scene could not be built: '+this.lastError);}
 }
 start(){this.cr.connect();this.poll();this.pollTimer=setInterval(()=>this.poll(),500);this.frameTimer=setInterval(()=>this.tick(),33);}
 stop(){this.closed=true;this.epoch++;clearInterval(this.pollTimer);clearInterval(this.frameTimer);this.hide();this.cr.close();}
}
module.exports={Runtime,valid,getJSON};
if(require.main===module){
 const feed=process.env.HUD_ROUTE_FEED||'http://127.0.0.1:8790',u=url.parse(feed);
 if(['127.0.0.1','localhost','::1'].indexOf(u.hostname)<0){console.error('Use a local navigation feed or an authenticated SSH tunnel to loopback.');process.exit(2);}
 const runtime=new Runtime({feed,socket:process.env.HUD_RENDER_SOCKET,report:message=>console.log(message)});
 runtime.start();process.on('SIGTERM',()=>runtime.stop());process.on('SIGINT',()=>runtime.stop());
 if(process.send)setInterval(()=>process.send({heartbeat:true}),1000).unref();
}
