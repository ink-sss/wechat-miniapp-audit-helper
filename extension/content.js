(() => {
  'use strict';
  const S=globalThis.AuditShared,engine=globalThis.WechatAudit;
  if(!engine||!S||engine.runtimeVersion!==S.runtimeVersion)return;
  const previous=globalThis.__auditBridgeV2;
  if(previous?.version===S.runtimeVersion&&previous.alive())return;
  previous?.dispose?.();
  const documentKey=crypto.randomUUID(),version=S.runtimeVersion,protocol=S.protocolVersion;
  let job=null,pause=false,running=false,retired=false,inventory=null,publishing=Promise.resolve();
  const snapshot=()=>job?JSON.parse(JSON.stringify(job)):null;
  const alive=()=>{
    try{return !retired&&chrome.runtime.id&&chrome.runtime.getManifest().version===version;}catch{return false;}
  };
  const assertAlive=()=>{if(!alive())throw Object.assign(new Error('扩展已更新，正在等待自动重连'),{code:'EXTENSION_RELOADED'});};
  const publish=()=>{
    assertAlive();job.updatedAt=new Date().toISOString();
    const state=snapshot();
    const next=publishing.catch(()=>{}).then(()=>{
      assertAlive();return chrome.runtime.sendMessage({type:'JOB_UPDATE',protocol,version,documentKey,job:state});
    });
    publishing=next;return next.then(r=>{if(!r?.ok)throw new Error('任务连接已中断');});
  };
  async function inspect(){
    if(running)throw new Error('正在处理任务，请等待当前任务结束');
    inventory=await engine.inspect();
    return {...inventory,signature:S.signature(inventory.apps),documentKey,version,protocol};
  }
  async function start(message){
    if(running||engine.busy)throw new Error('已有任务正在运行');
    if(message.documentKey && message.documentKey!==documentKey)throw new Error('执行器已变化，请等待自动重连');
    if(!inventory||message.signature!==S.signature(inventory.apps))throw new Error('账号列表已变化，请重新读取列表');
    running=true;pause=false;
    try{
      const fresh=await engine.inspect();
      if(S.signature(fresh.apps)!==message.signature)throw new Error('登录账号或小程序列表已变化，请重新读取列表');
      const tasks=S.validateTasks(message.tasks,fresh.apps);
      job=S.createJob(message.batchId,tasks,message.preview===true);
      await publish();void drive();return {job:snapshot(),documentKey};
    }catch(e){running=false;throw e;}
  }
  async function drive(){
    try{
      for(const row of job.rows){
        if(pause)break;
        assertAlive();
        try{
          const r=await engine.process(row.task,{execute:!job.preview,onProgress:async event=>{
            assertAlive();S.progress(row,event);await publish();
          }});
          S.result(row,r);await publish();
        }catch(e){
          const next=S.failure(row,e);await publish();
          if(!next){job.status='halted';job.message='已停止队列，请检查异常项目';break;}
        }
      }
      if(job.status!=='halted')job.status=pause&&job.rows.some(r=>r.status==='waiting')?'paused':'completed';
      job.finishedAt=new Date().toISOString();await publish();
    }catch{
      job=S.interrupt(job,'扩展通信中断，任务停止；请核对当前小程序审核状态');
      try{await publish();}catch{}
    }finally{running=false;}
  }
  // 由后台在隔离 world 直接调用，不注册第二套 runtime.onMessage 监听器。
  // 因此旧版监听器即使残留，也不会抢走新版 PING/START 的响应。
  async function dispatch(m){
    if(m?.protocol!==protocol)return {ok:false,code:'PROTOCOL_MISMATCH',error:'执行器协议不匹配'};
    if(!alive())return {ok:false,code:'CONTEXT_INVALID',error:'旧扩展上下文已失效'};
    try{
      let data;
      switch(m.type){
        case 'PING':data={documentKey,running,job:snapshot(),version,protocol};break;
        case 'INSPECT':data=await inspect();break;
        case 'START':data=await start(m);break;
        case 'OBSERVE_AUDIT':if(running)throw new Error('当前任务仍在执行');data=await engine.observeAudit();break;
        case 'PAUSE':if(!running||!job)throw new Error('当前没有运行中的任务');pause=true;job.status='pausing';await publish();data={job:snapshot()};break;
        case 'OPEN_CURRENT':if(running)throw new Error('任务运行中');engine.openCurrent();data={};break;
        default:throw new Error('未知命令');
      }
      return {ok:true,...data};
    }catch(e){return {ok:false,code:e.code||'ERROR',error:e.code?`${e.code}: ${e.message}`:e.message};}
  }
  globalThis.__auditBridgeV2=Object.freeze({version,protocol,documentKey,alive,dispatch,
    dispose(){retired=true;pause=true;engine.stop();}});
})();
