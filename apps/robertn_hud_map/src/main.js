'use strict';
const {HudApp}=require('./app.js');const app=new HudApp();app.on('hudStopped',()=>process.exit(0));app.start().catch(()=>{});
