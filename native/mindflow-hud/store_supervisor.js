'use strict';
const {fork}=require('child_process'),path=require('path');
let child=null,stopped=false,last=0,timer=null;
function spawn(){if(stopped)return;last=Date.now();child=fork(path.join(__dirname,'service.js'),[],{stdio:['ignore','inherit','inherit','ipc']});child.on('message',m=>{if(m&&m.heartbeat)last=Date.now();});child.on('exit',()=>{child=null;if(!stopped)timer=setTimeout(spawn,2000);});}
spawn();const watchdog=setInterval(()=>{if(child&&Date.now()-last>5000)child.kill('SIGKILL');},500);
function stop(){stopped=true;clearTimeout(timer);clearInterval(watchdog);if(child)child.kill('SIGTERM');}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
