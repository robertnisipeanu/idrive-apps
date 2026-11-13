'use strict';
const assert=require('assert'),{geocodes,Provider}=require('../vela_routes');
const feature=(postal,country,type)=>({properties:{name:postal,feature_type:type,coordinates:{longitude:-8.78,latitude:41.54},context:{postcode:{name:postal},country:{country_code:country}}}});
assert.throws(()=>geocodes({features:[feature('5574','NO','address'),feature('4740-576','PT','street')]},'4740-575'),/No address candidates/);
assert.equal(geocodes({features:[feature('4740-575','PT','postcode')]},'4740-575').length,1);
let calls=0;
const p=new Provider({get:async address=>{calls++;assert(address.includes('country=pt'));assert(address.includes('types=postcode,address,street'));return {features:[feature('5574','NO','address')]};}});
p.compute({longitude:-8.78,latitude:41.54},[{address:'4740-575 Esposende'}],'fixture').then(()=>{throw Error('Expected rejection');},e=>{assert.match(e.message,/No address candidates/);assert.equal(calls,1);console.log('PASS postal matching rejects foreign/mismatched results before route request');}).catch(e=>{console.error(e);process.exitCode=1;});
