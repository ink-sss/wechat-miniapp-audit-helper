const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const tasks=[{appid:'wx1',name:'甲',version:'1.2.4'},{appid:'wx2',name:'乙',version:'1.2.4'}];
const spin=()=>new Promise(r=>setImmediate(r));
async function until(fn){for(let n=0;n<100;n++){if(fn())return;await spin();}throw Error('timeout');}
function setup(options={}){
 let listener,events=[],calls=[],active=0,maxActive=0,release;
 const gate=new Promise(r=>release=r);
 const context={crypto:{randomUUID:()=> 'doc'},Date,console,
  chrome:{runtime:{id:'ext',getManifest:()=>({version:'1.0.2'}),sendMessage:async m=>{events.push(structuredClone(m.job));return {ok:true};}}},
  WechatAudit:{runtimeVersion:'1.0.2',busy:false,stop(){},observeAudit:async()=>({current:tasks[0],reviewing:true,audit:{auditId:123}}),inspect:async()=>({current:tasks[0],apps:tasks}),openCurrent(){},process:async(task,o)=>{
    active++;maxActive=Math.max(maxActive,active);calls.push(task.name);
    try{
      await o.onProgress({stage:'switching',percent:0});await o.onProgress({stage:'reading',percent:20});
      if(task.name==='甲'&&options.gate)await gate;
      if(task.name==='甲'&&options.fail)throw Object.assign(Error('缺少版本'),{code:options.fail});
      await o.onProgress({stage:'prepared',percent:40});
      if(o.execute){await o.onProgress({stage:'submitting',percent:60});await o.onProgress({stage:'verifying',percent:80});}
      return {status:o.execute?'SUBMITTED_VERIFIED':'READY',audit:{auditId:123}};
    }finally{active--;}
  }}};
 vm.createContext(context);for(const file of ['shared.js','content.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension',file),'utf8'),context);
 const send=m=>context.__auditBridgeV2.dispatch({protocol:2,...m});
 return {send,events,calls,release,context,get maxActive(){return maxActive}};
}
test('controller runs serially and every app reaches own success',async()=>{const e=setup();const inspect=await e.send({type:'INSPECT'});await e.send({type:'START',batchId:'a',tasks,signature:inspect.signature});await until(()=>e.events.at(-1)?.status==='completed');assert.equal(e.maxActive,1);assert.deepEqual(e.calls,['甲','乙']);assert.ok(e.events.at(-1).rows.every(r=>r.status==='success'&&r.percent===100));});
test('pause finishes current app and leaves next at zero',async()=>{const e=setup({gate:true});const i=await e.send({type:'INSPECT'});await e.send({type:'START',batchId:'a',tasks,signature:i.signature});await until(()=>e.calls.length===1);await e.send({type:'PAUSE'});e.release();await until(()=>e.events.at(-1)?.status==='paused');assert.deepEqual(e.calls,['甲']);assert.equal(e.events.at(-1).rows[0].percent,100);assert.equal(e.events.at(-1).rows[1].percent,0);});
test('known per-app business error continues next app',async()=>{const e=setup({fail:'VERSION_NOT_FOUND'});const i=await e.send({type:'INSPECT'});await e.send({type:'START',batchId:'a',tasks,signature:i.signature});await until(()=>e.events.at(-1)?.status==='completed');assert.equal(e.events.at(-1).rows[0].status,'failed');assert.equal(e.events.at(-1).rows[1].status,'success');});
test('session-level error halts entire queue',async()=>{const e=setup({fail:'IDENTITY_MISMATCH'});const i=await e.send({type:'INSPECT'});await e.send({type:'START',batchId:'a',tasks,signature:i.signature});await until(()=>e.events.at(-1)?.status==='halted');assert.deepEqual(e.calls,['甲']);assert.equal(e.events.at(-1).rows[1].status,'waiting');});
test('stale account signature rejected before process',async()=>{const e=setup();await e.send({type:'INSPECT'});const r=await e.send({type:'START',batchId:'a',tasks,signature:'stale'});assert.equal(r.ok,false);assert.equal(e.calls.length,0);});
test('preview uses read-only engine mode',async()=>{const e=setup();const i=await e.send({type:'INSPECT'});await e.send({type:'START',batchId:'a',tasks,signature:i.signature,preview:true});await until(()=>e.events.at(-1)?.status==='completed');assert.ok(e.events.at(-1).rows.every(r=>r.status==='ready'&&r.percent===40));});
test('duplicate START during execution is rejected',async()=>{const e=setup({gate:true});const i=await e.send({type:'INSPECT'});await e.send({type:'START',batchId:'a',tasks,signature:i.signature});assert.equal((await e.send({type:'START',batchId:'b',tasks,signature:i.signature})).ok,false);e.release();await until(()=>e.events.at(-1)?.status==='completed');assert.equal(e.calls.length,2);});

test('versioned direct dispatch reports runtime version and protocol',async()=>{
 const e=setup();const r=await e.send({type:'PING'});assert.equal(r.version,'1.0.2');assert.equal(r.protocol,2);
});
test('retired controller rejects all new work',async()=>{
 const e=setup();e.context.__auditBridgeV2.dispose();const r=await e.send({type:'INSPECT'});assert.equal(r.ok,false);assert.equal(r.code,'CONTEXT_INVALID');assert.equal(e.calls.length,0);
});
test('extension reload invalidates old bridge without navigating page',async()=>{
 const e=setup();e.context.chrome.runtime.getManifest=()=>{throw Error('context invalidated');};const r=await e.send({type:'PING'});assert.equal(r.code,'CONTEXT_INVALID');
});
test('read-only observation never invokes process',async()=>{
 const e=setup();const r=await e.send({type:'OBSERVE_AUDIT'});assert.equal(r.audit.auditId,123);assert.equal(e.calls.length,0);
});
test('duplicate content injection does not replace healthy bridge',async()=>{
 const e=setup();const first=e.context.__auditBridgeV2;vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/content.js'),'utf8'),e.context);assert.equal(e.context.__auditBridgeV2,first);
});
