'use strict';
// Phone guidance versus independently calculated Google candidate routes.
// The phone (Android Auto) is authoritative for instructions. A calculated
// candidate's geometry is displayed only for the portion that agrees with the
// phone's observed guidance. Node 8 compatible: no optional chaining/spread.
const R=111320;
const TYPES=['turn','slight','sharp','uturn','ramp','fork','merge','roundabout','straight','depart','name_change','ferry','destination','unknown'];
const SIDES=['left','right',null];
const SCOPES=['next_stop','final_destination','unknown'];
const DIRECTIONAL=['turn','slight','sharp','uturn','ramp','fork'];
// A candidate maneuver the phone cannot plausibly have omitted.
const STRONG=['turn','sharp','uturn','roundabout'];
const LIMITS={confirm_samples:3,guidance_max_age_s:10,max_time_gap_s:5,conflicts_to_reject:2,off_route_reject_s:2,recalc_interval_s:30,recalc_budget:6,recalc_window_s:600,stalled_rejection_s:20,ambiguous_matches:2,horizon_maneuvers:Infinity,exit_tail_m:60,anchor:false,anchor_supersedes:false,anchor_budget:30,anchor_ahead_m:80,anchor_past_m:40,max_candidates:8,remainder_check:true,remainder_tolerance_m:120,remainder_tolerance_frac:.02};
const GOOGLE={TURN_LEFT:['turn','left'],TURN_RIGHT:['turn','right'],TURN_SLIGHT_LEFT:['slight','left'],TURN_SLIGHT_RIGHT:['slight','right'],TURN_SHARP_LEFT:['sharp','left'],TURN_SHARP_RIGHT:['sharp','right'],UTURN_LEFT:['uturn','left'],UTURN_RIGHT:['uturn','right'],RAMP_LEFT:['ramp','left'],RAMP_RIGHT:['ramp','right'],FORK_LEFT:['fork','left'],FORK_RIGHT:['fork','right'],MERGE:['merge',null],ROUNDABOUT_LEFT:['roundabout','left'],ROUNDABOUT_RIGHT:['roundabout','right'],STRAIGHT:['straight',null],DEPART:['depart',null],NAME_CHANGE:['name_change',null],FERRY:['ferry',null],FERRY_TRAIN:['ferry',null]};
function googleManeuver(name){const m=GOOGLE[name];return m?{type:m[0],side:m[1],roundabout_exit:null}:{type:'unknown',side:null,roundabout_exit:null};}

// ---- Input schema ---------------------------------------------------------
const has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const num=(lo,hi)=>v=>typeof v==='number'&&Number.isFinite(v)&&v>=lo&&v<=hi;
function field(o,k,check){if(!has(o,k))throw Error('Missing guidance field '+k);const v=o[k];if(v===null)return null;if(!check(v))throw Error('Invalid guidance field '+k);return v;}
function maneuver(v){
 if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid maneuver');
 ['type','side','roundabout_exit'].forEach(k=>{if(!has(v,k))throw Error('Missing maneuver field '+k);});
 if(TYPES.indexOf(v.type)<0||SIDES.indexOf(v.side)<0)throw Error('Invalid maneuver');
 if(v.roundabout_exit!==null&&!(Number.isInteger(v.roundabout_exit)&&v.roundabout_exit>=1&&v.roundabout_exit<=12))throw Error('Invalid roundabout exit');
 return {type:v.type,side:v.side,roundabout_exit:v.roundabout_exit};
}
// Every field must be present; null states that the source does not supply it.
const GUIDANCE_FIELDS=['measurement_age_s','distance_scope','remaining_distance_m','remaining_time_s','maneuver','maneuver_distance_m','maneuver_road','instruction_text'];
function guidance(v){
 if(v===null)return null;
 if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid guidance');
 for(const k of Object.keys(v))if(GUIDANCE_FIELDS.indexOf(k)<0)throw Error('Unknown guidance field '+k);
 if(!has(v,'measurement_age_s')||!num(0,3600)(v.measurement_age_s))throw Error('Guidance measurement age required');
 if(SCOPES.indexOf(v.distance_scope)<0)throw Error('Invalid distance scope');
 if(!has(v,'maneuver'))throw Error('Missing guidance field maneuver');
 let text=field(v,'instruction_text',s=>typeof s==='string'&&s.length<=200);
 let road=field(v,'maneuver_road',s=>typeof s==='string'&&s.length<=120);
 if(road!==null)road=road.normalize('NFKC').replace(/\s+/g,' ').trim()||null;
 if(text!==null){text=text.normalize('NFKC').replace(/\s+/g,' ').trim()||null;}
 return {measurement_age_s:v.measurement_age_s,distance_scope:v.distance_scope,
  remaining_distance_m:field(v,'remaining_distance_m',num(0,2e7)),remaining_time_s:field(v,'remaining_time_s',num(0,1e6)),
  maneuver:v.maneuver===null?null:maneuver(v.maneuver),maneuver_distance_m:field(v,'maneuver_distance_m',num(0,1e6)),maneuver_road:road,instruction_text:text};
}
function distanceText(m){return m<1000?Math.max(10,Math.round(m/10)*10)+' m':(Math.round(m/100)/10)+' km';}
function instructionText(g){
 if(!g)return null;if(g.instruction_text)return g.instruction_text;const m=g.maneuver;if(!m)return null;
 const side=m.side?' '+m.side:'',words={turn:'Turn'+side,slight:'Slight'+side,sharp:'Sharp'+side,uturn:'U-turn',ramp:'Take ramp'+side,fork:'Keep'+side,merge:'Merge',roundabout:'Roundabout'+(m.roundabout_exit?', exit '+m.roundabout_exit:''),straight:'Continue straight',depart:'Depart',name_change:'Continue',ferry:'Ferry',destination:'Destination',unknown:'Next maneuver'};
 return words[m.type]+(g.maneuver_road?' onto '+g.maneuver_road:'')+(g.maneuver_distance_m!==null?' in '+distanceText(g.maneuver_distance_m):'');
}

// ---- Geometry on [lon,lat] polylines --------------------------------------
function dist(a,b){const k=Math.cos((a[1]+b[1])/2*Math.PI/180);return Math.hypot((b[0]-a[0])*R*k,(b[1]-a[1])*R);}
function cumulative(coords){const cum=[0];for(let i=1;i<coords.length;i++)cum.push(cum[i-1]+dist(coords[i-1],coords[i]));return cum;}
// Closest point of each contiguous run of segments within limit of p, restricted to [from,to] metres along.
function projections(coords,cum,p,limit,from,to){
 const k=Math.cos(p[1]*Math.PI/180),out=[];let group=null,prev=false;
 const lo=from===undefined?-Infinity:from,hi=to===undefined?Infinity:to;
 for(let i=1;i<coords.length;i++){
  if(cum[i]<lo||cum[i-1]>hi){prev=false;continue;}
  const ax=(coords[i-1][0]-p[0])*R*k,ay=(coords[i-1][1]-p[1])*R,bx=(coords[i][0]-p[0])*R*k,by=(coords[i][1]-p[1])*R,dx=bx-ax,dy=by-ay,n=dx*dx+dy*dy;
  const t=n<1e-6?0:Math.max(0,Math.min(1,-(ax*dx+ay*dy)/n)),qx=ax+t*dx,qy=ay+t*dy,d=Math.hypot(qx,qy);
  if(d>limit){prev=false;continue;}
  const hit={along:cum[i-1]+t*(cum[i]-cum[i-1]),distance:d,heading:Math.atan2(dx,dy),index:i-1};
  if(prev&&group){if(d<group.distance)group=Object.assign(out[out.length-1],hit);}else{group=hit;out.push(hit);}
  prev=true;
 }
 return out;
}
function pointAt(coords,cum,along){
 if(along<=0)return {point:coords[0].slice(),index:0};
 for(let i=1;i<coords.length;i++)if(cum[i]>=along){const span=cum[i]-cum[i-1],t=span>0?(along-cum[i-1])/span:0;return {point:[coords[i-1][0]+t*(coords[i][0]-coords[i-1][0]),coords[i-1][1]+t*(coords[i][1]-coords[i-1][1])],index:i-1};}
 return {point:coords[coords.length-1].slice(),index:coords.length-2};
}
function angle(a,b){const d=Math.abs(((a-b)%360+540)%360-180);return d;}

// ---- Road names -----------------------------------------------------------
// Phone and Google may write the same street differently ("R. Augusta" /
// "Rua Augusta", accents, case). Only distinctive words are compared; street
// types and connectors are ignored. Road numbers (A2, N10, IC19) are kept.
const ABBR={r:'rua',av:'avenida',avda:'avenida',avd:'avenida',pc:'praca',pca:'praca',pr:'praca',lg:'largo',tv:'travessa',trav:'travessa',estr:'estrada',est:'estrada',al:'alameda',cc:'calcada',calc:'calcada',bc:'beco',rot:'rotunda',st:'street',rd:'road',ave:'avenue',dr:'drive',blvd:'boulevard',ln:'lane',hwy:'highway',pl:'place',sq:'square',dra:'doutora',eng:'engenheiro',prof:'professor',sto:'santo',sta:'santa',s:'sao'};
const GENERIC=['rua','avenida','praca','largo','travessa','estrada','alameda','calcada','beco','rotunda','escadinhas','street','road','avenue','drive','boulevard','lane','way','highway','place','square','court','circle','roundabout','motorway','autoestrada'];
const CONNECT=['de','da','do','das','dos','e','d','the','of','la','del','le','and'];
// Combining accents (U+0300-U+036F), left after NFD decomposition.
const MARKS=new RegExp('['+String.fromCharCode(0x300)+'-'+String.fromCharCode(0x36f)+']','g');
function roadWords(name){
 if(typeof name!=='string'||!name.trim())return null;
 const words=name.normalize('NFD').replace(MARKS,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(' ').filter(Boolean).map(w=>ABBR[w]||w);
 return words.filter(w=>CONNECT.indexOf(w)<0&&GENERIC.indexOf(w)<0);
}
// 'match' | 'conflict' | 'unknown' (either name missing or nothing distinctive).
function sameRoad(a,b){
 const x=roadWords(a),y=roadWords(b);if(!x||!y||!x.length||!y.length)return 'unknown';
 const X=new Set(x),Y=new Set(y),common=Array.from(X).filter(w=>Y.has(w)).length;
 if(!common)return 'conflict';
 const small=Math.min(X.size,Y.size);return common===small||common/(X.size+Y.size-common)>=.5?'match':'unknown';
}

// ---- Comparison -----------------------------------------------------------
function compatible(phone,google,phoneRoad,googleRoad){
 const kind=maneuverKind(phone,google),road=sameRoad(phoneRoad,googleRoad);
 if(kind==='conflict')return 'conflict';
 // Same direction onto a different street (roundabout exit, fork, nearby junction).
 if(kind==='match'&&road==='conflict')return 'conflict';
 // Google may model a roundabout as a turn: the same street confirms it.
 if(kind==='unknown'&&road==='match'&&phone.type!=='unknown'&&google.type!=='unknown')return 'match';
 return kind;
}
function maneuverKind(phone,google){
 const a=phone.type,b=google.type;
 if(a==='unknown'||b==='unknown')return 'unknown';
 // Roundabout circulation side (phone) and exit side (Google) differ in meaning.
 if(a==='roundabout'||b==='roundabout'){if(a!==b)return 'unknown';const e1=phone.roundabout_exit,e2=google.roundabout_exit;return Number.isInteger(e1)&&Number.isInteger(e2)&&e1!==e2?'conflict':'match';}
 if(DIRECTIONAL.indexOf(a)>=0&&DIRECTIONAL.indexOf(b)>=0){if(!phone.side||!google.side)return a===b?'match':'unknown';return phone.side===google.side?'match':'conflict';}
 return a===b?'match':'unknown';
}
// Phone's next maneuver (at s + distance) against the candidate's maneuver points.
function evaluate(route,s,g,extra){
 const m=g.maneuver;
 if(!m||g.maneuver_distance_m===null)return {result:'unavailable',until:s,reason:'phone maneuver unavailable'};
 // Phone metres to polyline metres (Google distance versus decoded geometry length).
 const d=g.maneuver_distance_m/route.scale;
 const at=s+d,tol=Math.max(40,.12*d)+extra,points=route.points;
 // The candidate turns (or arrives) before the phone's next maneuver.
 for(const p of points){if(p.along<=s+30)continue;if(p.along>=at-tol)break;if(p.maneuver.type==='unknown')return {result:'unknown',until:p.along-15,at:p.along,reason:'unrecognized web maneuver before phone instruction'};if(STRONG.indexOf(p.maneuver.type)>=0||p.maneuver.type==='destination')return {result:'conflict',until:p.along-15,at:p.along,reason:'calculated route has '+p.maneuver.type+' before phone maneuver'};}
 const window=points.filter(p=>Math.abs(p.along-at)<=tol);
 if(m.type==='destination'){
  const hit=window.filter(p=>p.maneuver.type==='destination').sort((a,b)=>Math.abs(a.along-at)-Math.abs(b.along-at))[0];
  if(hit)return {result:'match',until:hit.along,point:hit};
  return {result:'conflict',until:at-tol,at,reason:'phone arrives where calculated route continues'};
 }
 let best=null,conflict=null,unknown=false;
 for(const p of window){const r=compatible(m,p.maneuver,g.maneuver_road,p.road);if(r==='match'&&(!best||sameRoad(g.maneuver_road,p.road)==='match'&&sameRoad(g.maneuver_road,best.road)!=='match'||sameRoad(g.maneuver_road,p.road)===sameRoad(g.maneuver_road,best.road)&&Math.abs(p.along-at)<Math.abs(best.along-at)))best=p;else if(r==='conflict'&&!conflict)conflict=p;else if(r==='unknown')unknown=true;}
 if(best)return {result:'match',until:best.along,point:best};
 if(conflict){const named=maneuverKind(m,conflict.maneuver)!=='conflict';return {result:'conflict',until:conflict.along-15,at:conflict.along,reason:named?'calculated route turns onto '+(conflict.road||'?')+' where phone turns onto '+g.maneuver_road:conflict.maneuver.type==='roundabout'&&m.type==='roundabout'?'calculated roundabout exit '+conflict.maneuver.roundabout_exit+' where phone takes exit '+m.roundabout_exit:'calculated route turns '+conflict.maneuver.side+' where phone turns '+m.side};}
 if(STRONG.indexOf(m.type)>=0&&d<=2000&&!unknown&&at<=route.length_m+tol)return {result:'conflict',until:at-tol,at,reason:'phone '+m.type+' absent from calculated route'};
 return {result:'unknown',until:Math.min(route.length_m,at-tol),reason:'no comparable calculated maneuver'};
}
function legAt(route,s){for(const l of route.legs)if(s<l.end_along-1)return l;return route.legs[route.legs.length-1];}
function remaining(route,s,scope){
 if(scope==='unknown')return null;
 const legs=scope==='final_destination'?route.legs.filter(l=>l.end_along>s):[legAt(route,s)];
 let meters=0,seconds=0;
 for(const l of legs){const from=Math.max(s,l.start_along);meters+=Math.max(0,l.end_along-from)*route.scale;seconds+=l.duration_s*fraction(route,l,from);}
 return {distance_m:meters,time_s:seconds};
}
function fraction(route,leg,s){
 if(s<=leg.start_along)return 1;if(s>=leg.end_along)return 0;
 const steps=route.steps.filter(x=>x.leg===leg.index&&x.along!==null);let total=0,left=0;
 for(let i=0;i<steps.length;i++){const a=steps[i].along,b=i+1<steps.length?steps[i+1].along:leg.end_along,span=b-a;total+=steps[i].static_s;if(s<=a)left+=steps[i].static_s;else if(s<b&&span>0)left+=steps[i].static_s*(b-s)/span;}
 return total>0?left/total:(leg.end_along-s)/(leg.end_along-leg.start_along);
}
// Distances are only compared within the scope the phone reported.
function agreeDistance(route,s,g,extra){
 if(g.distance_scope==='unknown'||g.remaining_distance_m===null)return 'unavailable';
 const r=remaining(route,s,g.distance_scope),phone=g.remaining_distance_m,diff=Math.abs(r.distance_m-phone);
 if(diff<=Math.max(200,.08*phone)+extra)return 'agree';
 if(diff>Math.max(1000,.25*phone)+extra)return 'disagree';
 return 'uncertain';
}
// Tighter remainder check: does the candidate's WHOLE continuation have the phone's
// remaining distance (phone display rounding + position uncertainty allowed)?
// It never rejects; a differing remainder only stops the line at the phone's next maneuver.
function remainder(route,s,g,extra){
 if(g.distance_scope==='unknown'||g.remaining_distance_m===null)return 'unavailable';
 const r=remaining(route,s,g.distance_scope),phone=g.remaining_distance_m,rounding=phone<1000?25:50;
 return Math.abs(r.distance_m-phone)<=Math.max(LIMITS.remainder_tolerance_m,LIMITS.remainder_tolerance_frac*phone)+rounding+extra?'consistent':'differs';
}
// Traffic models differ: time alone never rejects a candidate.
function agreeTime(route,s,g){
 if(g.distance_scope==='unknown'||g.remaining_time_s===null)return 'unavailable';
 const r=remaining(route,s,g.distance_scope),diff=Math.abs(r.time_s-g.remaining_time_s);
 return diff<=Math.max(120,.2*g.remaining_time_s)?'agree':'differs';
}

// Positions (every 10 m along a) where a is farther than 15 m from b.
function divergences(a,b){
 const k=Math.cos(a.coordinates[0][1]*Math.PI/180),loc=p=>[p[0]*R*k,p[1]*R],CELL=40,grid=new Map(),bp=b.coordinates.map(loc);
 // Index each segment by walking along it (no bounding-box limit: long motorway segments count).
 for(let i=1;i<bp.length;i++){const a0=bp[i-1],b0=bp[i],steps=Math.max(1,Math.ceil(Math.hypot(b0[0]-a0[0],b0[1]-a0[1])/(CELL/2))),seen=new Set();for(let k=0;k<=steps;k++){const key=Math.floor((a0[0]+(b0[0]-a0[0])*k/steps)/CELL)+','+Math.floor((a0[1]+(b0[1]-a0[1])*k/steps)/CELL);if(seen.has(key))continue;seen.add(key);if(!grid.has(key))grid.set(key,[]);grid.get(key).push(i);}}
 const near=q=>{const cx=Math.floor(q[0]/CELL),cy=Math.floor(q[1]/CELL);for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const i of grid.get((cx+dx)+','+(cy+dy))||[]){const a0=bp[i-1],b0=bp[i],ex=b0[0]-a0[0],ey=b0[1]-a0[1],n=ex*ex+ey*ey,t=n?Math.max(0,Math.min(1,((q[0]-a0[0])*ex+(q[1]-a0[1])*ey)/n)):0;if(Math.hypot(a0[0]+t*ex-q[0],a0[1]+t*ey-q[1])<=15)return true;}return false;};
 const far=[],ap=a.coordinates.map(loc);let seg=1;
 for(let s=0;s<=a.length_m;s+=10){while(seg<ap.length-1&&a.cum[seg]<s)seg++;const span=a.cum[seg]-a.cum[seg-1],t=span>0?Math.max(0,Math.min(1,(s-a.cum[seg-1])/span)):0,q=[ap[seg-1][0]+t*(ap[seg][0]-ap[seg-1][0]),ap[seg-1][1]+t*(ap[seg][1]-ap[seg-1][1])];if(!near(q))far.push(s);}
 return far;
}

// ---- Candidate tracking ---------------------------------------------------
class Matcher{
 constructor(set,options){
  const o=options||{};this.quality=set.quality||'unknown';this.ambiguous=this.quality!=='exact';this.destination=set.destination_key||null;
  const inherit=o.inherit&&o.inherit.destination===this.destination?o.inherit.keys:[];
  const t=Number.isFinite(o.originTime)?o.originTime:0;
  this.candidates=set.candidates.map((route,index)=>this.make(route,index,t,inherit));
  this.selected=-1;this.fix=null;this.fixT=null;this.firstRejectAt=null;this.lastAgreedAt=t;this.anchored=new Set();this.anchorSeq=0;
  // Keep still-plausible candidates from the previous set (the phone may be on one
  // that Google no longer returns from here), unless a new candidate duplicates it.
  const prev=o.previous;
  if(prev&&prev.destination===this.destination){
   for(const c of prev.candidates){
    if(this.candidates.length>=LIMITS.max_candidates)break;
    if(c.rejected||!c.onRoute)continue;
    const dup=this.candidates.some(n=>!divergences(c.route,n.route).some(x=>x>c.progress+5));
    if(dup)continue;
    const kept=Object.assign({},c,{index:this.candidates.length,route:Object.assign({},c.route,{traffic:{status:'unavailable',intervals:[]},carried:true}),matched:new Set(c.matched)});
    this.candidates.push(kept);
   }
   this.fix=prev.fix;this.anchored=new Set(prev.anchored);
  }
 }
 make(route,index,t,inherit){return {route,index,progress:0,progressAt:t,onRoute:false,offSince:null,offFixes:0,offDistance:null,wrongWay:0,headingDiff:null,rejected:null,conflicts:0,lastConflictT:-Infinity,distFar:0,lastFarT:-Infinity,obs:null,obsNamed:false,obsSeq:-1,distance:'unavailable',remainder:'unavailable',time:'unavailable',matches:0,lastMatchT:-Infinity,matched:new Set(inherit)};}
 // The phone confirmed its next maneuver AND the street it enters on the selected
 // candidate: ask Google for its route through that street (a via point just past
 // the maneuver), so the inferred continuation starts from the phone's choice.
 anchorRequest(){
  const c=this.candidates[this.selected];
  if(!c||c.rejected||!c.onRoute||!c.obsNamed||!c.obs||c.obs.result!=='match')return null;
  const p=c.obs.point;if(p.maneuver.type==='destination'||this.anchored.has(p.key)||p.along-c.progress<LIMITS.anchor_ahead_m)return null;
  const at=Math.min(c.route.length_m-1,p.along+LIMITS.anchor_past_m);if(at<=p.along+5)return null;
  const a=pointAt(c.route.coordinates,c.route.cum,at).point,b=pointAt(c.route.coordinates,c.route.cum,Math.min(c.route.length_m,at+5)).point;
  const k=Math.cos(a[1]*Math.PI/180),heading=(Math.atan2((b[0]-a[0])*k,b[1]-a[1])*180/Math.PI+360)%360;
  this.anchored.add(p.key);return {key:p.key,via:a,heading:Math.round(heading)%360,street:p.road||null};
 }
 // Anchored candidates join the existing set; their own matching still applies.
 add(set,originTime){
  const sel=this.candidates[this.selected],inherit=sel&&!sel.rejected?Array.from(sel.matched):[],seq=++this.anchorSeq,added=[];
  for(const route of set.candidates){route.anchor_seq=seq;const c=this.make(route,this.candidates.length,originTime,inherit);this.candidates.push(c);added.push(c);}
  if(this.fix)added.forEach(c=>this.track(c,this.fix,this.fixT));
  return added.length;
 }
 update(fix,fixT,g,gT,gSeq){
  if(fix&&fixT!==this.fixT){this.fix=fix;this.fixT=fixT;this.candidates.forEach(c=>this.track(c,fix,fixT));}
  if(g)this.candidates.forEach(c=>{if(c.obsSeq!==gSeq)this.observe(c,g,gT,gSeq);});
  this.choose(!!g);
 }
 track(c,fix,t){
  const r=c.route,acc=fix.accuracy_m,on=Math.max(25,1.5*acc+10),off=Math.max(50,2*acc+30);
  const dt=Math.max(0,t-c.progressAt),v=Number.isFinite(fix.speed_mps)?fix.speed_mps:null;
  const predicted=c.progress+(v!==null?v*dt:0),back=50+acc,reach=(v!==null?v*dt*1.5:40*dt)+150+acc;
  // Continuity with the previous progress resolves loops and nearby parallel portions;
  // a reliable heading separates out-and-back (U-turn) portions of the same road.
  const headed=v!==null&&v>=3&&Number.isFinite(fix.heading_deg);
  let hit=null;for(const h of projections(r.coordinates,r.cum,[fix.longitude,fix.latitude],off,c.progress-back,c.progress+reach)){if(h.along<c.progress-back)continue;const opposed=headed&&angle(fix.heading_deg,(h.heading*180/Math.PI+360)%360)>=120;const score=Math.abs(h.along-predicted)+3*h.distance+(opposed?1000:0);if(!hit||score<hit.score)hit=Object.assign({score},h);}
  if(hit){c.progress=Math.max(0,hit.along);c.progressAt=t;c.offDistance=hit.distance;c.offSince=null;c.offFixes=0;}
  else{c.offDistance=null;if(c.offSince===null)c.offSince=t;c.offFixes++;}
  c.onRoute=!!hit&&hit.distance<=on;
  if(!c.rejected&&c.offFixes>=2&&t-c.offSince>=LIMITS.off_route_reject_s)this.reject(c,'GPS left calculated route',c.progress,t);
  if(hit&&v!==null&&v>=3&&Number.isFinite(fix.heading_deg)){const d=angle(fix.heading_deg,(hit.heading*180/Math.PI+360)%360);c.headingDiff=Math.round(d);if(d>=120){c.wrongWay++;if(c.wrongWay>=2&&!c.rejected)this.reject(c,'heading opposes calculated route',c.progress,t);}else c.wrongWay=0;}
  else c.headingDiff=null;
 }
 observe(c,g,gT,seq){
  c.obsSeq=seq;const fix=this.fix,acc=fix?fix.accuracy_m:30,v=fix&&Number.isFinite(fix.speed_mps)?fix.speed_mps:null,gap=gT-c.progressAt;
  if(gT-c.lastMatchT>LIMITS.guidance_max_age_s)c.matches=0;
  if(Math.abs(gap)>LIMITS.max_time_gap_s){c.matches=0;c.obs={result:'unavailable',until:c.progress,reason:'guidance and GPS observation times too far apart'};c.distance='unavailable';c.time='unavailable';return;}
  // Progress at the moment the phone observed its guidance, with timing uncertainty.
  const s=Math.max(0,c.progress+(v!==null?v*gap:0)),extra=Math.min(acc,30)+Math.abs(gap)*(v!==null?Math.max(2,.2*v):30);
  const e=evaluate(c.route,s,g,extra);c.obs=e;c.obsNamed=e.result==='match'&&sameRoad(g.maneuver_road,e.point.road)==='match';c.distance=agreeDistance(c.route,s,g,extra);c.remainder=remainder(c.route,s,g,extra);c.time=agreeTime(c.route,s,g);
  if(c.rejected)return;
  if(e.result==='match'){c.conflicts=0;if(gT-c.lastMatchT>=.5){c.matches++;c.lastMatchT=gT;}c.matched.add(e.point.key);}else {c.matches=0;}
  if(e.result==='conflict'&&gT-c.lastConflictT>=1){c.conflicts++;c.lastConflictT=gT;if(c.conflicts>=LIMITS.conflicts_to_reject)this.reject(c,e.reason,e.until,gT);}
  if(c.distance==='disagree'){if(gT-c.lastFarT>=1){c.distFar++;c.lastFarT=gT;}if(c.distFar>=2&&!c.rejected)this.reject(c,'remaining distance differs from phone ('+g.distance_scope+')',c.progress,gT);}else c.distFar=0;
 }
 reject(c,reason,until,t){c.rejected={reason,until:Math.max(c.progress,until)};if(this.firstRejectAt===null)this.firstRejectAt=t;}
 status(c,fresh){
  if(c.rejected)return 'mismatch';
  if(!fresh||!c.obs||!c.onRoute||c.wrongWay>0||c.distance==='disagree')return 'unverified';
  const r=c.obs.result;
  // Similar distance/ETA alone never resolves an ambiguous address.
  if(this.ambiguous)return c.matches>=LIMITS.confirm_samples&&c.matched.size>=LIMITS.ambiguous_matches&&(r==='match'||r==='unknown')?'agreed':'unverified';
  if(r==='match'&&c.matches>=LIMITS.confirm_samples)return 'agreed';
  // Remaining totals never substitute for an observed matching turn.
  return 'unverified';
 }
 extent(c,status,fresh){
  if(!fresh||!c.onRoute||c.wrongWay>0)return 0;
  // A conflict shortens the line immediately; rejection/switching retains hysteresis.
  if(c.obs&&c.obs.result==='conflict')return Math.max(c.progress,c.obs.until);
  if(c.obs&&c.obs.result==='match'&&c.matches<LIMITS.confirm_samples)return Math.min(c.obs.point.along-15,c.progress+Math.max(0,c.obs.point.along-c.progress-15));
  // Default (Infinity): show the inferred full candidate after confirmation. Disagreement is
  // caught by continued matching and by the divergence cap in result().
  // Optional conservative mode: 0 ends the line just past the phone's next
  // maneuver (+exit_tail_m); n>0 runs n candidate maneuvers further.
  if(status==='agreed'){
   // A continuation whose remaining distance differs from the phone's is a different route.
   const h=LIMITS.remainder_check&&c.remainder==='differs'?0:LIMITS.horizon_maneuvers;if(!Number.isFinite(h))return c.route.length_m;
   const r=c.obs?c.obs.result:'unavailable',from=r==='match'?c.obs.point.along:r==='unknown'?c.obs.until:c.progress,ahead=c.route.points.filter(p=>p.along>from+1);
   if(h===0){const next=ahead.length?ahead[0].along:c.route.length_m;return r==='match'?Math.min(Math.max(from,next-15),from+LIMITS.exit_tail_m):Math.min(next,from);}
   return ahead.length>=h?ahead[h-1].along:c.route.length_m;
  }
  if(status==='mismatch')return c.rejected.until;
  if(!c.obs||c.obs.result==='unavailable')return 0;
  return c.obs.until;
 }
 rank(c,fresh){const st=this.status(c,fresh),r=c.obs?c.obs.result:'unavailable';return [st==='agreed'?0:st==='unverified'?1:2,-c.matched.size,r==='match'?0:r==='unknown'?1:r==='unavailable'?2:3,c.distance==='agree'?0:c.distance==='disagree'?2:1,c.onRoute?0:1,c.time==='agree'?0:1,-(c.route.anchor_seq||0),c.index];}
 choose(fresh){
  const less=(a,b)=>{for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]<b[i];return false;};
  let best=null,bestRank=null;for(const c of this.candidates){const r=this.rank(c,fresh);if(!best||less(r,bestRank)){best=c;bestRank=r;}}
  const cur=this.candidates[this.selected];
  // Hysteresis: keep the current candidate while it remains in the best tier.
  // ...except that an agreeing route anchored on a newer confirmed street wins.
  const newer=bestRank[0]===0&&(best.route.anchor_seq||0)>(cur&&cur.route.anchor_seq||0);
  if(cur&&!cur.rejected&&this.rank(cur,fresh)[0]===bestRank[0]&&!newer)return;
  if(newer&&LIMITS.anchor_supersedes)for(const o of this.candidates)if(o!==best&&!o.rejected&&(o.route.anchor_seq||0)<best.route.anchor_seq)this.reject(o,'superseded by route through confirmed street',o.progress,this.fixT||0);
  this.selected=best.index;
 }
 result(fresh){
  if(this.selected<0)this.choose(fresh);
  const c=this.candidates[this.selected],status=this.status(c,fresh);let until=this.extent(c,status,fresh),contested=false;
  // Another plausible candidate on the same road: show only where both coincide,
  // until the phone's guidance tells them apart.
  if(until>c.progress)for(const o of this.candidates){
   if(o===c||o.rejected||!o.onRoute)continue;const key=c.index+','+o.index;
   if(!this.far)this.far=new Map();if(!this.far.has(key))this.far.set(key,divergences(c.route,o.route));
   const next=this.far.get(key).find(s=>s>c.progress+5);if(next!==undefined&&next-10<until){until=Math.max(c.progress,next-10);contested=true;}
  }
  return {candidate:c,status,until,contested,display:until-c.progress<=20?'guidance_only':until>=c.route.length_m-.5?'full':'partial'};
 }
 needsRecalc(now){
  if(this.candidates.every(c=>c.rejected))return true;
  if(this.candidates.some(c=>!c.rejected&&this.status(c,true)==='agreed')){this.lastAgreedAt=now;return false;}
  // Only a sustained lack of agreement (not one unverified second) after a rejection.
  if(this.firstRejectAt===null)return false;
  return now-Math.max(this.firstRejectAt,this.lastAgreedAt)>=LIMITS.stalled_rejection_s;
 }
 evidence(){const c=this.candidates[this.selected];return c&&!c.rejected?{destination:this.destination,keys:Array.from(c.matched)}:null;}
 summary(fresh){return this.candidates.map(c=>({alternative_index:c.route.alternative_index,status:this.status(c,fresh),maneuver:c.obs?c.obs.result:'unavailable',distance:c.distance,time:c.time,on_route:c.onRoute,remainder:c.remainder,matched_maneuvers:c.matched.size,rejected:c.rejected?c.rejected.reason:null}));}
}
module.exports={LIMITS,TYPES,SCOPES,divergences,remainder,roadWords,sameRoad,maneuverKind,googleManeuver,guidance,instructionText,dist,cumulative,projections,pointAt,compatible,evaluate,remaining,agreeDistance,agreeTime,Matcher};
