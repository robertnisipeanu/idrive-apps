'use strict';
process.env.NODE_PATH=require('path').resolve(__dirname,'../vendor');require('module').Module._initPaths();
const assert=require('assert'),E=require('events'),{Runtime}=require('../runtime'),S=require('../settings');
class Renderer extends E{constructor(){super();this.ready=true;this.id=0;this.colors=[];}mesh(){return ++this.id;}asset(){return ++this.id;}pixels(){return true;}part(){return true;}bind(){}uniform(r,k,v){if(k==='u_color')this.colors.push(v);}geometry(){return true;}set(){}drop(){}close(){}}
const o=[-8.7,41.5],geo=(x,y)=>[o[0]+x/(111320*Math.cos(o[1]*Math.PI/180)),o[1]+y/111320];
const roads=[{points:[geo(0,-50),geo(0,400)],name:'Main'},{points:[geo(-150,100),geo(150,100)],name:'Next'}];
for(const mismatch of [false,true]){
 const cr=new Renderer(),rt=new Runtime({client:cr,clock:()=>10000,guidance:()=>({kind:'intersection',direction:'RIGHT',distance:'100',unit:'METER',text:'Next'})});
 rt.settings=S.validate({enabled:true});rt.origin=o;rt.pose=[0,0,0];rt.target=[0,0,0];rt.roads=roads;rt.lastFeed=10000;
 rt.route={coordinates:[geo(0,0),geo(0,80)],mapOnly:!mismatch,localFallback:mismatch,traffic:{status:'unavailable'}};
 rt.cameraFeed={snapshot:()=>({status:'unavailable'})};rt.tick();
 assert(!rt.error,rt.lastError);assert(rt.visible);assert(cr.colors.some(c=>c[0]===0&&c[1]===.83&&c[2]===.98));
}
console.log('PASS cyan renderer fallback during missing route and full-route mismatch');
