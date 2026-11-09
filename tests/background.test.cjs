const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
function setup(options={}){
 let listener,onUpdated,onRemoved,session={},local={},tab={id:8,windowId:1,url:'https://mp.weixin.qq.com/wxamp?token=123',active:true},ping={ok:true,documentKey:'doc',running:false,version:'1.0.2',protocol:2};
 let missing=false,lockFree=true,installed=0,commands=[],observed=null;
 const tasks=[{appid:'wx1',name:'甲',version:'1.2.4'}];
 const storage=db=>({get:async key=>key===null?structuredClone(db):Object.fromEntries((Array.isArray(key)?key:[key]).filter(k=>k in db).map(k=>[k,structuredClone(db[k])])),set:async obj=>Object.assign(db,structuredClone(obj)),remove:async k=>{delete db[k];}});
 const context={URL,Date,setTimeout,clearTimeout,crypto:{randomUUID:()=> 'batch'},console,
  chrome:{storage:{session:storage(session),local:storage(local)},scripting:{executeScript:async o=>{
    if(o.files){installed++;missing=false;ping={ok:true,version:'1.0.2',protocol:2,documentKey:'doc-installed-'+installed,running:false};return [{frameId:0}];}
    if(!o.args)return [{frameId:0,result:{free:lockFree}}];
    const m=o.args[0];commands.push(m.type);
    let r;
    if(missing)r={ok:false,code:'BRIDGE_MISSING',error:'missing bridge'};
    else if(m.type==='PING')r=typeof ping==='function'?await ping():ping;
    else if(m.type==='INSPECT'){const p=typeof ping==='function'?await ping():ping;r={ok:true,documentKey:p.documentKey,version:p.version,protocol:p.protocol,current:tasks[0],apps:tasks,signature:'wx1'};}
    else if(m.type==='OBSERVE_AUDIT')r={ok:true,...observed};
    else if(m.type==='START')r={ok:true};
    else r={ok:true};
    return [{frameId:0,result:r}];
   }},
   sidePanel:{setPanelBehavior:async()=>{}},runtime:{id:'ext',getURL:p=>'chrome-extension://ext/'+p,onMessage:{addListener:fn=>listener=fn},onInstalled:{addListener(){}},onStartup:{addListener(){}}},
   tabs:{get:async()=>tab,query:async()=>[tab],sendMessage:async()=>{throw Error('legacy transport must not be used');},onRemoved:{addListener(fn){onRemoved=fn;}},onUpdated:{addListener(fn){onUpdated=fn;}}}
  }};
 vm.createContext(context);context.importScripts=file=>vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension',file),'utf8'),context);
 vm.runInContext(options.source||fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),context);
 const call=(type,extra={})=>new Promise(resolve=>listener({type,windowId:1,...extra},{id:'ext',url:'chrome-extension://ext/panel.html'},resolve));
 const direct=(message,sender)=>new Promise(resolve=>{if(!listener({protocol:2,version:'1.0.2',...message},sender,resolve))resolve(null);});
 return {session,local,call,direct,context,tasks,commands,get installed(){return installed;},
  setMissing:r=>missing=r,setLock:r=>lockFree=r,setObservation:r=>observed=r,
  setPing:r=>ping=typeof r==='function'?async()=>({version:'1.0.2',protocol:2,...await r()}):({version:'1.0.2',protocol:2,...r}),
  setTab:r=>Object.assign(tab,r),onUpdated:(...args)=>onUpdated(...args),onRemoved:(...args)=>onRemoved(...args)};
}
test('background reads connection without exposing token',async()=>{const e=setup();assert.equal((await e.call('REFRESH',{tabId:8})).ok,true);const r=await e.call('STATE');assert.equal(r.view.current.name,'甲');assert.ok(!JSON.stringify(r).includes('token='));});
test('ordinary page cannot send START command',async()=>{const e=setup();const r=await e.direct({type:'START',windowId:1,tasks:e.tasks},{id:'ext',url:'https://mp.weixin.qq.com/',tab:{id:8},frameId:0});assert.equal(r,null);assert.equal(e.session.active,undefined);});
test('starting lease not invalidated by UI reading STATE',async()=>{const e=setup();await e.call('REFRESH',{tabId:8});e.session.active={tabId:8,windowId:1,documentKey:'doc',batchId:'batch',phase:'starting',startedAt:Date.now()};e.session['view:1'].job={id:'batch',status:'running',rows:[]};await e.call('STATE');assert.ok(e.session.active);assert.equal(e.session['view:1'].connected,true);});
test('another window cannot start while active lease exists',async()=>{const e=setup();await e.call('REFRESH',{tabId:8});e.session.active={batchId:'other',windowId:2,tabId:99};const r=await e.call('START',{tasks:e.tasks});assert.equal(r.ok,false);assert.match(r.error,/已有批次/);});
test('wrong document progress rejected',async()=>{const e=setup();await e.call('REFRESH',{tabId:8});e.session.active={tabId:8,windowId:1,documentKey:'doc',batchId:'batch'};const r=await e.direct({type:'JOB_UPDATE',documentKey:'bad',job:{id:'batch',status:'completed',rows:[]}},{id:'ext',url:'https://mp.weixin.qq.com/',tab:{id:8},frameId:0});assert.equal(r.ok,false);assert.ok(e.session.active);});
test('completed job persisted and lease released',async()=>{const e=setup();await e.call('REFRESH',{tabId:8});e.session.active={tabId:8,windowId:1,documentKey:'doc',batchId:'batch'};const r=await e.direct({type:'JOB_UPDATE',documentKey:'doc',job:{id:'batch',status:'completed',rows:[]}},{id:'ext',url:'https://mp.weixin.qq.com/',tab:{id:8},frameId:0});assert.equal(r.ok,true);assert.equal(e.session.active,undefined);assert.equal(e.local.history[0].id,'batch');});
test('lost runner interrupts in-flight but preserves waiting item',async()=>{const e=setup();await e.call('REFRESH',{tabId:8});e.session.active={tabId:8,windowId:1,documentKey:'doc',batchId:'batch',phase:'running'};e.session['view:1'].job={id:'batch',status:'running',rows:[{status:'submitting',percent:60},{status:'waiting',percent:0}]};e.setPing({ok:true,documentKey:'newdoc',running:false});await e.call('STATE');assert.equal(e.session['view:1'].job.rows[0].status,'uncertain');assert.equal(e.session['view:1'].job.rows[1].status,'waiting');assert.equal(e.session.active,undefined);});
test('refresh same account preserves interrupted batch for explicit continuation',async()=>{const e=setup();await e.call('REFRESH',{tabId:8});e.session['view:1'].job={id:'saved',status:'interrupted',rows:[{task:e.tasks[0],status:'waiting',percent:0}]};e.session['view:1'].documentKey='old-doc';assert.equal((await e.call('REFRESH',{tabId:8})).ok,true);assert.equal(e.session['view:1'].job.id,'saved');assert.equal(e.session['view:1'].documentKey,'doc');});

async function running(e,percent=0){
 await e.call('REFRESH',{tabId:8});
 const job={id:'batch',status:'running',rows:[{task:e.tasks[0],status:percent>=60?'submitting':'switching',percent},{task:{appid:'wx2',name:'乙',version:'1.2.4'},status:'waiting',percent:0}]};
 e.session['view:1'].job=job;
 e.session.active={tabId:8,windowId:1,documentKey:'doc',batchId:'batch',phase:'running'};
 e.setPing({ok:true,documentKey:'doc',running:true,job});
 return job;
}
test('switchAccount URL/token loading event preserves same-document running job',async()=>{
 const e=setup();const job=await running(e);
 e.setTab({url:'https://mp.weixin.qq.com/wxamp/wacodepage/getcodepage?token=456',status:'loading'});
 await e.onUpdated(8,{status:'loading',url:'https://mp.weixin.qq.com/wxamp/wacodepage/getcodepage?token=456'});
 assert.equal(e.session.active.batchId,'batch');assert.equal(e.session['view:1'].connected,true);
 assert.equal(e.session['view:1'].job.rows[0].status,'switching');
 const r=await e.direct({type:'JOB_UPDATE',documentKey:'doc',job:{...job,rows:[{...job.rows[0],status:'reading',percent:20},job.rows[1]]}},{id:'ext',url:'https://mp.weixin.qq.com/',tab:{id:8},frameId:0});
 assert.equal(r.ok,true);assert.equal(e.session['view:1'].job.rows[0].percent,20);
});
test('same-document complete event also preserves queue',async()=>{
 const e=setup();await running(e,60);e.setTab({status:'complete'});
 await e.onUpdated(8,{status:'complete'});assert.ok(e.session.active);assert.equal(e.session['view:1'].job.status,'running');
});
test('non-navigation update does not probe or interrupt',async()=>{
 const e=setup();await running(e);e.setPing(()=>{throw Error('should not ping');});
 await e.onUpdated(8,{title:'已切换小程序'});assert.ok(e.session.active);
});
test('loading temporary messaging loss waits for complete instead of releasing lease',async()=>{
 const e=setup();const job=await running(e);e.setPing(()=>{throw Error('temporarily disconnected');});
 await e.onUpdated(8,{status:'loading'});assert.ok(e.session.active);assert.equal(e.session['view:1'].job.status,'running');
 e.setPing({ok:true,documentKey:'doc',running:true,job});e.setTab({status:'complete'});await e.onUpdated(8,{status:'complete'});
 assert.ok(e.session.active);assert.equal(e.session['view:1'].connected,true);
});
test('STATE during real loading does not release lock on temporary missing receiver',async()=>{
 const e=setup();await running(e);e.setTab({status:'loading'});e.setPing(()=>{throw Error('loading');});
 const r=await e.call('STATE');assert.equal(r.ok,true);assert.ok(e.session.active);
});
test('actual document replacement at commit interrupts even if URL looks identical',async()=>{
 const e=setup();await running(e,60);e.setPing({ok:true,documentKey:'doc-new',running:false});
 await e.onUpdated(8,{status:'complete'});assert.equal(e.session.active,undefined);assert.equal(e.session['view:1'].job.rows[0].status,'uncertain');
});
test('closed tab still interrupts without probe',async()=>{
 const e=setup();await running(e,60);await e.onRemoved(8);assert.equal(e.session.active,undefined);assert.equal(e.session['view:1'].connected,false);
});
test('switch-stage real interruption says no submission sent',async()=>{
 const e=setup();await running(e,0);e.setPing({ok:true,documentKey:'different',running:false});
 await e.onUpdated(8,{status:'complete'});const row=e.session['view:1'].job.rows[0];assert.equal(row.status,'failed');assert.match(row.message,/尚未发送提审/);assert.equal(row.percent,0);
});
test('finished runner checkpoint is accepted rather than treated as a reload',async()=>{
 const e=setup();const job=await running(e);e.setPing({ok:true,documentKey:'doc',running:false,job:{...job,status:'completed'}});
 await e.onUpdated(8,{status:'complete'});assert.equal(e.session['view:1'].job.status,'completed');assert.equal(e.session['view:1'].connected,true);assert.equal(e.session.active,undefined);
});
test('stale probe response cannot invalidate a newly reconnected job',async()=>{
 const e=setup();await running(e);let resolvePing;const wait=new Promise(r=>{resolvePing=r;});e.setPing(()=>wait);
 const probe=e.onUpdated(8,{status:'complete'});
 await new Promise(r=>setImmediate(r));
 e.session.active={tabId:8,windowId:1,documentKey:'fresh',batchId:'fresh-batch',phase:'running'};
 e.session['view:1'].documentKey='fresh';e.session['view:1'].job.id='fresh-batch';
 resolvePing({ok:true,documentKey:'other',running:false});await probe;
 assert.equal(e.session.active.batchId,'fresh-batch');assert.equal(e.session['view:1'].connected,true);
});

test('healthy current bridge is reused without injection or navigation',async()=>{
 const e=setup();const r=await e.call('STATE');assert.equal(r.view.connected,true);assert.equal(r.view.runtimeVersion,'1.0.2');assert.equal(e.installed,0);
});
test('old runtime is hot-replaced on same tab without legacy message transport',async()=>{
 const e=setup();await running(e);e.session['view:1'].runtimeVersion='1.0.1';e.setPing({ok:true,documentKey:'doc',version:'1.0.1',protocol:1,running:false});
 const r=await e.call('STATE');assert.equal(r.ok,true);assert.equal(r.view.connected,true);assert.equal(r.view.runtimeVersion,'1.0.2');assert.equal(e.installed,1);assert.equal(r.view.job.rows[0].status,'failed');assert.ok(!e.commands.includes('START'));
});
test('missing receiver triggers injection, not host page refresh',async()=>{
 const e=setup();await e.call('REFRESH',{tabId:8});e.session['view:1'].connected=false;e.setMissing(true);
 const r=await e.call('STATE');assert.equal(r.view.connected,true);assert.equal(e.installed,1);assert.equal(r.view.tabId,8);
});
test('old in-flight lock waits and reconnects automatically on subsequent probe',async()=>{
 const e=setup();await e.call('REFRESH',{tabId:8});e.session['view:1'].connected=false;e.setMissing(true);e.setLock(false);
 let r=await e.call('STATE');assert.equal(r.reconnect.waiting,true);assert.equal(e.installed,0);assert.ok(!e.commands.includes('START'));
 e.setLock(true);r=await e.call('STATE');assert.equal(r.view.connected,true);assert.equal(e.installed,1);
});
test('session erased by extension reload recovers persisted unfinished batch without resubmitting',async()=>{
 const e=setup();e.local.history=[{id:'persisted',status:'running',rows:[{task:e.tasks[0],status:'switching',percent:0}]}];e.setMissing(true);
 const r=await e.call('STATE');assert.equal(r.view.connected,true);assert.equal(r.view.job.id,'persisted');assert.equal(r.view.job.status,'interrupted');assert.equal(r.view.job.rows[0].status,'failed');assert.ok(!e.commands.includes('START'));
});
test('reconnect verifies sent submission from checkpoint via read-only observation',async()=>{
 const e=setup();e.local.history=[{id:'sent',status:'running',rows:[{task:e.tasks[0],status:'submitting',percent:60,checkpoint:{previousAuditId:12,since:100}}]}];
 e.setObservation({current:e.tasks[0],reviewing:true,audit:{version:'1.2.4',auditId:13,submittedAtEpoch:110}});
 const r=await e.call('STATE');assert.equal(r.view.job.rows[0].status,'success');assert.equal(r.view.job.rows[0].recovered,true);assert.ok(e.commands.includes('OBSERVE_AUDIT'));assert.ok(!e.commands.includes('START'));
});
test('old-version sent checkpoint without baseline stays uncertain, never blindly resent',async()=>{
 const e=setup();e.local.history=[{id:'sent',status:'running',rows:[{task:e.tasks[0],status:'submitting',percent:60}]}];
 e.setObservation({current:e.tasks[0],reviewing:true,audit:{version:'1.2.4',auditId:13,submittedAtEpoch:110}});
 const r=await e.call('STATE');assert.equal(r.view.job.rows[0].status,'uncertain');assert.ok(!e.commands.includes('START'));
});
test('observation from different account cannot confirm submission',async()=>{
 const e=setup();e.local.history=[{id:'sent',status:'running',rows:[{task:e.tasks[0],status:'submitting',percent:60,checkpoint:{previousAuditId:12,since:100}}]}];
 e.setObservation({current:{appid:'wrong'},reviewing:true,audit:{version:'1.2.4',auditId:13,submittedAtEpoch:110}});
 const r=await e.call('STATE');assert.equal(r.view.job.rows[0].status,'uncertain');
});
test('healthy running job survives opening another side panel',async()=>{
 const e=setup();await running(e,60);const r=await e.call('STATE');assert.equal(r.view.job.status,'running');assert.equal(e.installed,0);assert.equal(e.commands.filter(t=>t==='INSPECT').length,1);
});
test('legacy runtime updates cannot revive retired batch after protocol upgrade',async()=>{
 const e=setup();await running(e);const r=await e.direct({type:'JOB_UPDATE',protocol:undefined,version:undefined,documentKey:'doc',job:{id:'batch',status:'completed',rows:[]}},{id:'ext',url:'https://mp.weixin.qq.com/',tab:{id:8},frameId:0});assert.equal(r.ok,false);assert.ok(e.session.active);
});
