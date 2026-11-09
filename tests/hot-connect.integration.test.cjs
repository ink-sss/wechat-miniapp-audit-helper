const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const dir=path.join(__dirname,'../extension'),fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures.json'),'utf8'));
const clone=x=>JSON.parse(JSON.stringify(x));
function environment(){
 let backgroundListener,lock=false,postCount=0,navigations=0,legacyCalls=0,seq=0;
 const session={},local={},tab={id:10,windowId:1,active:true,status:'complete',url:'https://mp.weixin.qq.com/wxamp/wacodepage/getcodepage?token=123'};
 const tasks=[{appid:'wxTARGET',name:'TARGET',version:'1.2.4'}];
 const storage=data=>({get:async k=>k===null?clone(data):{[k]:data[k]===undefined?undefined:clone(data[k])},set:async values=>Object.assign(data,clone(values)),remove:async k=>{delete data[k];}});
 const page={URL,URLSearchParams,AbortController,Blob,Date,console:{info(){},table(){}},setTimeout,clearTimeout,crypto:{randomUUID:()=>`doc-${++seq}`},
  location:{origin:'https://mp.weixin.qq.com',href:tab.url,assign(){navigations++;}},history:{replaceState(a,b,u){page.location.href=u;tab.url=u;}},
  navigator:{locks:{request:async(n,o,fn)=>{if(lock)return fn(null);lock=true;try{return await fn({});}finally{lock=false;}}}},
  __auditExtensionController:{documentKey:'legacy-doc'},WechatAudit:{busy:true,stop(){}},
  chrome:{runtime:{id:'ext',getManifest:()=>({version:'1.0.2'}),sendMessage:m=>new Promise(resolve=>backgroundListener(m,{id:'ext',url:page.location.href,tab:{id:10},frameId:0},resolve))}},
  fetch:async raw=>{
   const u=new URL(raw),p=u.searchParams.get('path')||'';let data;
   if(p.includes('/basicprofile?'))data=clone(fixture.profile);
   else if(u.pathname.endsWith('getWxaList'))data={ret:0,wax_list:[{appid:'wxTARGET',app_name:'TARGET'}]};
   else if(p.includes('/wacodepage?')){data=clone(fixture.code);const d=JSON.parse(data.code_data);d.online_info.basic_info.version='1.2.3';if(!postCount)d.experience_info={};else{d.experience_info.basic_info.time=Math.floor(Date.now()/1000);d.experience_info.basic_info.audit_id=123456;}data.code_data=JSON.stringify(d);}
   else if(p.includes('get_class'))data=clone(fixture.form);
   else if(u.pathname.endsWith('getMpPrivacyMetaMsg'))data={ret:0,data:{ret:0,success:true,ackNoPrivacy:0,needFill:0,checkRet:0}};
   else if(u.pathname.endsWith('updatePrivacyCollectMgr'))data={ret:0,data:{retInNode:0}};
   else if(p.includes('submit_check')){postCount++;data={ret:0};}
   else throw Error('unexpected mock request');
   return {ok:true,json:async()=>data};
  }};
 vm.createContext(page);
 const worker={URL,Date,setTimeout,clearTimeout,crypto:{randomUUID:()=>`batch-${++seq}`},console,
  chrome:{storage:{session:storage(session),local:storage(local)},sidePanel:{setPanelBehavior:async()=>{}},
   runtime:{id:'ext',getURL:p=>'chrome-extension://ext/'+p,onMessage:{addListener:fn=>backgroundListener=fn},onInstalled:{addListener(){}},onStartup:{addListener(){}}},
   tabs:{get:async()=>tab,query:async()=>[tab],sendMessage:async()=>{legacyCalls++;throw Error('old listener must not handle commands');},onUpdated:{addListener(){}},onRemoved:{addListener(){}}},
   scripting:{executeScript:async options=>{
    assert.equal(options.world,'ISOLATED');
    if(options.files){for(const f of options.files)vm.runInContext(fs.readFileSync(path.join(dir,f),'utf8'),page);return [{frameId:0}];}
    page.__testArgs=options.args||[];
    const result=await vm.runInContext(`(${options.func.toString()})(...__testArgs)`,page);
    return [{frameId:0,result}];
   }}
  }};
 vm.createContext(worker);worker.importScripts=f=>vm.runInContext(fs.readFileSync(path.join(dir,f),'utf8'),worker);
 vm.runInContext(fs.readFileSync(path.join(dir,'background.js'),'utf8'),worker);
 const call=(type,extra={})=>new Promise(resolve=>backgroundListener({type,windowId:1,...extra},{id:'ext',url:'chrome-extension://ext/panel.html'},resolve));
 return {call,tasks,session,local,page,get postCount(){return postCount;},get navigations(){return navigations;},get legacyCalls(){return legacyCalls;}};
}
async function until(fn){for(let n=0;n<100;n++){if(fn())return;await new Promise(r=>setImmediate(r));}throw Error('timeout');}
test('actual worker/controller/engine hot-inject over legacy object then submit without navigating (mock HTTP)',async()=>{
 const e=environment();const connected=await e.call('STATE');assert.equal(connected.view.connected,true);assert.equal(connected.view.runtimeVersion,'1.0.2');assert.equal(e.postCount,0);
 const started=await e.call('START',{tasks:e.tasks});assert.equal(started.ok,true);
 await until(()=>e.session['view:1'].job.status==='completed');
 assert.equal(e.session['view:1'].job.rows[0].percent,100);assert.equal(e.postCount,1);assert.equal(e.navigations,0);assert.equal(e.legacyCalls,0);
});
test('session-reset hot reconnect restores uncertain checkpoint by GET only (mock HTTP)',async()=>{
 const e=environment();await e.call('STATE');await e.call('START',{tasks:e.tasks});await until(()=>e.session['view:1'].job.status==='completed');
 const saved=e.local.history[0];saved.status='running';saved.rows[0].status='submitting';saved.rows[0].percent=60;
 for(const k of Object.keys(e.session))delete e.session[k];
 const r=await e.call('STATE');assert.equal(r.view.connected,true);assert.equal(r.view.job.rows[0].status,'success');assert.equal(r.view.job.rows[0].recovered,true);assert.equal(e.postCount,1);assert.equal(e.navigations,0);
});
