'use strict';
const net=require('net'),EventEmitter=require('events');
class Control extends EventEmitter{
 constructor(socket){super();this.path=socket||'/dev/shm/mindflow-hud/control.sock';this.socket=null;this.state=null;this.closed=true;this.pending=false;}
 open(){if(!this.closed)return;this.closed=false;this.connect();}
 connect(){if(this.closed||this.socket)return;const s=this.socket=net.connect(this.path);let buf='';s.setEncoding('utf8');s.on('data',c=>{buf+=c;if(buf.length>131072){s.destroy();return;}let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);try{const v=JSON.parse(line);this.pending=false;if(v.type==='status'){this.state=v;this.error=null;}else if(v.type==='error')this.error=v.message;this.emit('change');}catch(e){s.destroy();}}});s.on('error',()=>{});s.on('close',()=>{this.socket=null;this.state=null;this.pending=false;this.emit('change');if(!this.closed)this.timer=setTimeout(()=>this.connect(),1500);});}
 send(msg){if(!this.socket||!this.state||this.pending)return false;this.pending=true;this.socket.write(JSON.stringify(msg)+'\n');return true;}
 set(values){return this.send({cmd:'set',values});}
 close(){this.closed=true;clearTimeout(this.timer);if(this.socket)this.socket.destroy();}
}
module.exports={Control};
