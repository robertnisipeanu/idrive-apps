'use strict';
// Node 8. Google web directions request/response layout adapted from Vela
// (GPL-3.0), pinned in vela_template.json. See VELA-NOTES.md and VELA-LICENSE.txt.
const https=require('https'),url=require('url'),G=require('./guidance'),zlib=require('zlib');
const MAX_WIRE_BYTES=8*1024*1024,MAX_JSON_BYTES=16*1024*1024;
const template=require('./vela_template.json').directionsPb;
const point=p=>Array.isArray(p)&&p.length===2&&Number.isFinite(p[0])&&Math.abs(p[0])<=180&&Number.isFinite(p[1])&&Math.abs(p[1])<=85;
const get=(v,path)=>path.reduce((a,i)=>a==null?undefined:a[i],v);
function json(text){if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>MAX_JSON_BYTES)throw Error('Invalid directions response');return JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/,''));}
function request(address){return new Promise((resolve,reject)=>{
 const opts=url.parse(address);opts.headers={'User-Agent':'Mozilla/5.0','Accept':'application/json','Accept-Language':'en','Accept-Encoding':'gzip'};
 let done=false,timer,body,res,req,chunks=[];
 const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);chunks=[];
  if(err){if(body&&body!==res)body.destroy();if(res)res.destroy();if(req)req.destroy();reject(err);}else resolve(value);
 };
 req=https.get(opts,response=>{
  res=response;
  if(res.statusCode!==200){finish(Error('Route service HTTP '+res.statusCode));return;}
  const encoding=String(res.headers['content-encoding']||'identity').toLowerCase();
  if(encoding!=='gzip'&&encoding!=='identity'){finish(Error('Route response unsupported encoding'));return;}
  const compressed=encoding==='gzip',wireLimit=compressed?MAX_WIRE_BYTES:MAX_JSON_BYTES;
  const declared=Number(res.headers['content-length']);
  if(Number.isFinite(declared)&&declared>wireLimit){finish(Error('Route response too large: '+Math.ceil(declared/1048576)+' MiB '+(compressed?'compressed':'JSON')));return;}
  let wire=0,size=0;body=compressed?zlib.createGunzip():res;
  res.on('data',b=>{if(done)return;wire+=b.length;if(wire>wireLimit)finish(Error('Route response too large: '+(compressed?'compressed >8 MiB':'JSON >16 MiB')));});
  res.on('error',()=>finish(Error('Route response interrupted')));
  res.on('aborted',()=>finish(Error('Route response interrupted')));
  body.on('error',()=>finish(Error('Route response decompression failed')));
  body.on('data',b=>{if(done)return;size+=b.length;
   if(size>MAX_JSON_BYTES){finish(Error('Route response too large: JSON >16 MiB'));return;}chunks.push(b);
  });
  body.on('end',()=>{if(done)return;try{const text=Buffer.concat(chunks,size).toString('utf8');chunks=[];finish(null,json(text));}catch(e){finish(Error('Route service returned invalid JSON'));}});
  if(compressed)res.pipe(body);
 });
 timer=setTimeout(()=>finish(Error('Route service timed out')),15000);
 req.on('error',e=>{const code=e&&typeof e.code==='string'&&/^[A-Z0-9_]{1,50}$/.test(e.code)?' ('+e.code+')':'';finish(Error('Route service connection failed'+code));});
});}
function directionsURL(points){
 if(!Array.isArray(points)||points.length<2||points.length>21||!points.every(point))throw Error('Invalid route points');
 const last=points[points.length-1],group='!1m4!3m2!3d{DLAT}!4d{DLNG}!6e2';
 let pb=template.replace(group,points.slice(1,-1).map(p=>'!1m4!3m2!3d'+p[1]+'!4d'+p[0]+'!6e2').join('')+group);
 const values={OLAT:points[0][1],OLNG:points[0][0],DLAT:last[1],DLNG:last[0],MODE:0};
 Object.keys(values).forEach(k=>{pb=pb.split('{'+k+'}').join(String(values[k]));});
 return 'https://www.google.com/maps/preview/directions?authuser=0&hl=en&gl=pt&pb='+encodeURIComponent(pb);
}
function geometry(raw){
 const lat=raw&&raw[0],lon=raw&&raw[1];
 if(!Array.isArray(lat)||!Array.isArray(lon)||lat.length!==lon.length||lat.length<2||lat.length>100000)throw Error('Missing route geometry');
 let a=0,b=0;return lat.map((v,i)=>{if(!Number.isSafeInteger(v)||!Number.isSafeInteger(lon[i]))throw Error('Invalid coordinate delta');a+=v;b+=lon[i];const p=[b/1e7,a/1e7];if(!point(p))throw Error('Invalid route coordinate');return p;});
}
function plain(s){return s.replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;|&apos;/g,"'").replace(/&quot;/g,'"').trim();}
function instruction(node){
 const markup=typeof node[1]==='string'?node[1]:'',tokens=Array.isArray(node[14])?node[14]:[];
 const text=markup?plain(markup):tokens.map(v=>get(v,[1,0])).filter(v=>typeof v==='string').join('');
 const attr=(s,k)=>{const m=new RegExp('\\b'+k+"=['\"]([^'\"]+)['\"]").exec(s);return m?m[1]:null;};
 const token=attr(markup,'maneuver'),turn=/<turn\b[^>]*>/.exec(markup),sideWord=turn?attr(turn[0],'side'):null;
 const side=sideWord?sideWord.toLowerCase():(/\b(?:turn(?: slightly| sharply)?|keep|bear) (left|right)\b/i.exec(text)||[])[1]||null;
 let type='unknown',exit=null;
 if(token==='DEPART'||/^Head\b/i.test(text))type='depart';
 else if(token==='ROUNDABOUT_ENTER_AND_EXIT'||/roundabout/i.test(text)){type='roundabout';const ex=/<exit\b[^>]*>(\d+)/.exec(markup)||/take the (\d+)(?:st|nd|rd|th) exit/i.exec(text);exit=ex?Number(ex[1]):null;}
 else if(token==='UTURN'||/U-turn/i.test(text))type='uturn';
 else if(token==='TURN'||/\bturn (?:slightly |sharply )?(?:left|right)/i.test(text)){type=/SLIGHT|slightly/i.test(markup||text)?'slight':/SHARP|sharply/i.test(markup||text)?'sharp':'turn';}
 else if(token==='ON_RAMP'||token==='OFF_RAMP'||/\bramp\b|^Take exit/i.test(text))type='ramp';
 else if(token==='FORK'||/^Keep (left|right)/i.test(text))type='fork';
 else if(token==='MERGE'||/^Merge\b/i.test(text))type='merge';
 else if(token==='NAME_CHANGE')type='name_change';
 else if(token==='STRAIGHT'||/^Continue\b/i.test(text))type='straight';
 const roads=[];markup.replace(/<road\b[^>]*>(.*?)<\/road>/g,(m,s)=>{roads.push(plain(s));return m;});
 const road=roads.length?roads[roads.length-1]:require('./routes').instructionRoad(text).road;
 return {maneuver:{type,side,roundabout_exit:exit},instruction:text.slice(0,200),road};
}
function positive(v){return Number.isFinite(v)&&v>0;}
function parse(data,requested){
 const raw=get(data,[0,1]),shapes=get(data,[0,7]);
 if(!Array.isArray(raw)||!raw.length||raw.length>20||!Array.isArray(shapes))throw Error('No web driving routes');
 const candidates=[],rejections=[];
 raw.forEach((r,index)=>{
  try{
   const coordinates=geometry(shapes[index]),cum=G.cumulative(coordinates),length=cum[cum.length-1],meters=get(r,[0,2,0]),duration=get(r,[0,10,0,0])||get(r,[0,3,0]);
   if(!positive(meters)||!positive(duration)||!positive(length)||Math.abs(length-meters)>Math.max(100,meters*.1))throw Error('Inconsistent route geometry');
   if(G.dist(coordinates[0],requested[0])>500||G.dist(coordinates[coordinates.length-1],requested[requested.length-1])>500)throw Error('Route endpoint outside request');
   const rawLegs=r[1];if(!Array.isArray(rawLegs)||rawLegs.length!==requested.length-1)throw Error('Stop count mismatch');
   const legs=[],steps=[],points=[];let floor=0,total=0,before=0;
   rawLegs.forEach((leg,li)=>{
    const lm=get(leg,[0,2,0]),ls=get(leg,[0,3,0]),groups=leg[1];if(!positive(lm)||!positive(ls)||!Array.isArray(groups))throw Error('Invalid leg');
    const start=floor;let within=0;
    groups.forEach(group=>{if(!Array.isArray(group[1]))throw Error('Invalid step group');group[1].forEach(w=>{
     const n=w[0],p=get(n,[7,2]),loc=p&&[p[3],p[2]],distance=get(n,[2,0]);if(!point(loc)||!Number.isFinite(distance)||distance<0)throw Error('Missing step position');
     const expected=(before+within)*length/meters,window=Math.max(80,expected*.05);
     const hits=G.projections(coordinates,cum,loc,30,Math.max(floor-1,expected-window),expected+window).filter(h=>h.along>=floor-1);
     hits.sort((a,b)=>Math.abs(a.along-expected)-Math.abs(b.along-expected));if(!hits.length)throw Error('Step does not align');
     const along=hits[0].along,ins=instruction(n);floor=along;
     const step=Object.assign({along,leg:li,distance_m:distance,static_s:get(n,[3,0])||0},ins);steps.push(step);
     // Unknown instructions remain explicit boundaries: never extrapolate past them.
     if(along>1&&ins.maneuver.type!=='depart')points.push({along,maneuver:ins.maneuver,road:ins.road,leg:li});
     within+=distance;
    });});
    if(Math.abs(within-lm)>Math.max(30,lm*.03))throw Error('Incomplete steps');
    total+=lm;before+=lm;
    let end=length;
    if(li<rawLegs.length-1){const hits=G.projections(coordinates,cum,requested[li+1],100,floor,length);hits.sort((a,b)=>Math.abs(a.along-before*length/meters)-Math.abs(b.along-before*length/meters));if(!hits.length)throw Error('Stop outside route');end=hits[0].along;}
    legs.push({index:li,start_along:start,end_along:end,distance_m:lm,duration_s:duration*lm/meters,static_s:ls});floor=end;
    points.push({along:end,maneuver:{type:'destination',side:null,roundabout_exit:null},leg:li});
   });
   if(Math.abs(total-meters)>Math.max(30,meters*.03))throw Error('Leg totals differ');
   points.sort((a,b)=>a.along-b.along);points.forEach(p=>{const xy=G.pointAt(coordinates,cum,p.along).point;p.key=xy.map(v=>v.toFixed(4)).join(',')+'|'+p.maneuver.type+'|'+p.maneuver.side;});
   candidates.push({coordinates,cum,length_m:length,scale:meters/length,distance_m:meters,duration_s:duration,alternative_index:index,labels:[],legs,steps,points,steps_located:1,traffic:{status:'unavailable',intervals:[]},attribution:'Google Maps',provider:'vela'});
  }catch(e){const known=/^(Inconsistent route geometry|Route endpoint outside request|Stop count mismatch|Invalid leg|Invalid step group|Missing step position|Step does not align|Incomplete steps|Stop outside route|Leg totals differ|Missing route geometry|Invalid coordinate delta|Invalid route coordinate)$/;const why=known.test(e.message)?e.message:'Unexpected response layout';if(rejections.indexOf(why)<0)rejections.push(why);}
 });
 if(!candidates.length)throw Error('Route validation failed: '+rejections.slice(0,3).join('; '));
 return {candidates,quality:'unknown',destination_key:requested.slice(1).map(p=>p.join(',')).join(';'),alternatives_returned:candidates.length,provider:'vela',attribution:'Google Maps'};
}
function geocodes(data,postal,origin,query){
 if(!data||!Array.isArray(data.features))throw Error('Invalid geocoding response');
 const out=[];
 data.features.forEach(f=>{const p=f.properties||{},c=p.coordinates||{},r=Array.isArray(c.routable_points)?c.routable_points.find(v=>v.name==='default'):null,xy=r?[r.longitude,r.latitude]:[c.longitude,c.latitude];
  if(postal){const ctx=p.context||{},code=ctx.postcode&&ctx.postcode.name||(p.feature_type==='postcode'?p.name:null),country=ctx.country&&ctx.country.country_code;if(code!==postal||String(country).toUpperCase()!=='PT')return;}
  if(['address','street','place','locality','neighborhood','postcode'].indexOf(p.feature_type)<0||!point(xy)||out.some(v=>G.dist(v.point,xy)<30))return;
  out.push({point:xy,name:String(p.name||''),type:p.feature_type,label:String(p.full_address||[p.name,p.place_formatted].filter(Boolean).join(', ')||f.place_name||'').slice(0,512),quality:p.feature_type==='address'&&p.match_code&&p.match_code.confidence==='exact'?'exact':p.feature_type==='street'?'street':'partial'});
 });
 if(!out.length)throw Error('No address candidates; supply a street address or coordinates');
 if(origin){
  // Automatic short text is not enough evidence for a destination on another continent.
  const nearby=out.filter(v=>G.dist(origin,v.point)<=1500000);
  if(!nearby.length)throw Error('No plausible destination within 1500 km; more specific destination needed');
  const norm=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const exactCity=v=>['place','locality'].indexOf(v.type)>=0&&norm(v.name)===norm(query);
  nearby.sort((a,b)=>Number(exactCity(b))-Number(exactCity(a))||G.dist(origin,a.point)-G.dist(origin,b.point));
  return nearby.slice(0,3);
 }
 return out.slice(0,3);
}
class Provider{
 constructor(options){const o=options||{};this.get=o.get||request;}
 async compute(fix,destinations,token,options){
  const origin=[fix.longitude,fix.latitude];if(!point(origin)||!Array.isArray(destinations)||!destinations.length||destinations.length>20)throw Error('Invalid route request');
  if(options&&options.via)throw Error('Via anchoring is not supported by this provider');
  let combos=[[]];
  for(const d of destinations){
   let found;
   if(d.coordinates!==undefined){if(!point(d.coordinates))throw Error('Invalid destination coordinates');found=[{point:d.coordinates,quality:'unknown'}];}
   else {if(typeof d.address!=='string'||!d.address.trim()||d.address.length>2048||typeof token!=='string'||!token)throw Error('Address and Mapbox token required');
    const match=/\b(\d{4}-\d{3})\b/.exec(d.address),postal=match&&match[1];
    found=geocodes(await this.get('https://api.mapbox.com/search/geocode/v6/forward?autocomplete=false&limit=10&types='+(postal?'postcode,address,street&country=pt':'address,street,place,locality,neighborhood,postcode')+'&proximity='+origin.join(',')+'&q='+encodeURIComponent(d.address)+'&access_token='+encodeURIComponent(token)),postal,origin,d.address).slice(0,1);}
   const next=[];combos.forEach(c=>found.forEach(f=>{if(next.length<3)next.push(c.concat([f]));}));combos=next;
  }
  const sets=[],failures=[];for(const combo of combos){try{const pts=[origin].concat(combo.map(v=>v.point));const set=parse(await this.get(directionsURL(pts)),pts);set.quality=combos.length===1&&combo.every(v=>v.quality==='exact')?'exact':'partial';sets.push(set);}catch(e){const msg=String(e&&e.message||'');failures.push(/^(Route service |Route response |Route validation failed: |No web driving routes)/.test(msg)?msg.slice(0,240):'Unexpected route response');}}
  if(!sets.length)throw Error('Destination resolved; '+(failures[0]||'route unavailable'));
  const candidates=[];sets.forEach(s=>s.candidates.forEach(c=>{if(candidates.length<8){c.alternative_index=candidates.length;candidates.push(c);}}));
  return {candidates,quality:combos.length===1?sets[0].quality:'partial',destination_key:combos.map(c=>c.map(v=>v.point.join(',')).join(';')).join('|'),alternatives_returned:candidates.length,provider:'vela',attribution:'Google Maps'};
 }
}
module.exports={Provider,parse,geometry,instruction,json,directionsURL,geocodes,request,point};
