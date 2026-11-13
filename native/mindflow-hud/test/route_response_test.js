const assert=require('assert'),fs=require('fs'),vm=require('vm'),zlib=require('zlib'),stream=require('stream'),E=require('events');
let payload,encoding,declared,seenHeaders;
const https={get:(opts,cb)=>{seenHeaders=opts.headers;const req=new E();req.destroy=()=>{};process.nextTick(()=>{const res=new stream.PassThrough();res.statusCode=200;res.headers={'content-encoding':encoding};if(declared)res.headers['content-length']=declared;cb(res);res.end(payload);});return req;}};
const moduleMock={exports:{}};
vm.runInNewContext(fs.readFileSync(require('path').join(__dirname,'../vela_routes.js'),'utf8'),{require:n=>n==='https'?https:n==='./guidance'?{}:n==='./vela_template.json'?{directionsPb:''}:require(n),module:moduleMock,Buffer,setTimeout,clearTimeout});
async function run(){
 const value=JSON.stringify({data:'x'.repeat(9*1024*1024)});
 payload=Buffer.from(value);encoding='identity';assert.equal((await moduleMock.exports.request('https://example.invalid')).data.length,9*1024*1024);
 payload=zlib.gzipSync(value);encoding='gzip';assert.equal((await moduleMock.exports.request('https://example.invalid')).data.length,9*1024*1024);assert.equal(seenHeaders['Accept-Encoding'],'gzip');
 payload=zlib.gzipSync(JSON.stringify({data:'x'.repeat(17*1024*1024)}));await assert.rejects(moduleMock.exports.request('https://example.invalid'),/JSON >16 MiB/);
 payload=Buffer.from('broken');await assert.rejects(moduleMock.exports.request('https://example.invalid'),/decompression failed/);
 encoding='identity';payload=Buffer.from('<html>');await assert.rejects(moduleMock.exports.request('https://example.invalid'),/invalid JSON/);
 encoding='gzip';declared=9*1024*1024;await assert.rejects(moduleMock.exports.request('https://example.invalid'),/compressed/);
 console.log('PASS 9 MiB raw/gzip responses, decoded and wire limits, corrupt compression and invalid JSON');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
