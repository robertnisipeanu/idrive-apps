const vm=require('vm'),fs=require('fs'),assert=require('assert'),E=require('events'),net=require('net');
let lease={dns:['192.0.2.53']},servers=[],queries=[];
class Resolver{setServers(s){servers.push(s.slice());}resolve4(h,cb){queries.push(h);cb(null,['198.51.100.2']);}}
const proc=new E();proc.send=()=>{};
const context={require:n=>n==='net'?net:n==='dns'?{Resolver}: {readFileSync:()=>{if(!lease)throw Error('missing');return JSON.stringify(lease);}},process:proc,setTimeout,clearTimeout};
vm.createContext(context);vm.runInContext(fs.readFileSync(require('path').join(__dirname,'../net_broker.js'),'utf8'),context);
context.lookup('www.google.com',{},(e,ip,family)=>{assert.ifError(e);assert.equal(ip,'198.51.100.2');assert.equal(family,4);});
assert.equal(servers[0][0],'192.0.2.53');lease={dns:['192.0.2.54']};context.lookup('www.google.com',{},e=>assert.ifError(e));assert.equal(servers[1][0],'192.0.2.54');
lease=null;context.lookup('www.google.com',{},e=>assert.equal(e.code,'UPLINK_DNS_UNAVAILABLE'));
lease={dns:['invalid']};context.lookup('www.google.com',{},e=>assert.equal(e.code,'UPLINK_DNS_UNAVAILABLE'));
console.log('PASS lease DNS selection, IPv4 handoff, lease refresh and missing/invalid DNS rejection');
