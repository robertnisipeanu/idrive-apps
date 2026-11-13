'use strict';
const assert=require('assert'),fs=require('fs'),L=require('../labels'),S=require('../settings'),P=require('../../../apps/robertn_hud_map/src/page');
const font=require('../font.json'),cfg=S.validate({streetWidth:40,streetHeight:300});
const value='Rua de Cepães Travessa Manuel Boaventura';
const layout=L.streetLayout(value,font,cfg);
assert(layout.lines.length>1);assert.equal(layout.lines.map(l=>l.text).join(' '),value);
const h=48*layout.size/32;assert.equal(layout.lines[layout.lines.length-1].y+h,layout.bottom);
for(const l of layout.lines){assert(l.y>=layout.top);assert(l.x>=layout.left);}
const one=L.streetLayout('Rua',font,cfg);assert.equal(one.lines[0].y,layout.lines[layout.lines.length-1].y);
assert(L.streetLayout('W'.repeat(100),font,cfg).lines.length>1);
assert(L.streetLayout(value,font,S.validate({streetWidth:25,streetHeight:75})).lines.slice(-1)[0].text.endsWith('...'));
assert.equal(L.streetLayout(value,font,S.validate({streetSize:200,streetHeight:75})).lines.length,1);
const guidance={kind:'turn',direction:'RIGHT',distance:100,unit:'METER',text:value};
function streetVertices(c){const a=L.build([], [0,0,0],font,null,null,Object.assign({},c,{streetVisible:false}),guidance),b=L.build([], [0,0,0],font,null,null,c,guidance);return b.positions.slice(a.positions.length).map((v,i)=>i%3===0?(v-400)*c.size/100+400+c.x:i%3===1?(v-240)*c.size/100+240+c.y:v);}
const a=streetVertices(cfg),other=S.validate(Object.assign({},cfg,{turnX:-200,turnY:-100,turnSize:200,size:50,x:100,y:50,mapWidth:200,mapHeight:200})),b=streetVertices(other);
assert(a.length>0);a.forEach((v,i)=>assert(Math.abs(v-b[i])<1e-7,'street position independent of map and arrow'));
for(let i=0;i<a.length;i+=3){assert(a[i]>=layout.left-1e-7&&a[i]<=layout.right+1e-7);assert(a[i+1]>=layout.top-1e-7&&a[i+1]<=layout.bottom+1e-7);}
assert.deepStrictEqual(P.change('left',cfg,null,'street').values,{streetX:cfg.streetX-10});
assert.deepStrictEqual(P.change('larger',cfg,null,'street').values,{streetSize:110});
assert.deepStrictEqual(P.change('centre',cfg,null,'street').values,S.centre(cfg,'street'));
assert.deepStrictEqual(P.change('streetVisible',cfg).values,{streetVisible:false});
assert.equal(P.nextMode('map'),'turn');assert.equal(P.nextMode('turn'),'street');assert.equal(P.nextMode('street'),'map');
assert.equal(S.validate({}).streetVisible,true);
console.log('PASS street text: upward wrapping, bounds, overflow, long words, independence, visibility and controls');
