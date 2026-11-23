// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the real patchd and patcher on a synthetic ELF. No BMW firmware required.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const cp = require('child_process');
const tmp = require('./tmp.js');
require('./head_unit_env.js');
const syn = require('./synthetic_carplay.js').build();
const patcher = require('../carplay_patch.js');
const dir = tmp.dir(), bin = path.join(dir, 'bin'), state = path.join(dir, 'state');
fs.mkdirSync(bin); fs.mkdirSync(state);
const target = path.join(dir, 'carplay'), sock = path.join(dir, 'sock', 'patch.sock');
fs.writeFileSync(target, syn.buf);
fs.writeFileSync(path.join(dir, 'lib.so'), 'test preload');
fs.writeFileSync(path.join(dir, 'passwd'), 'root:x:0:0::/:/bin/sh\ncia_13002:x:13002:13002::/:/bin/false\n');
const systemctl = path.join(bin, 'systemctl');
fs.writeFileSync(systemctl, '#!/bin/sh\ncase "$*" in\n*Environment*) echo Environment=LD_PRELOAD=/usr/lib/libschedconfig.so.1;;\n*User*) echo User=cia_13002;;\n*) echo MainPID=0;;\nesac\n', {mode:0o755});
const env = Object.assign({}, process.env, {
    PATH: bin + ':' + process.env.PATH, WOC_PATCH_SOCK:sock, WOC_PATCH_GROUP:'',
    WOC_CARPLAY:target, WOC_AAPD:path.join(dir,'no-aapd'), WOC_STATE_DIR:state,
    WOC_PRELOAD_DIR:path.join(dir,'run'), WOC_PRELOAD_LIB:path.join(dir,'lib.so'), WOC_PASSWD:path.join(dir,'passwd'),
    WOC_PROC:path.join(dir,'proc'), WOC_SYSTEMCTL:systemctl, WOC_UNIT_DIRS:path.join(dir,'units'),
    WOC_LOCAL_CONF:path.join(dir,'local.conf'), WOC_RECMGR_CONF:path.join(dir,'no-recmgr'),
    WOC_RECMGR_AT_BOOT:path.join(dir,'no-recmgr-boot'), WOC_PROC_STAT:path.join(dir,'no-stat'),
    WOC_BOOT_ID:path.join(dir,'boot-id'), WOC_RECOVERY_STATE:path.join(state,'boot-recovery.json'),
    WOC_REMOUNT_LOCK:path.join(dir,'remount.lock'), WOC_CAPTURE_SOCK:path.join(dir,'no-capture.sock'),
    WOC_DLT_RECEIVE:path.join(dir,'no-dlt'), WOC_DLT_RETRY_MS:'600000',
    WOC_MOUNT:path.join(dir,'MUST-NOT-REMOUNT'), WOC_STREAM_STATE:path.join(dir,'stream.json')
});
fs.writeFileSync(env.WOC_BOOT_ID,'boot-test\n');
const daemon = path.join(__dirname,'..','patchd.js');
let child, output = '';
const sleep = (ms) => new Promise((r)=>setTimeout(r,ms));
async function start() {
    const from = output.length;
    child=cp.spawn(process.execPath,[daemon],{env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',(d)=>output+=d);child.stderr.on('data',(d)=>output+=d);
    for(let i=0;i<250 && !output.slice(from).includes('patchd listening');i++) await sleep(20);
    assert(output.slice(from).includes('patchd listening'), output);
}
async function stop() {
    if(!child) return;
    const p=child; child=null;
    if (p.exitCode !== null || p.signalCode !== null) return;
    await new Promise((r)=>{p.once('exit',r);p.kill('SIGTERM');});
}
function ask(msg, predicate) {
    return new Promise((resolve,reject)=>{
        const s=net.connect(sock);let buf='';
        const timer=setTimeout(()=>{s.destroy();reject(new Error('no answer: '+JSON.stringify(msg)+'\n'+output));},8000);
        s.on('connect',()=>s.write(JSON.stringify(msg)+'\n'));
        s.on('error',(e)=>{clearTimeout(timer);reject(e);});
        s.on('data',(d)=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){
            const line=buf.slice(0,i);buf=buf.slice(i+1);let m;try{m=JSON.parse(line);}catch(e){continue;}
            if(predicate(m)){clearTimeout(timer);s.end();resolve(m);return;}
        }});
    });
}
const status=()=>ask({cmd:'status'},(m)=>m.ev==='status' && !m.busy);
async function op(msg, done) {
    let busy = false;
    return ask(msg,(m)=>{ if(m.ev==='status' && m.busy) busy=true;
        return m.ev==='refused' || (busy && m.ev==='status' && !m.busy && (!done || done(m))); });
}
function geometry() {
    const text=fs.readFileSync(path.join(state,'inmem-carplay.plan'),'utf8');
    const o=patcher.overlay(fs.readFileSync(target),text);assert(!o.err,o.err);
    const loc=require('../carplay_locate.js').locate(o.buf);
    return [o.buf.readUInt16LE(loc.res.safe2+4),o.buf.readUInt16LE(loc.res.safe2+6)];
}
(async()=>{
    try {
        await start();let s=await status();assert.equal(s.safearea,'standard');
        let m=await ask({cmd:'cp-safearea',value:'bad'},(m)=>m.ev==='refused');assert(/standard.*yandex/.test(m.reason));
        assert(!fs.existsSync(path.join(state,'carplay-safearea')));
        // While off, changing the choice must not enable the map.
        s=await op({cmd:'cp-safearea',value:'yandex'});assert.equal(s.safearea,'yandex');
        assert(!fs.existsSync(path.join(state,'inmem-carplay.plan')));
        await stop();await start();s=await status();assert.equal(s.safearea,'yandex');
        s=await op({cmd:'apply',panel:'high',mode:'avb'});assert.notEqual(s.state,'error',JSON.stringify(s));
        assert.deepEqual(geometry(),[433,72]);assert(fs.readFileSync(target).equals(syn.buf));
        console.log('ok   default, invalid input, disabled choice, restart persistence, Yandex plan with untouched disk');
        // The daemon rejects another operation while the shared lock is held.
        fs.writeFileSync(env.WOC_REMOUNT_LOCK, '999999 held\n');
        const changing=op({cmd:'cp-safearea',value:'standard'});
        await sleep(200);
        m=await ask({cmd:'cp-safearea',value:'yandex'},(m)=>m.ev==='refused');assert(/another operation/.test(m.reason));
        fs.unlinkSync(env.WOC_REMOUNT_LOCK);await changing;
        assert.deepEqual(geometry(),[286,72]);
        // A saved choice must survive a normal Patch press and install activation.
        await op({cmd:'cp-safearea',value:'yandex'});
        await stop();
        let a=cp.spawnSync(process.execPath,[daemon,'activate'],{env,encoding:'utf8',timeout:20000});
        assert.equal(a.status,0,a.stdout+a.stderr);assert.deepEqual(geometry(),[433,72]);
        await start();
        await op({cmd:'revert'});
        await op({cmd:'cp-safearea',value:'standard'});
        await op({cmd:'apply',panel:'high',mode:'avb'});
        assert.deepEqual(geometry(),[286,72]);assert(fs.readFileSync(target).equals(syn.buf));
        console.log('ok   operation lock, switch back, install activation, remove/reapply preserve the selected area');
        // Power loss after saving a choice but before replacing an enabled plan.
        await op({cmd:'cp-safearea',value:'yandex'});
        await stop();
        fs.writeFileSync(path.join(state,'carplay-safearea'),'standard\n');
        a=cp.spawnSync(process.execPath,[daemon,'activate'],{env,encoding:'utf8',timeout:20000});
        assert.equal(a.status,0,a.stdout+a.stderr);
        assert.deepEqual(geometry(),[286,72], 'install reconciles the saved standard choice over a stale Yandex plan');
        fs.writeFileSync(path.join(state,'carplay-safearea'),'yandex\n');
        a=cp.spawnSync(process.execPath,[path.join(__dirname,'..','recovery.js'),'boot','carplay'],{env,encoding:'utf8',timeout:20000});
        assert.equal(a.status,0,a.stdout+a.stderr);
        assert.deepEqual(geometry(),[433,72], 'boot reconciles the saved Yandex choice over a stale standard plan');
        console.log('ok   interrupted area changes reconcile before install activation and boot arming');
        await start();
        await op({cmd:'apply',panel:'high',mode:'udp'});
        await op({cmd:'cp-safearea',value:'standard'});
        let rec=JSON.parse(fs.readFileSync(path.join(state,'inmem-carplay.json'),'utf8'));
        assert(rec.args.includes('udp://127.0.0.1:20557?mime_type=video/H264'), 'sink is preserved');
        await op({cmd:'apply',panel:'mid',mode:'avb'});
        s=await op({cmd:'cp-safearea',value:'yandex'}, (m)=>m.state==='error');
        assert.equal(s.state,'error');assert.equal(s.safearea,'standard');
        await op({cmd:'apply',panel:'high',mode:'avb'});
        fs.mkdirSync(path.join(state,'carplay-safearea.tmp'));
        s=await op({cmd:'cp-safearea',value:'yandex'}, (m)=>m.state==='error');
        assert.equal(s.state,'error');assert.equal(s.safearea,'standard');assert.deepEqual(geometry(),[286,72]);
        fs.rmdirSync(path.join(state,'carplay-safearea.tmp'));
        fs.renameSync(env.WOC_PRELOAD_LIB,env.WOC_PRELOAD_LIB+'.away');
        s=await op({cmd:'cp-safearea',value:'yandex'}, (m)=>m.state==='error');
        assert.equal(s.state,'error');assert.equal(s.safearea,'yandex');
        fs.renameSync(env.WOC_PRELOAD_LIB+'.away',env.WOC_PRELOAD_LIB);
        await stop();
        a=cp.spawnSync(process.execPath,[path.join(__dirname,'..','recovery.js'),'boot','carplay'],{env,encoding:'utf8',timeout:20000});
        assert.equal(a.status,0,a.stdout+a.stderr);assert.deepEqual(geometry(),[433,72]);
        assert(fs.readFileSync(target).equals(syn.buf));
        console.log('ok   custom sink preserved, unsupported geometry and failed save refused, failed arming recoverable');

        // Existing custom CLI geometry is not a saved selector choice.
        fs.unlinkSync(path.join(state, 'carplay-safearea'));
        const makeCustom = [
            "var im = require(" + JSON.stringify(path.join(__dirname, '..', 'inmem.js')) + ");",
            "im.makePlan('carplay', ['--panel', 'high', '--coding', process.env.WOC_CODING,",
            "'--safe', '600x400+244+40'], 10000, function (err) {",
            "if (err) { console.error(err.message); process.exitCode = 1; } });"
        ].join('\n');
        a = cp.spawnSync(process.execPath, ['-e', makeCustom], { env, encoding: 'utf8', timeout: 20000 });
        assert.equal(a.status, 0, a.stdout + a.stderr);
        a = cp.spawnSync(process.execPath, [daemon, 'activate'], { env, encoding: 'utf8', timeout: 20000 });
        assert.equal(a.status, 0, a.stdout + a.stderr);
        assert.deepEqual(geometry(), [244, 40], 'activation preserves a custom safe area without a saved choice');
        a = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'recovery.js'), 'boot', 'carplay'],
            { env, encoding: 'utf8', timeout: 20000 });
        assert.equal(a.status, 0, a.stdout + a.stderr);
        assert.deepEqual(geometry(), [244, 40], 'boot preserves a custom safe area without a saved choice');
        assert(!fs.existsSync(path.join(state, 'carplay-safearea')));
        console.log('ok   existing custom geometry without a saved profile survives activation and boot');

    } finally {await stop();}
})().catch((e)=>{console.error(e.stack+'\n'+output);process.exitCode=1;});
