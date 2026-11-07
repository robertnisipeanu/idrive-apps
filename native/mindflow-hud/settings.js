'use strict';
const defaults={enabled:false,zoom:100,size:100,x:0,y:0,horizon:20,distance:135,opacity:85,cameras:true};
const ranges={zoom:[50,200],size:[30,100],x:[-200,200],y:[-120,120],horizon:[20,110],distance:[80,180],opacity:[30,100]};
function validate(value){if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid settings');const out=Object.assign({},defaults);for(const k of Object.keys(value)){if(!Object.prototype.hasOwnProperty.call(defaults,k))throw Error('Unknown setting');const v=value[k];if(typeof defaults[k]==='boolean'){if(typeof v!=='boolean')throw Error('Invalid toggle');}else if(!Number.isInteger(v)||v<ranges[k][0]||v>ranges[k][1])throw Error('Setting outside range');out[k]=v;}return out;}
function view(s){return [s.zoom/100,s.size/100,s.x,s.y];}
function camera(s){return [s.horizon,s.distance,40770];}
function worldVS(source){return 'uniform vec4 u_view;\n'+source.replace('d=a_position.xy-u_pose.xy','d=(a_position.xy-u_pose.xy)*u_view.x').replace('gl_Position=vec4(x*1.75,(1.-u_camera.x/240.)*w-u_camera.z/240.,0.,w);','gl_Position=vec4(x*1.75,(1.-u_camera.x/240.)*w-u_camera.z/240.,0.,w);gl_Position.xy=gl_Position.xy*u_view.y+vec2(u_view.z/400.,-u_view.w/240.)*w;');}
module.exports={defaults,ranges,validate,view,camera,worldVS};
