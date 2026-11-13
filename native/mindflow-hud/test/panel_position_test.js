'use strict';
const assert=require('assert'),S=require('../settings'),L=require('../labels'),font=require('../font.json'),P=require('../../../apps/robertn_hud_map/src/page');
for(const kind of ['turn','street'])for(const size of [50,100,200])for(const width of [25,100,200])for(const height of [75,100,300]){
 let s=S.validate({turnSize:size,streetSize:size,streetWidth:width,streetHeight:height});
 const centred=P.change('centre',s,null,kind);s=S.validate(Object.assign({},s,centred.values));
 let p=S.panel(s,kind);assert(Math.abs(p.x+p.width/2-400)<=.5);assert(Math.abs(p.y+p.height/2-240)<=.5);
 for(const move of ['left','right','up','down']){for(let i=0;i<100;i++)s=S.validate(Object.assign({},s,P.change(move,s,null,kind).values));p=S.panel(s,kind);assert(p.x>=40&&p.y>=40&&p.x+p.width<=760.01&&p.y+p.height<=440.01);assert.deepStrictEqual(S.validate(s),s);}
}
const off=S.validate({turnX:-620,turnY:-300,streetX:-700,streetY:100});
for(const kind of ['turn','street']){const p=S.panel(off,kind);assert(p.x>=40&&p.y>=40&&p.x+p.width<=760&&p.y+p.height<=440);}
// Actual screen-space glyph vertices stay within the canvas despite map scaling.
for(const size of [30,100])for(const turnSize of [50,200]){
 const s=S.validate({size,turnSize,turnX:100,turnY:100,streetX:100,streetY:100,streetWidth:200,streetHeight:300});
 const a=L.build([],[0,0,0],font,null,null,s,null),b=L.build([],[0,0,0],font,null,null,s,{kind:'intersection',direction:'RIGHT',distance:'100',unit:'METER',text:'Long street name in the test'});
 for(let i=a.positions.length;i<b.positions.length;i+=3){const x=(b.positions[i]-400)*size/100+400+s.x,y=(b.positions[i+1]-240)*size/100+240+s.y;assert(x>=39.99&&x<=760.01&&y>=39.99&&y<=440.01);}
}
console.log('PASS true centering, repeated movement, size extremes, saved-position bounds and rendered glyph bounds');
