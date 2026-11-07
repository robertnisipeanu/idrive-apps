'use strict';
const https=require('https'),zlib=require('zlib');
const VectorTile=require('@mapbox/vector-tile').VectorTile,Pbf=require('pbf');
function tileAt(lon,lat,z){const n=Math.pow(2,z),r=Math.max(-85,Math.min(85,lat))*Math.PI/180;return [Math.floor((lon+180)/360*n),Math.floor((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*n)];}
function decode(bytes,x,y,z){
 const tile=new VectorTile(new Pbf(bytes)),layer=tile.layers.road,roads=[];
 if(!layer)return roads;
 for(let i=0;i<layer.length;i++){
  const f=layer.feature(i),p=f.properties;
  if(f.type!==2||['path','pedestrian','ferry','track'].indexOf(p.class)>=0)continue;
  const g=f.toGeoJSON(x,y,z).geometry,lines=g.type==='LineString'?[g.coordinates]:g.coordinates;
  lines.forEach(points=>roads.push({name:p.name||'',structure:p.structure||'none',layer:p.layer||0,width:['motorway','trunk','primary'].indexOf(p.class)>=0?3.2:p.class==='service'?1.1:1.8,points}));
 }
 return roads;
}
function fetchTile(token,x,y,z){return new Promise((resolve,reject)=>{
 // Node 8 (the unit's) has no https.get(url, options, callback): one options object.
 const opts=require('url').parse('https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/'+z+'/'+x+'/'+y+'.vector.pbf?access_token='+encodeURIComponent(token));opts.headers={'Accept-Encoding':'gzip'};
 const req=https.get(opts,res=>{
  if(res.statusCode!==200){res.resume();reject(Error('Mapbox tile HTTP '+res.statusCode));return;}
  let size=0,parts=[];res.on('data',p=>{size+=p.length;if(size>4*1024*1024){req.destroy(Error('Tile exceeds size limit'));return;}parts.push(p);});
  res.on('error',reject);res.on('end',()=>{const bytes=Buffer.concat(parts);if(res.headers['content-encoding']==='gzip')zlib.gunzip(bytes,{maxOutputLength:8*1024*1024},(e,b)=>e?reject(Error('Tile decompression failed')):resolve(b));else resolve(bytes);});
 });req.setTimeout(6000,()=>req.destroy(Error('Tile timeout')));req.on('error',()=>reject(Error('Tile connection failed')));
});}
class Roads {
 constructor(token,fetcher){this.token=token;this.fetcher=fetcher||fetchTile;this.cache=new Map();}
 async near(lon,lat,heading){
  // TileJSON advertises maxzoom 16. Acquire the forward camera footprint at
  // that detail, reducing zoom near the poles to bound the tile count.
  const coslat=Math.cos(lat*Math.PI/180),z=Math.min(16,Math.floor(Math.log2(40075016.686*coslat/350))),c=tileAt(lon,lat,z),keys=[],n=Math.pow(2,z),h=heading||0;
  const corners=[];for(const x of [-750,750])for(const y of [-150,1500]){const dx=x*Math.cos(h)+y*Math.sin(h),dy=-x*Math.sin(h)+y*Math.cos(h);corners.push(tileAt(lon+dx/(111320*coslat),lat+dy/111320,z));}
  const minx=Math.min.apply(null,corners.map(p=>p[0])),maxx=Math.max.apply(null,corners.map(p=>p[0])),miny=Math.min.apply(null,corners.map(p=>p[1])),maxy=Math.max.apply(null,corners.map(p=>p[1]));
  for(let y=miny;y<=maxy;y++)for(let x=minx;x<=maxx;x++)if(y>=0&&y<n)keys.push([((x%n)+n)%n,y]);
  if(keys.length>81)throw Error('Tile footprint exceeds request bound');
  keys.sort((a,b)=>Math.hypot(a[0]-c[0],a[1]-c[1])-Math.hypot(b[0]-c[0],b[1]-c[1]));
  const result=[];
  // Three requests at a time; memory cache only, bounded to 128 tiles.
  for(let i=0;i<keys.length;i+=3)await Promise.all(keys.slice(i,i+3).map(async xy=>{
   const key=z+','+xy.join(',');let value=this.cache.get(key);
   if(!value){value=decode(await this.fetcher(this.token,xy[0],xy[1],z),xy[0],xy[1],z);this.cache.set(key,value);}
   result.push.apply(result,value);
  }));
  const retain=new Set(keys.map(x=>z+','+x.join(',')));for(const key of this.cache.keys())if(this.cache.size>128&&!retain.has(key))this.cache.delete(key);
  const seen=new Set();return result.filter(r=>{const key=JSON.stringify(r.points);if(seen.has(key))return false;seen.add(key);return true;});
 }
}
module.exports={Roads,decode,tileAt};
