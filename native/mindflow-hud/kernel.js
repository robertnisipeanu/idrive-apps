'use strict';

// Reconcile only the display roads. Google route vertices remain authoritative.
const HudRoadAlignment = (() => {
  const CELL = 24, LIMIT = 8, COS = Math.cos(25 * Math.PI / 180);
  const distance = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);
  function segments(lines) {
    const result=[];
    lines.forEach((road,roadIndex)=>{
      for(let i=1;i<road.points.length;i++) {
        const a=road.points[i-1],b=road.points[i],length=distance(a,b);
        if(length<.01)continue;
        result.push({a,b,length,ux:(b[0]-a[0])/length,uy:(b[1]-a[1])/length,road,roadIndex});
      }
    });
    return result;
  }
  function grid(segments) {
    const cells=new Map();
    for(const s of segments) {
      // Walk long segments, instead of allocating their entire bounding rectangle.
      const visited=new Set(),n=Math.ceil(s.length/(CELL/2));
      for(let i=0;i<=n;i++) {
        const x=Math.floor((s.a[0]+(s.b[0]-s.a[0])*i/n)/CELL),y=Math.floor((s.a[1]+(s.b[1]-s.a[1])*i/n)/CELL);
        const key=x+','+y;if(visited.has(key))continue;visited.add(key);
        if(!cells.has(key))cells.set(key,[]);cells.get(key).push(s);
      }
    }
    return p=>{
      const found=new Set(),x=Math.floor(p[0]/CELL),y=Math.floor(p[1]/CELL);
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const s of cells.get((x+dx)+','+(y+dy))||[])found.add(s);
      return found;
    };
  }
  function hit(p,s) {
    const along=(p[0]-s.a[0])*s.ux+(p[1]-s.a[1])*s.uy;
    const t=Math.max(0,Math.min(s.length,along));
    const point=[s.a[0]+t*s.ux,s.a[1]+t*s.uy];
    return {point,distance:distance(p,point),along,segment:s};
  }
  function elevated(road) {
    return ['bridge','tunnel'].includes(road.structure)||Number(road.layer||0)!==0;
  }
  function reconcile(roads,route) {
    if(route.length<2)return {roads,routeSurface:[],stats:{replacedMeters:0,preservedMeters:0}};
    const roadSegments=segments(roads),routeSegments=segments([{points:route}]);
    const routeNear=grid(routeSegments),roadNear=grid(roadSegments);
    const aligned=(a,b)=>Math.abs(a.ux*b.ux+a.uy*b.uy)>=COS;
    function matches(p,s) {
      if(elevated(s.road))return false;
      let best=null;
      for(const r of routeNear(p)) {
        if(!aligned(s,r))continue;
        const h=hit(p,r);
        // Do not erase the road beyond either end of the supplied route.
        if(h.along<-.05||h.along>r.length+.05||h.distance>LIMIT)continue;
        if(!best||h.distance<best.distance)best=h;
      }
      if(!best)return false;
      const candidates=[];
      for(const r of roadNear(best.point)) {
        if(!aligned(r,best.segment))continue;
        const h=hit(best.point,r);
        if(h.distance<=LIMIT)candidates.push(h);
      }
      candidates.sort((a,b)=>a.distance-b.distance);
      const closest=candidates[0];
      if(!closest||distance(closest.point,p)>.8)return false;
      // Equally plausible parallel roads or different levels remain untouched.
      for(const h of candidates) {
        if(h.distance>closest.distance+1.5)break;
        if(elevated(h.segment.road)||distance(h.point,closest.point)>1)return false;
      }
      return true;
    }
    const result=[],stats={replacedMeters:0,preservedMeters:0};
    roads.forEach(road=>{
      let run=[];
      const flush=()=>{if(run.length>1)result.push(Object.assign({},road,{points:run}));run=[]};
      for(const s of segments([road])) {
        const steps=Math.ceil(s.length/4);
        for(let i=0;i<steps;i++) {
          const at=t=>[s.a[0]+(s.b[0]-s.a[0])*t,s.a[1]+(s.b[1]-s.a[1])*t];
          const a=at(i/steps),b=at((i+1)/steps),mid=at((i+.5)/steps);
          const replace=matches(mid,s)&&matches(a,s)&&matches(b,s);
          stats[replace?'replacedMeters':'preservedMeters']+=s.length/steps;
          if(replace){flush();continue}
          if(!run.length)run.push(a);run.push(b);
        }
      }
      flush();
    });
    return {roads:result,routeSurface:route,stats};
  }
  return {reconcile};
})();


function ribbon(points,width,out,segmentTarget=null){
 const clean=[],indices=[];for(let i=0;i<points.length;i++){if(clean.length&&Math.hypot(points[i][0]-clean[clean.length-1][0],points[i][1]-clean[clean.length-1][1])<=.01){indices[indices.length-1]=i;continue}clean.push(points[i]);indices.push(i)}
 if(clean.length<2)return;const h=width/2,edges=[];
 for(let i=0;i<clean.length;i++){
  const p=clean[i],a=clean[Math.max(0,i-1)],b=clean[Math.min(clean.length-1,i+1)];
  let ax=p[0]-a[0],ay=p[1]-a[1],bx=b[0]-p[0],by=b[1]-p[1];
  if(i===0){ax=bx;ay=by}if(i===clean.length-1){bx=ax;by=ay}
  const al=Math.hypot(ax,ay),bl=Math.hypot(bx,by);ax/=al;ay/=al;bx/=bl;by/=bl;
  let nx=-ay-by,ny=ax+bx,n=Math.hypot(nx,ny);if(n<.01){nx=-by;ny=bx;n=1}
  nx/=n;ny/=n;const scale=Math.min(h*2,h/Math.max(.5,nx*(-by)+ny*bx));
  edges.push([p[0]+nx*scale,p[1]+ny*scale,p[0]-nx*scale,p[1]-ny*scale]);
 }
 for(let i=1;i<edges.length;i++){const a=edges[i-1],b=edges[i],dest=segmentTarget?segmentTarget(indices[i-1]):out;dest.push(a[0],a[1],a[2],a[3],b[0],b[1],b[0],b[1],a[2],a[3],b[2],b[3])}
}

module.exports={reconcile:HudRoadAlignment.reconcile,ribbon,vs:"attribute vec3 a_position; uniform vec3 u_pose; uniform vec3 u_camera; varying float v_depth; varying float v_side; varying float v_screen;\nvoid main(){vec2 d=a_position.xy-u_pose.xy;float c=cos(u_pose.z),s=sin(u_pose.z);float x=d.x*c-d.y*s;float z=d.x*s+d.y*c;float w=z+u_camera.y;v_depth=z;v_side=x;v_screen=x*700./w;gl_Position=vec4(x*1.75,(1.-u_camera.x/240.)*w-u_camera.z/240.,0.,w);}",fs:"precision highp float;uniform vec4 u_color;varying float v_depth;varying float v_side; varying float v_screen;\nvoid main(){if(v_depth < -20. || v_depth > 1300.)discard;float fade=(1.-smoothstep(350.,1100.,v_depth))*smoothstep(-20.,0.,v_depth);float side=1.-smoothstep(280.,560.,abs(v_side));float a=u_color.a*fade*side*(1.-smoothstep(300.,400.,abs(v_screen)));gl_FragColor=vec4(u_color.rgb,a);}"};
