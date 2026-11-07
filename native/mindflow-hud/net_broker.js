'use strict';
// Runs as the HMI worker account (hmi_5000, uid 5000), the only uid this tool asks
// mgu-uplink to let out. It opens outbound TCP connections for the root HUD
// service and hands each connected socket back over IPC; TLS and HTTP stay in
// the service. The socket keeps this uid as its owner, so root never gets internet.
const net=require('net');
const MAX_PENDING=32;let pending=0;
process.on('message',m=>{
 if(!m||m.op!=='connect')return;
 const id=m.id;
 if(typeof m.host!=='string'||!m.host||m.host.length>253||!Number.isInteger(m.port)||m.port<1||m.port>65535){process.send({id,error:'bad target'});return;}
 if(pending>=MAX_PENDING){process.send({id,error:'too many connections'});return;}
 pending++;let done=false;
 const s=net.connect({host:m.host,port:m.port});
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
