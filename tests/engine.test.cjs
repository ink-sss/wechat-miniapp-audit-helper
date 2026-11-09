const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const test=require('node:test');
const path=require('node:path');
const source=readFileSync(path.join(__dirname,'../extension/engine.js'),'utf8');
const fixture=JSON.parse(readFileSync(path.join(__dirname,'fixtures.json'),'utf8'));
const codeFixture=fixture.code;
const classFixture=fixture.form;
const profileFixture=fixture.profile;
const submitFixture={request:{postData:{text:fixture.submitBody}}};
const clone=x=>JSON.parse(JSON.stringify(x));
function setup(options={}){
 let versionReads=0;let submitted=false;let currentName='TARGET';let currentApp='wxTARGET';let token='TOKEN';let calls=[];
 const ctx={URL,URLSearchParams,AbortController,Blob,Date,console:{info(){},table(){}},
  location:{origin:'https://mp.weixin.qq.com',href:'https://mp.weixin.qq.com/wxamp/wacodepage/getcodepage?token=TOKEN',assign(){}},
  history:{replaceState(a,b,u){ctx.location.href=u;}},navigator:{locks:{request:async(n,o,cb)=>cb(options.lockDenied?null:{})}},
  setTimeout:(f,ms)=>setTimeout(f,ms===30000?30000:0),clearTimeout,
  fetch:async(raw,opts)=>{
   let u=new URL(raw),p=u.searchParams.get('path')||'',body=Object.fromEntries(new URLSearchParams(opts.body||''));
   calls.push({pathname:u.pathname,p,method:opts.method,token:u.searchParams.get('token'),body,query:Object.fromEntries(u.searchParams)});
   assert.equal(u.searchParams.get('token'),token,'must use latest token');
   let r={ret:0};
   if(u.pathname.endsWith('/switchAccount')){currentApp=body.appid;currentName='TARGET2';token='TOKEN2';r={ret:0,token};}
   else if(u.pathname.endsWith('/getWxaList'))r={ret:0,wax_list:[{app_name:'TARGET',appid:'wxTARGET'},{app_name:'TARGET2',appid:'wxTARGET2'}]};
   else if(p.includes('/basicprofile?')){r=clone(profileFixture);r.setting_info.original_appid=currentApp;r.setting_info.nickname.nickname=currentName;}
   else if(p.includes('/wacodepage?')){
    versionReads++;r=clone(codeFixture);let d=JSON.parse(r.code_data);d.online_info.basic_info.version=options.online?'1.2.4':'1.2.3';
    if(submitted && !options.unconfirmed){d.experience_info.basic_info.time=Math.floor(Date.now()/1000);d.experience_info.basic_info.audit_id=90001;}
    else if(options.reviewing || (options.becomesReviewing && versionReads > 1)){}
    else if(options.rejected){Object.assign(d.experience_info.basic_info,{status:4,audit_status:3,audit_id:80001});}
    else if(options.existingAudit){Object.assign(d.experience_info.basic_info,options.existingAudit);}
    else d.experience_info={};
    if(!submitted && options.changedAudit && versionReads>1){d.experience_info.basic_info={audit_id:80002,status:3,audit_status:2,version:'1.2.4'};}
    if(options.ambiguous)d.develop_info.info_list.push(clone(d.develop_info.info_list[0]));
    r.code_data=JSON.stringify(d);
   }
   else if(p.includes('get_class')){r=clone(classFixture);if(options.needAccount)r.need_add_test_account=1;
    if(Object.hasOwn(options,'orderPath'))r.online_order_path=options.orderPath;
    if(options.noOrderPath)delete r.online_order_path;
    if(options.formDescription!==undefined){let cl=JSON.parse(r.class_info);cl.version_desc=options.formDescription;r.class_info=JSON.stringify(cl);}
   }
   else if(u.pathname.endsWith('getMpPrivacyMetaMsg'))r={ret:0,data:{ret:0,success:true,ackNoPrivacy:0,needFill:options.privacy?1:0,checkRet:0}};
   else if(u.pathname.endsWith('updatePrivacyCollectMgr'))r={ret:0,data:{retInNode:0}};
   else if(p.includes('submit_check')){if(options.submitRet){r={ret:options.submitRet};}else{submitted=true;if(options.transport)throw Error('simulated lost response');}}
   else throw Error('unexpected path '+u.pathname+' '+p);
   return {ok:true,json:async()=>r};
  }};
 vm.runInNewContext(source,ctx);
 return {api:ctx.WechatAudit,calls,ctx};
}
const task={name:'TARGET',version:'1.2.4',versionDesc:'完善功能'};
test('load performs zero requests',()=>{const e=setup();assert.equal(e.calls.length,0);});
test('dry run uses captured schema and never writes',async()=>{let e=setup();let r=await e.api.current(task);assert.equal(r.status,'READY');assert.ok(e.calls.every(c=>c.method==='GET'&&!c.pathname.endsWith('updatePrivacyCollectMgr')));});
test('execute matches real successful captured payload and verifies receipt',async()=>{let e=setup();let r=await e.api.current(task,{execute:true});assert.equal(r.status,'SUBMITTED_VERIFIED');let sent=e.calls.filter(c=>c.p.includes('submit_check'));assert.equal(sent.length,1);assert.deepEqual(sent[0].body,Object.fromEntries(new URLSearchParams(submitFixture.request.postData.text)));assert.equal(r.audit.auditId,90001);});
test('already reviewing skips even allowResubmit',async()=>{let e=setup({reviewing:true});assert.equal((await e.api.current({...task,allowResubmit:true},{execute:true})).status,'SKIP_REVIEWING');assert.ok(!e.calls.some(c=>c.p.includes('submit_check')));});
test('online same version submits by default without extra flag',async()=>{let e=setup({online:true});assert.equal((await e.api.current(task,{execute:true})).status,'SUBMITTED_VERIFIED');assert.equal(e.calls.filter(c=>c.p.includes('submit_check')).length,1);});
test('legacy allowResubmit false no longer blocks same version',async()=>{let e=setup({online:true});assert.equal((await e.api.current({...task,allowResubmit:false},{execute:true})).status,'SUBMITTED_VERIFIED');});
test('captured rejected state submits without extra flag',async()=>{let e=setup({rejected:true});assert.equal((await e.api.current(task,{execute:true})).status,'SUBMITTED_VERIFIED');});
test('duplicate development version is blocked',async()=>{let e=setup({ambiguous:true});await assert.rejects(e.api.current(task,{execute:true}),{code:'AMBIGUOUS_VERSION'});assert.ok(!e.calls.some(c=>c.p.includes('submit_check')));});
test('wrong identity blocked before submit',async()=>{let e=setup();await assert.rejects(e.api.current({...task,name:'OTHER'},{execute:true}),{code:'IDENTITY_MISMATCH'});});
test('privacy incomplete blocks submission',async()=>{let e=setup({privacy:true});await assert.rejects(e.api.current(task,{execute:true}),{code:'PRIVACY_NEEDS_INPUT'});assert.ok(!e.calls.some(c=>c.p.includes('submit_check')));});
test('test account special flow blocked',async()=>{let e=setup({needAccount:true});await assert.rejects(e.api.current(task,{execute:true}),{code:'TEST_ACCOUNT_REQUIRED'});});
test('lost response only queries state, no resubmission',async()=>{let e=setup({transport:true});assert.equal((await e.api.current(task,{execute:true})).status,'SUBMITTED_VERIFIED');assert.equal(e.calls.filter(c=>c.p.includes('submit_check')).length,1);});
test('unconfirmed state stops without retry',async()=>{let e=setup({unconfirmed:true});await assert.rejects(e.api.current(task,{execute:true}),{code:'SUBMISSION_UNCONFIRMED'});assert.equal(e.calls.filter(c=>c.p.includes('submit_check')).length,1);});
test('cross-tab lock prevents all network requests',async()=>{let e=setup({lockDenied:true});await assert.rejects(e.api.current(task,{execute:true}),{code:'BUSY'});assert.equal(e.calls.length,0);});
test('batch switch consumes fresh token before all subsequent calls',async()=>{let e=setup();let r=await e.api.run([{...task,name:'TARGET2'}],{execute:true});assert.equal(r[0].status,'SUBMITTED_VERIFIED');assert.equal(e.calls.find(c=>c.p.includes('submit_check')).token,'TOKEN2');});
test('duplicate batch tasks rejected',async()=>{let e=setup();await assert.rejects(e.api.run([task,task]),{code:'DUPLICATE_TASK'});assert.equal(e.calls.length,0);});

test('script exposes version for reload verification',()=>{assert.equal(setup().api.version,'1.1.1');});
test('online same version precheck is READY',async()=>{const e=setup({online:true});assert.equal((await e.api.current(task)).status,'READY');assert.ok(!e.calls.some(c=>c.p.includes('submit_check')));});
test('existing non-reviewing record passes without requiring rejected enum',async()=>{const e=setup({online:true,existingAudit:{audit_id:80001,status:3,audit_status:2}});assert.equal((await e.api.current(task,{execute:true})).status,'SUBMITTED_VERIFIED');assert.equal(e.calls.filter(c=>c.p.includes('submit_check')).length,1);});
test('unrecognized non-reviewing state is decided by platform response',async()=>{const e=setup({existingAudit:{audit_id:80001,status:99,audit_status:99},submitRet:85009});await assert.rejects(e.api.current(task,{execute:true}),{code:'API_ERROR'});assert.equal(e.calls.filter(c=>c.p.includes('submit_check')).length,1);});
test('batch supports same online version without flag',async()=>{const e=setup({online:true});const r=await e.api.run([task],{execute:true});assert.equal(r[0].status,'SUBMITTED_VERIFIED');assert.ok(!e.calls.some(c=>c.pathname.endsWith('/switchAccount')));});
test('new pending review between precheck and submit skips without write',async()=>{const e=setup({becomesReviewing:true});assert.equal((await e.api.current(task,{execute:true})).status,'SKIP_REVIEWING');assert.ok(!e.calls.some(c=>c.p.includes('submit_check')||c.pathname.endsWith('updatePrivacyCollectMgr')));});
test('changed audit identity between checks stops without write',async()=>{const e=setup({existingAudit:{audit_id:80001,status:3,audit_status:2},changedAudit:true});await assert.rejects(e.api.current(task,{execute:true}),{code:'AUDIT_CHANGED'});assert.ok(!e.calls.some(c=>c.p.includes('submit_check')||c.pathname.endsWith('updatePrivacyCollectMgr')));});

for (const [label, value] of [['empty',''],['whitespace','  \n\t '],['null',null],['omitted',undefined]]) {
 test(`versionDesc ${label} defaults to 完善功能 and submits`,async()=>{
  const e=setup({formDescription:'历史说明'});
  const t={...task,versionDesc:value};if(label==='omitted')delete t.versionDesc;
  assert.equal((await e.api.current(t,{execute:true})).status,'SUBMITTED_VERIFIED');
  assert.equal(e.calls.find(c=>c.p.includes('submit_check')).body.version_desc,'完善功能');
 });
}
test('nonempty description is preserved after trimming',async()=>{
 const e=setup();await e.api.current({...task,versionDesc:' 优化订单查询 '},{execute:true});
 assert.equal(e.calls.find(c=>c.p.includes('submit_check')).body.version_desc,'优化订单查询');
});
test('description over 200 chars still fails before any write',async()=>{
 const e=setup();await assert.rejects(e.api.current({...task,versionDesc:'字'.repeat(201)},{execute:true}),{code:'DESCRIPTION_TOO_LONG'});
 assert.ok(!e.calls.some(c=>c.p.includes('submit_check')||c.pathname.endsWith('updatePrivacyCollectMgr')));
});
for (const [label, value] of [['empty',''],['whitespace','   '],['null',null]]) {
 test(`explicit ${label} orderPath stays empty despite saved path`,async()=>{
  const e=setup();await e.api.current({...task,orderPath:value},{execute:true});
  assert.equal(e.calls.find(c=>c.p.includes('submit_check')).body.order_path,'');
 });
}
test('trade app without any saved orderPath submits empty',async()=>{
 const e=setup({noOrderPath:true});await e.api.current(task,{execute:true});
 assert.equal(e.calls.find(c=>c.p.includes('submit_check')).body.order_path,'');
});
test('trade app with blank saved orderPath submits empty',async()=>{
 const e=setup({orderPath:''});await e.api.current(task,{execute:true});
 assert.equal(e.calls.find(c=>c.p.includes('submit_check')).body.order_path,'');
});
test('omitted orderPath still inherits saved path',async()=>{
 const e=setup({orderPath:'pages/orders/index'});await e.api.current(task,{execute:true});
 assert.equal(e.calls.find(c=>c.p.includes('submit_check')).body.order_path,'pages/orders/index');
});
test('precheck reports actual fallback values without writing',async()=>{
 const e=setup();const r=await e.api.current({...task,versionDesc:'',orderPath:''});
 assert.equal(r.versionDesc,'完善功能');assert.equal(r.orderPath,'');assert.equal(r.status,'READY');
 assert.ok(!e.calls.some(c=>c.p.includes('submit_check')||c.pathname.endsWith('updatePrivacyCollectMgr')));
});
test('batch uses description fallback and empty orderPath',async()=>{
 const e=setup({orderPath:''});const r=await e.api.run([{...task,versionDesc:''}],{execute:true});
 assert.equal(r[0].status,'SUBMITTED_VERIFIED');const body=e.calls.find(c=>c.p.includes('submit_check')).body;
 assert.equal(body.version_desc,'完善功能');assert.equal(body.order_path,'');
});

test('per-app progress emits real stages in order',async()=>{
 const e=setup();const stages=[];
 const r=await e.api.process({...task,appid:'wxTARGET'},{execute:true,onProgress:async p=>stages.push([p.stage,p.percent])});
 assert.equal(r.status,'SUBMITTED_VERIFIED');
 assert.deepEqual(stages,[['switching',0],['reading',20],['prepared',40],['submitting',60],['verifying',80],['success',100]]);
});
test('skipped app never emits a false 100 percent',async()=>{
 const e=setup({reviewing:true});const progress=[];
 const r=await e.api.process({...task,appid:'wxTARGET'},{execute:true,onProgress:async p=>progress.push(p.percent)});
 assert.equal(r.status,'SKIP_REVIEWING');assert.ok(!progress.includes(100));
});
test('precheck stays at prepared 40 percent',async()=>{
 const e=setup();const progress=[];
 await e.api.process({...task,appid:'wxTARGET'},{onProgress:async p=>progress.push(p.percent)});
 assert.equal(progress.at(-1),40);assert.ok(!e.calls.some(c=>c.p.includes('submit_check')));
});
test('lost extension connection at submitting stage prevents submit',async()=>{
 const e=setup();await assert.rejects(e.api.process({...task,appid:'wxTARGET'},{execute:true,onProgress:async p=>{if(p.percent===60)throw Error('connection closed');}}));
 assert.ok(!e.calls.some(c=>c.p.includes('submit_check')));
});

test('retired engine cannot send another request after a replacement generation',async()=>{
 const e=setup();e.ctx.__auditEngineEpochV2={};await assert.rejects(e.api.inspect(),{code:'ENGINE_REPLACED'});assert.equal(e.calls.length,0);
});
test('invalidated Chrome extension context stops before fetch',async()=>{
 const e=setup();e.ctx.chrome={runtime:{id:'ext',getManifest(){throw Error('context invalidated');}}};
 await assert.rejects(e.api.inspect(),{code:'EXTENSION_RELOADED'});assert.equal(e.calls.length,0);
});
test('new generation replaces stale busy object without reloading document',async()=>{
 const e=setup();e.ctx.WechatAudit={busy:true};let navigations=0;e.ctx.location.assign=()=>navigations++;
 vm.runInNewContext(source,e.ctx);const who=await e.ctx.WechatAudit.inspect();assert.equal(who.current.name,'TARGET');assert.equal(navigations,0);
});
test('audit recovery observation performs only GET reads',async()=>{
 const e=setup({reviewing:true});const r=await e.api.observeAudit();assert.equal(r.reviewing,true);assert.ok(r.audit.auditId);assert.ok(e.calls.every(c=>c.method==='GET'));assert.ok(!e.calls.some(c=>c.pathname.endsWith('updatePrivacyCollectMgr')));
});
test('submission checkpoint is acknowledged before final POST is sent',async()=>{
 const e=setup({rejected:true});let checkpoint;
 await e.api.process({...task,appid:'wxTARGET'},{execute:true,onProgress:async p=>{
  if(p.stage==='submitting'){checkpoint=p.checkpoint;assert.equal(e.calls.filter(c=>c.p.includes('submit_check')).length,0);}
 }});
 assert.equal(checkpoint.previousAuditId,'80001');assert.ok(checkpoint.since>0);
});
test('switching and submitting do not navigate or reload host document',async()=>{
 const e=setup();let navigations=0;e.ctx.location.assign=()=>navigations++;
 await e.api.process({...task,name:'TARGET2',appid:'wxTARGET2'},{execute:true});
 assert.equal(navigations,0);assert.match(e.ctx.location.href,/token=TOKEN2/);
});
