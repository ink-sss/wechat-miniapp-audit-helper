'use strict';
importScripts('shared.js');
const S=AuditShared;
let chain=Promise.resolve();
const serial=fn=>{const p=chain.catch(()=>{}).then(fn);chain=p;return p;};
const viewKey=id=>`view:${id}`;
const get=async key=>(await chrome.storage.session.get(key))[key];
async function archive(job) {
  const {history=[]}=await chrome.storage.local.get('history');
  await chrome.storage.local.set({history:[job,...history.filter(x=>x.id!==job.id)].slice(0,10)});
}
const reconnectFlights=new Map();
const connectionError=(message,code='RECONNECT_REQUIRED')=>Object.assign(new Error(message),{code});
function healthy(r){return r?.ok && r.version===S.runtimeVersion && r.protocol===S.protocolVersion;}
async function send(tabId,m,timeoutMs=m.type==='PING'?4000:75000){
  let timer;
  try{
    const result=await Promise.race([
      chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',
        func:async message=>{
          const bridge=globalThis.__auditBridgeV2;
          if(!bridge?.dispatch)return {ok:false,code:'BRIDGE_MISSING',error:'网页尚未连接新版执行器'};
          return bridge.dispatch(message);
        },args:[{...m,protocol:S.protocolVersion}]}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(connectionError('页面响应超时，稍后自动重新连接','RECONNECT_WAIT')),timeoutMs);})
    ]);
    const r=result?.find(x=>x.frameId===0)?.result;
    if(!r?.ok)throw connectionError(r?.error||'页面执行器需要重新连接',r?.code);
    return r;
  }finally{clearTimeout(timer);}
}
async function inject(tabId){
  const tab=await chrome.tabs.get(tabId);
  if(!S.validPage(tab.url))throw connectionError('请先登录微信公众平台，进入带 token 的小程序管理页面','LOGIN_REQUIRED');
  try{const r=await send(tabId,{type:'PING'});if(healthy(r))return r;}catch{}
  // 在原标签页检查同源锁。旧执行器有未完成请求时先等待，不并行启动新版。
  const gate=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',
    func:async()=>{
      if(!navigator.locks)return {free:false,unsupported:true};
      return navigator.locks.request('wechat-audit-serial-v1',{ifAvailable:true},lock=>{
        if(!lock)return {free:false};
        globalThis.__auditBridgeV2?.dispose?.();
        // v1.0.x 的残留对象没有 dispose；让旧队列停止进入下一项。
        globalThis.WechatAudit?.stop?.();
        return {free:true};
      });
    }});
  if(!gate?.[0]?.result?.free)throw connectionError('旧执行器仍在结束请求，正在等待自动重连','RECONNECT_WAIT');
  await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},files:['shared.js','engine.js','content.js'],world:'ISOLATED'});
  const r=await send(tabId,{type:'PING'});
  if(!healthy(r))throw connectionError('执行器版本尚未更新，将自动重试');
  return r;
}
async function recoverObservation(tabId,job,current){
  if(!job?.rows.some(r=>r.status==='uncertain'&&r.task?.appid===current.appid))return;
  let observation;
  try{observation=await send(tabId,{type:'OBSERVE_AUDIT'});}catch{return;}
  if(observation.current?.appid!==current.appid)return;
  for(const row of job.rows){
    if(row.status!=='uncertain'||row.task.appid!==current.appid)continue;
    const a=observation.audit,c=row.checkpoint;
    // 仅回查当前账号，不切号、不提交；有提交前检查点才确认是新增审核记录。
    if(observation.reviewing&&a?.version===row.task.version&&c&&a.auditId&&
       String(a.auditId)!==String(c.previousAuditId)&&Number(a.submittedAtEpoch)>=c.since-15){
      row.status='success';row.percent=100;row.audit=a;row.recovered=true;
      row.message='重连后回查确认：已提交，审核中';
    }else{
      row.observedAudit=a||null;
      row.message=observation.reviewing?'只读回查发现审核记录；缺少本次提交的确认依据，未重复发送':'重连后尚未确认本次提交结果，未重复发送，请核验';
    }
    row.updatedAt=new Date().toISOString();
  }
}
async function restoreJob(old,r){
  if(old?.signature===r.signature&&old.job)return S.interrupt(old.job,'执行器已更新，已发出的提审只回查，不自动重发');
  // 扩展重新加载可能清空 storage.session；从本机持久记录恢复，不恢复凭据。
  const {history=[]}=await chrome.storage.local.get('history');
  const ids=new Set(r.apps.map(x=>x.appid));
  const candidate=history.find(j=>['running','pausing','paused','interrupted','halted'].includes(j.status)&&
    j.rows?.length&&j.rows.every(row=>ids.has(row.task?.appid))&&j.rows.some(row=>row.task?.appid===r.current.appid));
  return candidate?S.interrupt(candidate,'已恢复未完成批次；已发出的提审只回查，不自动重发'):null;
}
async function refresh(windowId,tabId){
  const key=`${windowId}:${tabId}`;
  if(reconnectFlights.has(key))return reconnectFlights.get(key);
  const flight=(async()=>{
    const active=await get('active');
    if(active){
      if(active.tabId!==tabId||active.windowId!==windowId)throw new Error('其他标签页有任务正在运行，请等待结束');
      await reconcileTab(tabId);
      if(await get('active'))throw connectionError('当前执行器仍在运行，无需重新连接','RUNNING');
    }
    const tab=await chrome.tabs.get(tabId);if(tab.windowId!==windowId)throw new Error('请选择本窗口的公众平台标签页');
    await inject(tabId);
    const r=await send(tabId,{type:'INSPECT'});
    if(!healthy(r))throw connectionError('网页执行器版本不一致');
    const old=await get(viewKey(windowId));
    const job=await restoreJob(old,r);
    await recoverObservation(tabId,job,r.current);
    const view={tabId,windowId,documentKey:r.documentKey,runtimeVersion:r.version,current:r.current,
      apps:r.apps,signature:r.signature,connected:true,job};
    await serial(async()=>{
      if(await get('active'))throw new Error('任务已开始，请等待完成');
      await chrome.storage.session.set({[viewKey(windowId)]:view});if(job)await archive(job);
    });
    return view;
  })();
  reconnectFlights.set(key,flight);
  try{return await flight;}finally{if(reconnectFlights.get(key)===flight)reconnectFlights.delete(key);}
}
async function receiveUpdate(m,sender) {
  return serial(async()=>{
    const active=await get('active');
    if(m.protocol!==S.protocolVersion||m.version!==S.runtimeVersion||!active||sender.tab.id!==active.tabId||m.documentKey!==active.documentKey||m.job?.id!==active.batchId)return {ok:false};
    const key=viewKey(active.windowId),view=await get(key);
    if(!view||!Array.isArray(m.job.rows))return {ok:false};
    view.job=m.job;active.phase="running";await chrome.storage.session.set({[key]:view,active});await archive(m.job);
    if(!['running','pausing'].includes(m.job.status))await chrome.storage.session.remove('active');
    return {ok:true};
  });
}
async function invalidate(tabId,expected=null) {
  await serial(async()=>{
    const all=await chrome.storage.session.get(null);
    const active=all.active;
    // 避免异步旧探测结果覆盖一个已重新连接或刚开始的新批次。
    if(expected && active?.tabId===tabId &&
      (active.documentKey!==expected.documentKey || active.batchId!==expected.batchId))return;
    for(const [key,view] of Object.entries(all)) {
      if(!key.startsWith('view:')||view.tabId!==tabId)continue;
      if(expected && view.documentKey!==expected.documentKey)continue;
      view.connected=false;
      if(active?.tabId===tabId&&view.job){view.job=S.interrupt(view.job);await archive(view.job);}
      await chrome.storage.session.set({[key]:view});
    }
    if(active?.tabId===tabId)await chrome.storage.session.remove('active');
  });
}
async function begin(m) {
  const batchId=crypto.randomUUID();let view;
  await serial(async()=>{
    if(await get('active'))throw new Error('已有批次运行中，请等待结束');
    view=await get(viewKey(m.windowId));
    if(!view?.connected||view.runtimeVersion!==S.runtimeVersion)throw connectionError('正在连接新版执行器，请稍后再开始');
    const tasks=S.validateTasks(m.tasks,view.apps);
    view.job=S.createJob(batchId,tasks,m.preview===true);
    await chrome.storage.session.set({[viewKey(m.windowId)]:view,active:{tabId:view.tabId,windowId:m.windowId,documentKey:view.documentKey,batchId,phase:"starting",startedAt:Date.now()}});
    await archive(view.job);
  });
  try {
    const ping=await send(view.tabId,{type:'PING'});
    if(!healthy(ping)||ping.documentKey!==view.documentKey)throw connectionError('执行器已变化，将自动重连');
    await send(view.tabId,{type:'START',documentKey:view.documentKey,batchId,signature:view.signature,tasks:view.job.rows.map(r=>r.task),preview:m.preview===true});
    return {batchId};
  }catch(e){
    await serial(async()=>{
      const active=await get('active');if(active?.batchId!==batchId)return;
      const latest=await get(viewKey(m.windowId));
      latest.job=S.interrupt(latest.job,'启动连接中断，请核对状态后刷新列表');latest.connected=false;
      await chrome.storage.session.set({[viewKey(m.windowId)]:latest});await archive(latest.job);await chrome.storage.session.remove('active');
    });throw e;
  }
}
// loading 也可能来自同文档的 history.replaceState，不代表 content script 已消失。
// 以当前文档随机标识与执行器 PING 为准，不根据 URL/token 或 loading 单独终止任务。
async function reconcileTab(tabId,{loading=false}={}) {
  const all=await chrome.storage.session.get(null);
  const active=all.active?.tabId===tabId?all.active:null;
  const view=active?all[viewKey(active.windowId)]:Object.entries(all).find(([k,v])=>k.startsWith('view:')&&v.tabId===tabId&&v.connected)?.[1];
  if(!view)return;
  const expected={documentKey:view.documentKey,batchId:active?.batchId};
  let ping;
  try{ping=await send(tabId,{type:'PING'});}catch{
    // 真实导航加载中的短暂消息断开，等 complete 后再判定；不释放全局队列锁。
    if(loading)return;
    try{const tab=await chrome.tabs.get(tabId);if(tab.status==='loading')return;}catch{}
    await invalidate(tabId,expected);return;
  }
  if(!healthy(ping)||ping.documentKey!==view.documentKey){await invalidate(tabId,expected);return;}
  if(!active)return;
  if(active.phase==='starting' && Date.now()-active.startedAt<=120000)return;
  if(ping.running && ping.job?.id===active.batchId)return;
  if(ping.job?.id===active.batchId && !['running','pausing'].includes(ping.job.status)) {
    await receiveUpdate({protocol:ping.protocol,version:ping.version,documentKey:ping.documentKey,job:ping.job},{tab:{id:tabId}});
    return;
  }
  await invalidate(tabId,expected);
}
async function state(windowId){
  const active=await get('active');
  if(active?.windowId===windowId && (active.phase!=='starting'||Date.now()-active.startedAt>120000))await reconcileTab(active.tabId);
  let view=await get(viewKey(windowId));
  const tabs=(await chrome.tabs.query({windowId,url:'https://mp.weixin.qq.com/*'}))
    .filter(t=>S.validPage(t.url)).map(t=>({id:t.id,title:t.title||'微信公众平台',active:t.active,incognito:t.incognito}));
  let reconnect=null;
  const source=tabs.find(t=>t.id===view?.tabId)||(!view?(tabs.find(t=>t.active)||(tabs.length===1?tabs[0]:null)):null);
  if(source&&(!view?.connected||view.runtimeVersion!==S.runtimeVersion)&&!(await get('active'))){
    try{view=await refresh(windowId,source.id);}
    catch(e){reconnect={waiting:e.code==='RECONNECT_WAIT',message:e.message};}
  }
  const {history=[]}=await chrome.storage.local.get('history');
  const latestActive=await get('active');
  return {view:view||null,tabs,history,reconnect,runtimeVersion:S.runtimeVersion,
    activeElsewhere:!!latestActive&&latestActive.windowId!==windowId};
}
chrome.runtime.onInstalled.addListener(()=>{
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true});
});
chrome.runtime.onStartup.addListener(async()=>{
  const {history=[]}=await chrome.storage.local.get('history');
  await chrome.storage.local.set({history:history.map(x=>S.interrupt(x,'浏览器已重启；提交中的任务请核验，不自动续提'))});
  await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true});
});
chrome.tabs.onRemoved.addListener(tabId=>invalidate(tabId).catch(()=>{}));
chrome.tabs.onUpdated.addListener((tabId,change)=>{
  if(change.status==='loading'||change.status==='complete') {
    return reconcileTab(tabId,{loading:change.status==='loading'}).catch(()=>{});
  }
});
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||!m?.type)return;
  if(m.type==='JOB_UPDATE') {
    if(!sender.tab||sender.frameId!==0||!sender.url?.startsWith('https://mp.weixin.qq.com/'))return;
    receiveUpdate(m,sender).then(reply).catch(()=>reply({ok:false}));return true;
  }
  // 不接受网页或 content script 发来的开始提审指令。
  if(sender.tab||!sender.url?.startsWith(chrome.runtime.getURL('')))return;
  const action=async()=>{
    if(!Number.isInteger(m.windowId))throw new Error('浏览器窗口信息缺失');
    if(m.type==='STATE')return state(m.windowId);
    if(m.type==='REFRESH')return {view:await refresh(m.windowId,m.tabId)};
    if(m.type==='START')return begin(m);
    if(m.type==='PAUSE'){
      const active=await get('active');if(active?.windowId!==m.windowId)throw new Error('本窗口没有运行中的任务');
      return send(active.tabId,{type:'PAUSE'});
    }
    if(m.type==='OPEN_CURRENT'){
      const view=await get(viewKey(m.windowId));if(!view?.connected||await get('active'))throw new Error('请等待任务结束，并确认连接有效');
      return send(view.tabId,{type:'OPEN_CURRENT'});
    }
    throw new Error('未知命令');
  };
  action().then(r=>reply({ok:true,...r})).catch(e=>reply({ok:false,error:e.message||'操作失败'}));
  return true;
});
