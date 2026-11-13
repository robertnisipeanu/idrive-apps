'use strict';
const assert=require('assert'),path=require('path'),Module=require('module'),EventEmitter=require('events');
const root=process.argv[2]||path.resolve(__dirname,'..');
process.env.NODE_PATH=path.join(root,'vendor');Module._initPaths();
const {Service}=require(root+'/service'),{MapFeed}=require(root+'/map_feed'),{RouteFull}=require(root+'/route_full'),{RouteMatch}=require(root+'/route_match'),{Runtime}=require(root+'/runtime'),scene=require(root+'/scene');
const origin=[-9.14,38.72],geo=(x,y)=>[origin[0]+x/(111320*Math.cos(origin[1]*Math.PI/180)),origin[1]+y/111320];
const right=[geo(0,0),geo(0,100),geo(100,100),geo(100,200)],left=[geo(0,0),geo(0,100),geo(-100,100),geo(-100,200),geo(100,200)];
const candidate=(side)=>({coordinates:side==='right'?right:left,steps:[{along:100,maneuver:{type:'turn',side},road:'Rua A'}],distance_m:side==='right'?300:500,duration_s:40,alternative_index:0});
const flush=()=>new Promise(r=>setImmediate(r));
class Renderer extends EventEmitter{constructor(){super();this.ready=true;this.id=0;this.colors=[];this.uploads=0;}mesh(){return ++this.id;}asset(){return ++this.id;}pixels(){return true;}part(){return true;}bind(){}uniform(r,k,v){if(k==='u_color')this.colors.push(v);}geometry(){this.uploads++;return true;}set(){}drop(){}close(){}}
async function main(){let now=10000,service,resolveReroute,calls=0;
 const full=new RouteFull({wall:()=>now,token:()=> 'pk.fixture',fetchRoute:(token,from,to)=>service.fetchVelaRoute(token,from,to)});
 const match=new RouteMatch({wall:()=>now});
 const feed=new MapFeed({clock:()=>now*1e6,wall:()=>now,full,match,maneuver:()=>service.currentGuidance()});feed.mapboxToken=()=> 'pk.fixture';
 service=new Service({file:path.join(__dirname,'absent-settings'),full,match,mapFeed:feed,runtime:{applySettings(){}},destinationCapture:{state:{},start:()=>true},vela:{compute:()=>{calls++;return calls===1?Promise.resolve({destination_key:right[3].join(','),candidates:[candidate('right')]}):new Promise(r=>resolveReroute=r);}}});
 function position(){feed.position({raw:{fixType:'FIX_3D',position:{coordinatesValid:true,longitude:origin[0],latitude:geo(0,(now-10000)/1000*5)[1]}}});}
 function guidance(side){service.setGuidance({kind:'intersection',direction:side.toUpperCase(),distance:'100',unit:'METER',text:'Rua A'});}
 position();guidance('right');assert.equal((await feed.fetch('map://feed/route')).route.mapOnly,true);
 service.setDestination({address:'Synthetic destination'});await flush();assert.equal(service.destError,null);
 let r=await feed.fetch('map://feed/route');assert.equal(r.route.mapOnly,false);assert.deepStrictEqual(r.route.coordinates,right);
 const renderer=new Renderer(),runtime=new Runtime({client:renderer,clock:()=>now,feed:'map://feed',fetch:u=>feed.fetch(u),guidance:()=>service.currentGuidance(),roadSource:{near:async()=>[]},cameraFeed:{ensure(){},snapshot:()=>({status:'unavailable'})}});
 await runtime.poll();runtime.tick();assert(runtime.visible);assert(renderer.uploads>0);assert(renderer.colors.some(c=>c[0]===0&&c[1]===.83&&c[2]===.98),'cyan geometry must reach renderer');
 console.log('PASS captured destination -> service -> feed -> runtime cyan mesh');
 now+=600;position();guidance('left');await feed.fetch('map://feed/route');assert.equal(calls,1);
 now+=600;position();guidance('left');await feed.fetch('map://feed/route');assert.equal(match.state,'mismatch');assert.equal(calls,1,'Vela waits until the phone turn has settled');
 now+=600;position();guidance('left');r=await feed.fetch('map://feed/route');assert.equal(calls,2);assert.equal(match.state,'mismatch');
 const end=r.route.coordinates.slice(-1)[0];assert(Math.abs(end[0]-origin[0])<1e-9);assert(end[1]<right[1][1],'line ends before disputed turn');assert.equal(service.currentGuidance().direction,'LEFT');
 console.log('PASS conflicting cyan line clipped before junction; phone turn stays authoritative');
 resolveReroute({candidates:[candidate('left')]});await flush();assert(Array.isArray(full.steps()[0].at));
 now+=600;position();guidance('left');r=await feed.fetch('map://feed/route');assert.deepStrictEqual(r.route.coordinates.slice(1),left.slice(1));assert(r.route.coordinates[0][1]>left[0][1],'completed geometry is trimmed');assert.equal(match.last.routeSide,'left');
 console.log('PASS Vela reroute normalized, rematched and displayed without exception');
 service.guidance.at-=4000;r=await feed.fetch('map://feed/route');assert.equal(r.route.mapOnly,false,'a short phone gap (recalculation) keeps the line');
 service.guidance.at-=8000;now+=11000;position();r=await feed.fetch('map://feed/route');assert.equal(r.route.mapOnly,true,'guidance gone beyond the hold hides the line');
 service.setDestination(null);guidance('left');r=await feed.fetch('map://feed/route');assert.equal(r.route.mapOnly,true);
 now+=4000;await assert.rejects(feed.fetch('map://feed/route'));runtime.stop();
 console.log('PASS expired guidance, cleared destination and stale GPS suppress route display');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
