const {JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=path.resolve(__dirname,'../extension');
const apps=['示例商城 A','示例商城 B','示例商城 C','示例商城 D','示例商城 E'].map((name,i)=>({name,appid:'wx'+i}));
function setup(options={}){
 const dom=new JSDOM(fs.readFileSync(path.join(base,'panel.html'),'utf8'),{runScripts:'outside-only',url:'https://extension.test/panel.html',pretendToBeVisual:true});
 const w=dom.window;if(options.hangStart||options.autoReconnect){const timeout=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>timeout(fn,(options.hangStart&&ms===100000)||(options.autoReconnect&&ms===1500)?20:ms,...args);}
 const listeners=[],calls=[],session={},local={};
 const state={view:{connected:true,current:apps[0],apps,signature:'sig',tabId:8},tabs:[{id:8,title:'小程序',active:true}],history:[]};
 if(options.job)state.view.job=structuredClone(options.job);
 const storage=db=>({get:async k=>({[k]:db[k]}),set:async o=>Object.assign(db,o)});
 w.chrome={windows:{getCurrent:async()=>({id:1})},storage:{session:storage(session),local:storage(local),onChanged:{addListener:fn=>listeners.push(fn)}},runtime:{sendMessage:async m=>{calls.push(m);if(m.type==='STATE'){if(options.autoReconnect&&calls.filter(x=>x.type==='STATE').length===1)return {ok:true,...structuredClone(state),view:{...structuredClone(state.view),connected:false},reconnect:{waiting:true,message:'旧执行器收尾中'}};return {ok:true,...structuredClone(state)};}if(m.type==='START'&&options.hangStart)return new Promise(()=>{});return {ok:true};}}};
 for(const f of ['shared.js','panel.js'])w.eval(fs.readFileSync(path.join(base,f),'utf8'));
 return {dom,w,state,calls,session,listeners,$:id=>w.document.getElementById(id)};
}
const flush=()=>new Promise(r=>setTimeout(r,10));
(async()=>{
 let e=setup();await flush();assert.equal(e.$('appsList').children.length,5);assert.equal(e.$('startBtn').disabled,true);
 e.$('selectAll').click();assert.equal(e.$('selectedCount').textContent,'已选 5 个');assert.equal(e.$('startBtn').disabled,false);
 assert.equal(e.w.document.querySelectorAll('[role="progressbar"]').length,5);
 e.$('description').value='';e.$('orderMode').value='empty';e.$('startBtn').click();await flush();
 let start=e.calls.find(c=>c.type==='START');assert.equal(start.tasks.length,5);assert.ok(start.tasks.every(t=>t.orderPath===''));assert.equal(start.preview,false);
 e.$('search').value='示例商城 C';e.$('search').dispatchEvent(new e.w.Event('input'));assert.equal(e.$('appsList').children.length,1);
 e.$('clearSelection').click();e.$('selectAll').click();assert.equal(e.$('selectedCount').textContent,'已选 1 个');e.dom.window.close();
 const job={id:'job',status:'running',startedAt:new Date().toISOString(),rows:apps.map((a,i)=>({task:{...a,version:'1.2.4'},status:i===0?'success':i===1?'submitting':'waiting',percent:i===0?100:i===1?60:0,updatedAt:new Date().toISOString()}))};
 e=setup({job});await flush();let bars=[...e.w.document.querySelectorAll('[role="progressbar"]')];assert.deepEqual(bars.map(b=>b.getAttribute('aria-valuenow')),['100','60','0','0','0']);assert.equal(e.$('pauseBtn').hidden,false);assert.equal(e.$('startBtn').hidden,true);assert.ok([...e.w.document.querySelectorAll('.row-head input')].every(x=>x.disabled));
 e.$('pauseBtn').click();await flush();assert.ok(e.calls.some(c=>c.type==='PAUSE'));e.dom.window.close();
 const done={...job,status:'completed',rows:job.rows.map((r,i)=>({...r,status:i===0?'success':i===1?'failed':'waiting',message:'模拟错误'}))};
 e=setup({job:done});await flush();assert.equal(e.$('resumeBtn').hidden,false);assert.equal(e.$('retryBtn').hidden,false);e.$('newBatchBtn').click();assert.equal(e.$('startBtn').hidden,false);assert.equal(e.$('batchActions').hidden,true);e.dom.window.close();
 e=setup({hangStart:true});await flush();e.$('selectAll').click();e.$('startBtn').click();await new Promise(r=>setTimeout(r,80));assert.match(e.$('alert').textContent,/操作等待超时/);assert.equal(e.$('refreshBtn').textContent,'刷新列表');assert.equal(e.$('newBatchBtn').disabled,false);e.dom.window.close();
 e=setup({autoReconnect:true});await new Promise(r=>setTimeout(r,90));assert.equal(e.$('connectionTitle').textContent,'已连接公众平台');assert.ok(e.calls.filter(c=>c.type==='STATE').length>=2);assert.ok(!e.calls.some(c=>c.type==='REFRESH'));e.dom.window.close();
 console.log('UI DOM assertions passed: list, selection, search, task parameters, independent 100/60/0/0/0 progress, pause, failed/pending handling, new batch.');
})().catch(e=>{console.error(e);process.exitCode=1;});
