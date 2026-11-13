'use strict';
const assert=require('assert'),local=require('../route_local'),scene=require('../scene');
const o=[-8.7,41.5],geo=(x,y)=>[o[0]+x/(111320*Math.cos(o[1]*Math.PI/180)),o[1]+y/111320];
const road=(points,name,extra)=>Object.assign({points:points.map(p=>geo(p[0],p[1])),name},extra||{});
const roads=[road([[0,-100],[0,400]],'Main'),road([[-200,100],[200,100]],'Next')];
const phone={kind:'intersection',direction:'RIGHT',distance:'100',unit:'METER',text:'Next'};
let result=local.build(roads,o,[0,0,0],phone);assert(result.coordinates);assert.equal(result.reason,'current road and next segment');
let pts=result.coordinates.map(p=>scene.local(p,o));assert(pts[pts.length-1][0]>90);assert(Math.abs(pts[pts.length-1][1]-100)<1);
result=local.build(roads,o,[0,0,0],Object.assign({},phone,{direction:'LEFT'}));pts=result.coordinates.map(p=>scene.local(p,o));assert(pts[pts.length-1][0]<-90);
assert.equal(local.build(roads,o,[0,0,0],null).coordinates,null);
assert.equal(local.build([],o,[0,0,0],phone).coordinates,null);
result=local.build([roads[0],Object.assign({},roads[1],{structure:'bridge'})],o,[0,0,0],phone);pts=result.coordinates.map(p=>scene.local(p,o));assert(pts.every(p=>Math.abs(p[0])<1));
result=local.build(roads,o,[50,100,Math.PI/2],{kind:'intersection',direction:'STRAIGHT_ON',distance:'150',unit:'METER'});pts=result.coordinates.map(p=>scene.local(p,o));assert(pts.every(p=>p[0]>=49));
result=local.build([road([[0,400],[0,-100]],'Main',{oneway:true})],o,[0,0,0],phone);assert.equal(result.coordinates,null);
const ambiguous=roads.concat(road([[0,100],[150,150]],'Other'));
result=local.build(ambiguous,o,[0,0,0],Object.assign({},phone,{text:''}));pts=result.coordinates.map(p=>scene.local(p,o));assert(pts.every(p=>Math.abs(p[0])<1));
console.log('PASS local roads: right/left turns, stale guidance, missing roads, bridge separation, post-turn trimming, one-way rejection and ambiguous turns');
const {geocodes,Provider}=require('../vela_routes');
const feature=(name,type,lon,lat)=>({properties:{name,feature_type:type,coordinates:{longitude:lon,latitude:lat},place_formatted:'fixture'}});
const data={features:[feature('Porto','street',-60.79154,-37.53718),feature('Porto','place',-8.61,41.15)]};
assert.equal(geocodes(data,null,o,'Porto')[0].type,'place');
assert.throws(()=>geocodes({features:[data.features[0]]},null,o,'Porto'),/No plausible destination/);
console.log('PASS Porto city selected; Argentina rejected before directions request');
{ // dense city centre: streets every 60 m, a vertex every 15 m (thousands of segments within 800 m)
 const dense=[];for(let a=-1500;a<=1500;a+=60){const v=[],h=[];for(let b=-1500;b<=1500;b+=15){v.push([a,b]);h.push([b,a]);}dense.push(road(v,'V'+a),road(h,'H'+a));}
 const t0=Date.now(),r=local.build(dense,o,[5,3,0],{kind:'intersection',direction:'RIGHT',distance:'300',unit:'METER',text:''});
 assert(r.coordinates,'dense city geometry must still give a local line, got: '+r.reason);
 console.log('PASS dense city road graph gives a local line ('+(Date.now()-t0)+' ms)');
}
