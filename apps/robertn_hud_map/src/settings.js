'use strict';
// turnX/turnY: the turn panel's offset from the HUD's bottom-right corner (px); turnSize: its size (%)
const defaults={enabled:false,zoom:100,size:100,mapWidth:100,mapHeight:100,x:0,y:0,horizon:20,distance:135,opacity:85,cameras:true,turnX:-180,turnY:-110,turnSize:100,currentStreetVisible:true,streetVisible:true,streetX:-120,streetY:-50,streetSize:100,streetWidth:100,streetHeight:100};
const ranges={zoom:[50,200],size:[30,100],mapWidth:[25,200],mapHeight:[25,200],x:[-200,200],y:[-120,120],horizon:[20,110],distance:[80,180],opacity:[30,100],turnX:[-720,100],turnY:[-440,100],turnSize:[50,200],streetX:[-700,100],streetY:[-400,100],streetSize:[50,200],streetWidth:[25,200],streetHeight:[75,300]};
function validate(value){if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid settings');const out=Object.assign({},defaults);for(const k of Object.keys(value)){if(!Object.prototype.hasOwnProperty.call(defaults,k))throw Error('Unknown setting');const v=value[k];if(typeof defaults[k]==='boolean'){if(typeof v!=='boolean')throw Error('Invalid toggle');}else if(!Number.isInteger(v)||v<ranges[k][0]||v>ranges[k][1])throw Error('Setting outside range');out[k]=v;}return constrain(out);}
// Insets are in the 800x480 rendering canvas, independent of map transforms.
const inset={left:40,top:40,right:760,bottom:440};
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
function panel(s,kind){
 const turn=kind==='turn',scale=(s.turnSize||100)/100;
 const width=turn?150*scale:300*(s.streetWidth||100)/100,height=turn?170*scale:60*(s.streetHeight||100)/100;
 const x=(turn?776:766)-width+(turn?(s.turnX||0):(s.streetX||0));
 const y=456-height+(turn?(s.turnY||0):(s.streetY||0));
 return {x:clamp(x,inset.left,inset.right-width),y:clamp(y,inset.top,inset.bottom-height),width,height};
}
function constrain(s){for(const kind of ['turn','street']){const p=panel(s,kind);s[kind+'X']=Math.round(p.x+p.width-(kind==='turn'?776:766));s[kind+'Y']=Math.round(p.y+p.height-456);}return s;}
function centre(s,kind){const p=panel(s,kind),v={};v[kind+'X']=Math.round(400+p.width/2-(kind==='turn'?776:766));v[kind+'Y']=Math.round(240+p.height/2-456);return v;}
function view(s){return [s.zoom/100,s.size/100,s.x,s.y];}
function map(s){return [(s.mapWidth===undefined?100:s.mapWidth)/100,(s.mapHeight===undefined?100:s.mapHeight)/100,s.horizon+40770/s.distance,0];}
function mapPoint(p,s){const m=map(s),dy=p[1]-m[2];return [400+(p[0]-400)*m[0],m[2]+Math.min(dy,0)*m[1]+Math.max(dy,0)];}
function camera(s){return [s.horizon,s.distance,40770];}
function worldVS(source){return 'uniform vec4 u_view;uniform vec4 u_map;\n'+source.replace('d=a_position.xy-u_pose.xy','d=(a_position.xy-u_pose.xy)*u_view.x').replace('gl_Position=vec4(x*1.75,(1.-u_camera.x/240.)*w-u_camera.z/240.,0.,w);','gl_Position=vec4(x*1.75,(1.-u_camera.x/240.)*w-u_camera.z/240.,0.,w);float anchor=(1.-u_map.z/240.)*w;gl_Position.x*=u_map.x;gl_Position.y=anchor+max(gl_Position.y-anchor,0.)*u_map.y+min(gl_Position.y-anchor,0.);gl_Position.xy=gl_Position.xy*u_view.y+vec2(u_view.z/400.,-u_view.w/240.)*w;');}
module.exports={defaults,ranges,validate,panel,centre,constrain,view,map,mapPoint,camera,worldVS};
