'use strict';
// mgu-uplink lets out only the uids component.json "uids" names, and the Store
// refuses uid 0. The service must stay root for the tracefs capture, so while
// running as root every HTTPS connection made through https.globalAgent (Google
// Routes, Mapbox, camera feeds) is opened by net_broker.js running as hmi_5000.
const cp=require('child_process'),path=require('path'),https=require('https'),tls=require('tls'),net=require('net');
const NET_UID=5000,NET_GID=5000;
function install(options){
 const o=options||{};
 const asRoot=typeof process.getuid==='function'&&process.getuid()===0;
 if(!asRoot&&!o.force)return null; // not root: connections already carry a non-root uid
 const uid=o.uid===undefined?NET_UID:o.uid,gid=o.gid===undefined?NET_GID:o.gid;
 let child=null,seq=0;const pending=new Map();
 function start(){
  const opts={stdio:['ignore','inherit','inherit','ipc']};
  if(uid!==null){opts.uid=uid;opts.gid=gid;}
  const c=child=cp.fork(path.join(__dirname,'net_broker.js'),[],opts);
  c.on('message',(m,handle)=>{
   const p=m&&pending.get(m.id);
   if(!p){if(handle)handle.destroy();return;}
   pending.delete(m.id);clearTimeout(p.timer);
   if(m.error||!handle){if(handle)handle.destroy();const err=Error('Internet connection failed');err.code=typeof m.error==='string'&&/^[A-Z][A-Z0-9_]{1,49}$/.test(m.error)?m.error:m.error==='connect timed out'?'ETIMEDOUT':m.error==='too many connections'?'BROKER_BUSY':m.error==='bad target'?'BROKER_BAD_TARGET':'BROKER_NO_SOCKET';p.cb(err);return;}
   p.cb(null,handle);
  });
  c.on('error',()=>{});
  c.on('exit',()=>{if(child===c)child=null;pending.forEach(p=>{clearTimeout(p.timer);p.cb(Object.assign(Error('Internet broker stopped'),{code:'BROKER_STOPPED'}));});pending.clear();});
 }
 function connect(host,port,cb){
  if(!child)start();
  const id=++seq;
  const timer=setTimeout(()=>{if(pending.delete(id))cb(Object.assign(Error('Internet connection timed out'),{code:'BROKER_TIMEOUT'}));},20000);
  pending.set(id,{cb,timer});
  try{child.send({op:'connect',id,host,port});}catch(e){pending.delete(id);clearTimeout(timer);cb(e);}
 }
 const agent=https.globalAgent;
 agent.createConnection=function(opts,oncreate){
  const host=opts.host||opts.hostname||'localhost',port=Number(opts.port)||443;
  connect(host,port,(err,raw)=>{
   if(err){oncreate(err);return;}
   const t=Object.assign({},opts,{socket:raw});delete t.path;delete t.port;delete t.host;delete t.hostname;
   if(!t.servername&&!net.isIP(host))t.servername=host;
   let s;try{s=tls.connect(t);}catch(e){raw.destroy();oncreate(e);return;}
   oncreate(null,s);
  });
 };
 return {stop(){if(child)child.kill();}};
}
module.exports={install,NET_UID,NET_GID};
