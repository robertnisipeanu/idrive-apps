'use strict';
// Node 8 route calculation. Computes candidate routes with maneuver steps; it
// does not copy the Maps app's chosen route. Selection against phone guidance
// happens in guidance.js; every returned alternative is retained here.
// Google-shaped helpers are retained for fixtures/OSM. compute() uses Vela web
// directions; this module no longer makes paid Google Routes API requests.
const G=require('./guidance');
const FIELDS=['routes.duration','routes.distanceMeters','routes.polyline.encodedPolyline','routes.routeLabels','routes.travelAdvisory.speedReadingIntervals',
 'routes.legs.distanceMeters','routes.legs.duration','routes.legs.staticDuration','routes.legs.endLocation',
 'routes.legs.steps.distanceMeters','routes.legs.steps.staticDuration','routes.legs.steps.startLocation','routes.legs.steps.navigationInstruction',
 'geocodingResults','fallbackInfo'].join(',');
function decode(text){
 if(typeof text!=='string'||text.length>2000000)throw Error('Invalid route geometry');
 let i=0,lat=0,lon=0;const out=[];
 function number(){let value=0,shift=0,b;do{if(i>=text.length||shift>30)throw Error('Invalid route geometry');b=text.charCodeAt(i++)-63;if(b<0||b>63)throw Error('Invalid route geometry');value+=(b&31)*Math.pow(2,shift);shift+=5;}while(b>=32);return value%2?-(value+1)/2:value/2;}
 while(i<text.length){lat+=number();lon+=number();if(Math.abs(lat)>8500000||Math.abs(lon)>18000000||out.length>=100000)throw Error('Invalid route geometry');out.push([lon/1e5,lat/1e5]);}
 if(out.length<2)throw Error('Invalid route geometry');return out;
}
function traffic(route,count){
 const raw=route.travelAdvisory&&route.travelAdvisory.speedReadingIntervals;
 if(!raw)return {status:'unavailable',intervals:[]};
 const bad={status:'invalid',intervals:[]},intervals=[];let previous=0;
 if(!Array.isArray(raw))return bad;
 for(const item of raw){if(!item)return bad;const start=item.startPolylinePointIndex===undefined?0:item.startPolylinePointIndex,end=item.endPolylinePointIndex;
  if(!Number.isInteger(start)||!Number.isInteger(end)||start!==previous||end<=start||end>=count||['NORMAL','SLOW','TRAFFIC_JAM'].indexOf(item.speed)<0)return bad;
  intervals.push({start,end,speed:item.speed});previous=end;
 }
 return previous===count-1?{status:'available',intervals}:bad;
}
function seconds(v){if(typeof v!=='string'||!/^\d+(\.\d+)?s$/.test(v))return null;const n=Number(v.slice(0,-1));return Number.isFinite(n)?n:null;}
function location(v){const l=v&&v.latLng;return l&&Number.isFinite(l.latitude)&&Math.abs(l.latitude)<=90&&Number.isFinite(l.longitude)&&Math.abs(l.longitude)<=180?[l.longitude,l.latitude]:null;}
// Locate a reported point on the polyline near where its cumulative API distance predicts.
function locate(coordinates,cum,p,expected,floor){
 if(!p)return null;const window=Math.max(60,.1*expected+30);
 const hits=G.projections(coordinates,cum,p,30,expected-window,expected+window).filter(h=>h.along>=floor-1);
 hits.sort((a,b)=>Math.abs(a.along-expected)-Math.abs(b.along-expected));return hits.length?hits[0].along:null;
}
// Street entered and roundabout exit from an English instruction (languageCode en-US).
// Street names themselves stay as Google writes them locally.
function instructionRoad(text){
 if(typeof text!=='string')return {road:null,exit:null};
 const line=text.split(/\r?\n/)[0],ex=/take the (\d+)(?:st|nd|rd|th) exit/i.exec(line),m=/\b(?:onto|stay on|continue on|on)\s+(.+?)(?:\s+(?:toward|towards|via|for)\b.*)?$/i.exec(line);
 let road=m?m[1].replace(/[.,;:]+$/,'').trim():null;if(road&&/^(the )?(left|right)\b/i.test(road))road=null;
 return {road:road||null,exit:ex?Number(ex[1]):null};
}
function key(p){return (Math.round(p[0]/2e-4)*2e-4).toFixed(4)+','+(Math.round(p[1]/2e-4)*2e-4).toFixed(4);}
// Build a candidate: geometry plus metric positions of legs and maneuver points.
function candidate(r,index){
 if(!r||typeof r!=='object')throw Error('Invalid route');
 const duration=seconds(r.duration);if(duration===null||duration<=0)throw Error('Invalid route duration');
 const coordinates=decode(r.polyline&&r.polyline.encodedPolyline);
 if(!Number.isFinite(r.distanceMeters)||r.distanceMeters<=0)throw Error('Invalid route distance');
 const cum=G.cumulative(coordinates),length=cum[cum.length-1];if(!(length>0))throw Error('Invalid route geometry');
 const scale=r.distanceMeters/length,raw=Array.isArray(r.legs)&&r.legs.length?r.legs:null,legs=[],steps=[];
 let before=0,start=0,floor=0,total=0,located=0;
 (raw||[{}]).forEach((leg,li)=>{
  let within=0;
  for(const st of Array.isArray(leg.steps)?leg.steps:[]){
   total++;const ins=st&&st.navigationInstruction||{},along=locate(coordinates,cum,location(st&&st.startLocation),(before+within)/scale,floor);
   if(along!==null){located++;floor=along;}
   const named=instructionRoad(ins.instructions),gm=G.googleManeuver(ins.maneuver);if(gm.type==='roundabout'&&named.exit)gm.roundabout_exit=named.exit;
   steps.push({along,leg:li,maneuver:gm,road:named.road,google_maneuver:typeof ins.maneuver==='string'?ins.maneuver:null,instruction:typeof ins.instructions==='string'?ins.instructions.slice(0,200):null,distance_m:Number.isFinite(st&&st.distanceMeters)?st.distanceMeters:0,static_s:seconds(st&&st.staticDuration)||0});
   within+=Number.isFinite(st&&st.distanceMeters)?st.distanceMeters:0;
  }
  const legMeters=Number.isFinite(leg.distanceMeters)?leg.distanceMeters:within;
  let end=length;
  if(raw&&li<raw.length-1){const at=locate(coordinates,cum,location(leg.endLocation),(before+legMeters)/scale,floor);end=at!==null?at:Math.min(length,(before+legMeters)/scale);}
  legs.push({index:li,start_along:start,end_along:end,distance_m:legMeters,duration_s:seconds(leg.duration),static_s:seconds(leg.staticDuration)});
  before+=legMeters;start=end;floor=Math.max(floor,end);
 });
 // Missing per-leg durations: share the route duration by leg length.
 legs.forEach(l=>{if(l.duration_s===null)l.duration_s=duration*(l.end_along-l.start_along)/length;});
 const points=[];
 steps.forEach(s=>{if(s.along!==null&&s.along>1&&s.maneuver.type!=='depart')points.push({along:s.along,maneuver:s.maneuver,road:s.road,leg:s.leg});});
 legs.forEach(l=>points.push({along:l.end_along,maneuver:{type:'destination',side:null,roundabout_exit:null},leg:l.index}));
 points.sort((a,b)=>a.along-b.along);
 points.forEach(p=>{p.key=key(G.pointAt(coordinates,cum,p.along).point)+'|'+p.maneuver.type+'|'+p.maneuver.side;});
 return {coordinates,cum,length_m:length,scale,distance_m:r.distanceMeters,duration_s:duration,alternative_index:index,labels:Array.isArray(r.routeLabels)?r.routeLabels.slice(0,4):[],legs,steps,points,steps_located:total?located/total:null,traffic:traffic(r,coordinates.length),attribution:'Google Maps'};
}
// Geocoding quality of the destination text, worst across all stops.
const EXACT=['street_address','premise','subpremise','establishment','point_of_interest','airport','park','transit_station','parking'];
const STREET=['route','intersection'];
const ORDER=['exact','street','partial','unknown','coarse','failed'];
function quality(geo,count){
 if(!geo||typeof geo!=='object')return 'unknown';
 const list=[].concat(Array.isArray(geo.intermediates)?geo.intermediates:[],geo.destination?[geo.destination]:[]);
 if(list.length<count)return 'unknown';
 let worst=0;
 for(const w of list){
  const types=Array.isArray(w&&w.type)?w.type:[];let q;
  if(!w||w.geocoderStatus&&w.geocoderStatus.code)q='failed';else if(w.partialMatch===true)q='partial';
  else if(types.some(t=>EXACT.indexOf(t)>=0))q='exact';else if(types.some(t=>STREET.indexOf(t)>=0))q='street';else if(types.length)q='coarse';else q='unknown';
  worst=Math.max(worst,ORDER.indexOf(q));
 }
 return ORDER[worst];
}
function parse(response,count){
 if(!response||!Array.isArray(response.routes)||!response.routes.length||response.routes.length>20)throw Error('No driving route returned');
 if(response.fallbackInfo)throw Error('Traffic routing fallback; route not started');
 const candidates=response.routes.map(candidate),last=candidates[0],geo=response.geocodingResults;
 const destination=geo&&geo.destination&&typeof geo.destination.placeId==='string'?geo.destination.placeId:key(last.coordinates[last.coordinates.length-1]);
 return {candidates,quality:quality(geo,count||1),destination_key:destination,alternatives_returned:candidates.length,attribution:'Google Maps'};
}
// Legacy shape: lowest predicted duration. Not used for display selection.
function select(response){
 const set=parse(response),c=set.candidates.slice().sort((a,b)=>a.duration_s-b.duration_s||a.alternative_index-b.alternative_index)[0];
 return {coordinates:c.coordinates,duration_s:c.duration_s,distance_m:c.distance_m,alternative_index:c.alternative_index,alternatives_returned:set.candidates.length,selection:'lowest predicted duration among returned routes',attribution:'Google Maps',traffic:c.traffic};
}
// A pre-candidate route object (coordinates only) becomes one candidate without steps.
function fromLegacy(route){
 if(!route||!Array.isArray(route.coordinates)||route.coordinates.length<2)throw Error('Invalid route');
 const coordinates=route.coordinates,cum=G.cumulative(coordinates),length=cum[cum.length-1];if(!(length>0))throw Error('Invalid route geometry');
 const distance=Number.isFinite(route.distance_m)&&route.distance_m>0?route.distance_m:length,duration=Number.isFinite(route.duration_s)&&route.duration_s>0?route.duration_s:length/14;
 const legs=[{index:0,start_along:0,end_along:length,distance_m:distance,duration_s:duration,static_s:null}];
 const end=coordinates[coordinates.length-1];
 return {candidates:[{coordinates,cum,length_m:length,scale:distance/length,distance_m:distance,duration_s:duration,alternative_index:0,labels:[],legs,steps:[],points:[{along:length,maneuver:{type:'destination',side:null,roundabout_exit:null},leg:0,key:key(end)+'|destination|null'}],steps_located:null,traffic:route.traffic||{status:'unavailable',intervals:[]},attribution:'Google Maps'}],quality:route.quality||'unknown',destination_key:key(end),alternatives_returned:1,attribution:'Google Maps'};
}
function body(fix,destinations,options){
 if(!fix||!Number.isFinite(fix.latitude)||Math.abs(fix.latitude)>85||!Number.isFinite(fix.longitude)||Math.abs(fix.longitude)>180)throw Error('Invalid origin');
 if(!Array.isArray(destinations)||destinations.length<1||destinations.length>20)throw Error('Invalid destinations');
 const points=destinations.map(d=>{if(!d||typeof d.address!=='string'||!d.address.trim()||d.address.length>2048)throw Error('Invalid destination');return {address:d.address};});
 // Google returns alternatives only without intermediates; multi-stop trips get one candidate.
 const out={origin:{location:{latLng:{latitude:fix.latitude,longitude:fix.longitude}}},destination:points[points.length-1],travelMode:'DRIVE',routingPreference:'TRAFFIC_AWARE_OPTIMAL',polylineQuality:'HIGH_QUALITY',polylineEncoding:'ENCODED_POLYLINE',computeAlternativeRoutes:points.length===1,units:'METRIC',languageCode:'en-US',extraComputations:['TRAFFIC_ON_POLYLINE']};
 // Heading biases the origin onto the road direction actually being driven.
 if(Number.isFinite(fix.heading_deg)&&Number.isFinite(fix.speed_mps)&&fix.speed_mps>=3)out.origin.location.heading=Math.round(fix.heading_deg)%360;
 const stops=points.slice(0,-1),via=options&&options.via;
 // A via point (no stopover, no extra leg) forces the route through a confirmed street.
 if(via){if(!Array.isArray(via)||!Number.isFinite(via[0])||!Number.isFinite(via[1])||Math.abs(via[1])>85||Math.abs(via[0])>180)throw Error('Invalid via point');const loc={latLng:{latitude:via[1],longitude:via[0]}};if(options&&Number.isFinite(options.heading))loc.heading=Math.round(options.heading)%360;stops.unshift({via:true,location:loc});out.computeAlternativeRoutes=false;}
 if(stops.length)out.intermediates=stops;return out;
}
function compute(fix,destinations,mapboxToken,options){
 return new (require('./vela_routes').Provider)().compute(fix,destinations,mapboxToken,options);
}
module.exports={instructionRoad,FIELDS,decode,traffic,seconds,candidate,quality,parse,select,fromLegacy,body,compute};
