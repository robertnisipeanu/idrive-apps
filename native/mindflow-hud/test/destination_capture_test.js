const assert=require('assert'),EventEmitter=require('events'),path=require('path');
const {DestinationCapture}=require('../destination_capture');
function run(payload,code,signal){let received=null,args,child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};const reader=new DestinationCapture({spawn:(exe,a)=>{args=a;return child;},onAddress:a=>{received=a;}});assert(reader.start());assert(!args.includes('--output'));child.stdout.emit('data',payload);child.emit('close',code,signal);return {received,reader};}
assert.equal(run(JSON.stringify({detached:true,address:'Example destination'}),0,null).received,'Example destination');
assert.equal(run(JSON.stringify({detached:false,address:'Example destination'}),0,null).received,null);
assert.equal(run(JSON.stringify({detached:true,address:'Example destination'}),1,null).received,null);
assert.equal(run('invalid',0,null).received,null);
assert.equal(run('x'.repeat(17000),0,null).received,null);
assert(run('{}',null,'SIGKILL').reader.locked);
console.log('PASS destination-only IPC: clean handoff, invalid/error/overflow rejection, detach lockout, no output-file argument');
{
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
 let value=null;
 const reader=new DestinationCapture({spawn:(exe,args,opts)=>{
  assert.equal(path.basename(exe),'destination-reader');
  assert.deepEqual(args,['--seconds','30','--max-events','16']);
  assert(!Object.keys(opts.env).some(k=>/^PYTHON/.test(k)));
  return child;
 },onAddress:a=>{value=a;}});
 assert(reader.start());
 const bytes=Buffer.from(JSON.stringify({address:'Cepães 日本',detached:true}),'utf8');
 for(let i=0;i<bytes.length;i++)child.stdout.emit('data',bytes.slice(i,i+1));
 child.emit('close',0,null);assert.equal(value,'Cepães 日本');
 console.log('PASS native executable launch and UTF-8 split across stdout chunks');
}
{
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
 const reader=new DestinationCapture({spawn:()=>child});assert(reader.start());
 child.stderr.emit('data','Detach incomplete');child.emit('close',1,null);
 assert(reader.locked);assert(!reader.start());
 console.log('PASS incomplete detach locks out subsequent capture');
}
