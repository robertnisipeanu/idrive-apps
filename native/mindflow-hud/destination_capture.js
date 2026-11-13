"use strict";
// Destination-only IPC. No GPS, guidance, session logs or USB exports.
const path=require('path'),cp=require('child_process'),StringDecoder=require('string_decoder').StringDecoder;
class DestinationCapture {
 constructor(o){this.o=o||{};this.root=this.o.root||__dirname;this.child=null;this.locked=false;this.state={active:false,message:'Destination reader idle'};}
 start(){
  if(this.child||this.locked||this.closing)return false;
  const args=['--seconds','30','--max-events','16'];
  const decoder=new StringDecoder('utf8');
  let output='',errors='',overflow=false,bytes=0;
  try{
   const child=this.child=(this.o.spawn||cp.spawn)(path.join(this.root,'destination-reader'),args,{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']});
   this.state={active:true,message:'Reading navigation destination'};
   child.stdout.on('data',d=>{const b=Buffer.isBuffer(d)?d:Buffer.from(d);bytes+=b.length;if(bytes>16384){overflow=true;child.kill('SIGTERM');}else output+=decoder.write(b);});
   child.stderr.on('data',d=>{errors=(errors+String(d)).slice(-4096);});
   child.on('error',()=>{this.state.message='Destination reader could not start';});
   child.once('close',(code,signal)=>{
    clearTimeout(this.timer);this.child=null;output+=decoder.end();
    this.locked=!!signal||/Detach incomplete/.test(errors);
    this.state={active:false,message:'Destination unavailable'};
    if(code===0&&!signal&&!overflow){
     try{const result=JSON.parse(output);
      if(result.detached===true&&typeof result.address==='string'&&result.address.trim()&&result.address.length<=2048&&!this.closing){
       this.state.message='Destination received; resolving route';
       if(this.o.onAddress)this.o.onAddress(result.address.trim());
      }
     }catch(e){this.state.message='Destination response invalid';}
    }
    output='';errors='';
    if(this.o.done&&!this.closing)this.o.done();
   });
   this.timer=setTimeout(()=>this.stop(),40000);this.timer.unref();return true;
  }catch(e){this.child=null;this.state={active:false,message:'Destination reader could not start'};return false;}
 }
 stop(){if(this.child)this.child.kill('SIGTERM');}
 async close(){this.closing=true;if(this.child){const child=this.child;await new Promise(r=>{child.once('close',r);this.stop();});}}
}
module.exports={DestinationCapture};
