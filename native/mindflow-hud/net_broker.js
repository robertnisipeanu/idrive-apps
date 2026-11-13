'use strict';
// Runs as the HMI worker account (hmi_5000, uid 5000), the only uid this tool asks
// mgu-uplink to let out. It opens outbound TCP connections for the root HUD
// service and hands each connected socket back over IPC; TLS and HTTP stay in
// the service. The socket keeps this uid as its owner, so root never gets internet.
const net=require('net'),dns=require('dns'),fs=require('fs');

// Resolve through the uplink lease; leave the BMW/global resolver untouched.
function leaseResolve(host,cb){
 let resolver;
 try{
  const lease=JSON.parse(fs.readFileSync('/run/mgu-uplink/lease.json','utf8'));
  const servers=Array.isArray(lease.dns)?lease.dns.filter(x=>typeof x==='string'&&net.isIP(x)):[];
  if(!servers.length)throw Error('No lease DNS');
  resolver=new dns.Resolver();resolver.setServers(servers);
 }catch(e){cb(Object.assign(Error('Uplink DNS unavailable'),{code:'UPLINK_DNS_UNAVAILABLE'}));return;}
 let done=false;const timer=setTimeout(()=>{if(done)return;done=true;cb(Object.assign(Error('Uplink DNS timed out'),{code:'ETIMEDOUT'}));if(resolver.cancel)resolver.cancel();},5000);
 resolver.resolve4(host,(err,addresses)=>{if(done)return;done=true;clearTimeout(timer);
  const ip=addresses&&addresses.find(x=>net.isIP(x)===4);
  cb(err||(!ip?Object.assign(Error('No IPv4 address'),{code:'ENODATA'}):null),ip?[ip]:null);
 });
}
function lookup(host,options,cb){leaseResolve(host,(err,addresses)=>{if(err){cb(err);return;}cb(null,addresses[0],4);});}

const MAX_PENDING=32;let pending=0;
process.on('message',m=>{
 if(!m||m.op!=='connect')return;
 const id=m.id;
 if(typeof m.host!=='string'||!m.host||m.host.length>253||!Number.isInteger(m.port)||m.port<1||m.port>65535){process.send({id,error:'bad target'});return;}
 if(pending>=MAX_PENDING){process.send({id,error:'too many connections'});return;}
 pending++;let done=false;
 const s=net.connect({host:m.host,port:m.port,lookup});
 const timer=setTimeout(()=>{fail('connect timed out');s.destroy();},15000);
 function fail(error){if(done)return;done=true;pending--;clearTimeout(timer);try{process.send({id,error});}catch(e){}}
 s.once('error',e=>fail(e.code||e.message||'connect failed'));
 s.once('connect',()=>{
  if(done){s.destroy();return;}
  done=true;pending--;clearTimeout(timer);s.removeAllListeners('error');s.on('error',()=>{});
  // The client speaks first (TLS ClientHello), so nothing is read here before the handoff.
  try{process.send({id},s);}catch(e){s.destroy();}
 });
});
process.on('disconnect',()=>process.exit(0));
