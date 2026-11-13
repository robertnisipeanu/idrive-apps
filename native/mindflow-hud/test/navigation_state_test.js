'use strict';
const assert=require('assert'),path=require('path'),Module=require('module');
const root=process.argv[2]||path.resolve(__dirname,'..');process.env.NODE_PATH=path.join(root,'vendor');Module._initPaths();
const {Service}=require(root+'/service'),{RouteFull,stepsOf}=require(root+'/route_full'),{RouteMatch}=require(root+'/route_match'),{MapFeed}=require(root+'/map_feed');
const O=[-9.14,38.72],geo=(x,y)=>[O[0]+x/(111320*Math.cos(O[1]*Math.PI/180)),O[1]+y/111320],coords=[O,geo(0,200),geo(200,200)];
const candidate={coordinates:coords,steps:[{along:200,maneuver:{type:'turn',side:'right'}}],duration_s:30,distance_m:400,alternative_index:0};
const result={destination_key:coords[2].join(','),candidates:[candidate]};
const tick=()=>new Promise(r=>setImmediate(r));
function svc(provider){const feed=new MapFeed();feed.mapboxToken=()=> 'pk.fixture';feed.position({raw:{fixType:'FIX_3D',position:{coordinatesValid:true,longitude:O[0],latitude:O[1]}}});return new Service({file:path.join(__dirname,'absent-settings'),mapFeed:feed,runtime:{applySettings(){}},destinationCapture:{state:{},start:()=>true},vela:provider});}
async function main(){
 let now=10000,calls=0,phone={kind:'intersection',direction:'LEFT',distance:'200',unit:'METER'};
 const full=new RouteFull({token:'pk.fixture',wall:()=>now,fetchRoute:()=>{calls++;return new Promise(()=>{});}});full.setDestination(coords[2]);full.setRouteCandidate(candidate,O);
 const match=new RouteMatch({wall:()=>now}),feed=new MapFeed({clock:()=>now*1e6,full,match,maneuver:()=>phone});
 function position(y){const p=geo(0,y);feed.position({raw:{fixType:'FIX_3D',position:{coordinatesValid:true,longitude:p[0],latitude:p[1]}}});}
 position(0);await feed.fetch('map://feed/route');now+=600;position(0);let r=await feed.fetch('map://feed/route');await tick();assert.equal(calls,0);assert.equal(match.disagree,0);assert.deepStrictEqual(r.route.coordinates,coords);
 now+=600;position(4);await feed.fetch('map://feed/route');assert.equal(match.disagree,1);
 for(let i=0;i<5;i++){now+=600;await feed.fetch('map://feed/route');}assert.equal(match.disagree,1,'polls of one position cannot create evidence');assert.equal(calls,0);
 now+=600;position(30);r=await feed.fetch('map://feed/route');await tick();assert.equal(calls,1);assert.equal(match.state,'mismatch');assert(r.route.coordinates.slice(-1)[0][1]<coords[1][1]);
 now+=600;position(30);await feed.fetch('map://feed/route');await tick();assert.equal(calls,1,'stopping must not start another correction');
 console.log('PASS parked fastest route retained; movement enables correction; repeated polls and stopping do not reroute');
 const jobs=[];const s=svc({compute:()=>new Promise((resolve,reject)=>jobs.push({resolve,reject}))});
 s.setDestination({address:'A'});await tick();s.setDestination({address:'B'});jobs.shift().resolve(result);await tick();assert.equal(s.full.active(),false,'obsolete A result not applied');assert.equal(jobs.length,1,'queued B starts automatically');jobs.shift().resolve(result);await tick();assert.equal(s.lastDestinationAddress,'B');assert.equal(s.destinationBusy,false);
 console.log('PASS newer destination queues and obsolete address result is discarded');
 s.setDestination({address:'C'});await tick();s.setDestination({coord:geo(400,400)});jobs.shift().reject(Error('old request failed'));await tick();assert.deepStrictEqual(s.full.dest,geo(400,400));assert.equal(s.destError,null);
 console.log('PASS old address errors cannot overwrite a newer coordinate destination');
 const routeJobs=[];const f=new RouteFull({token:'pk.fixture',wall:()=>20000,fetchRoute:()=>new Promise((resolve,reject)=>routeJobs.push({resolve,reject}))});
 f.setDestination(coords[2]);f.plan(O,'first');await tick();f.setDestination(null);f.setDestination(coords[2]);f.plan(O,'first');await tick();routeJobs[0].resolve(candidate);await tick();assert.equal(f.route,null);assert.equal(f.fetching,true);routeJobs[1].resolve(candidate);await tick();assert(f.route);assert.equal(f.fetching,false);
 console.log('PASS same-coordinate cancel/reselect cannot revive an old route request');
 const round=Object.assign({},candidate,{steps:[{along:200,maneuver:{type:'roundabout',side:'right',roundabout_exit:2}}]});assert.equal(stepsOf(round)[0].exit,2);
 const moving=svc({compute:async()=>({candidates:[Object.assign({},round,{duration_s:10}),Object.assign({},round,{duration_s:20,steps:[{along:200,maneuver:{type:'roundabout',side:'right',roundabout_exit:4}}]})]})});
 moving.setGuidance({kind:'roundabout',side:'RIGHT',exit:4,distance:'200',unit:'METER',toDestination:900});moving.mapFeed.fix.speed=5;
 const chosen=await moving.fetchVelaRoute('pk.fixture',O,coords[2],'phone-mismatch');assert.equal(chosen.steps[0].maneuver.roundabout_exit,4);
 const first=await moving.fetchVelaRoute('pk.fixture',O,coords[2],'first');assert.equal(first.duration_s,10);
 moving.mapFeed.fix.speed=0;const parked=await moving.fetchVelaRoute('pk.fixture',O,coords[2],'manual');assert.equal(parked.duration_s,10);
 assert.equal(moving.currentGuidance().toDestination,900);assert.equal(moving.currentGuidance().distance_scope,'unknown');
 console.log('PASS roundabout exit retained and used while moving; first and parked selection stay fastest; distance scope stays explicit');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
