(() => {
  'use strict';
  const stageNames = {
    waiting:'等待处理', switching:'正在切换小程序', reading:'读取版本与提审资料', prepared:'资料已就绪',
    submitting:'正在提交审核', verifying:'提交成功，回查审核状态', checking_uncertain:'响应未确认，正在回查',
    success:'提审成功 · 审核中', skipped:'已跳过 · 正在审核中', failed:'处理失败', uncertain:'待人工核验', ready:'预检查完成'
  };
  const terminal = new Set(['success','skipped','failed','uncertain','ready']);
  const localFailures = new Set(['VERSION_NOT_FOUND','AMBIGUOUS_VERSION','TEST_ACCOUNT_REQUIRED','PRIVACY_NEEDS_INPUT',
    'EXTRA_FLOW_REQUIRED','DESCRIPTION_TOO_LONG','ORDER_PATH_REQUIRED','INVALID_ORDER_PATH']);
  function validPage(url) {
    try { const u=new URL(url); return u.origin==='https://mp.weixin.qq.com' && /^\d+$/.test(u.searchParams.get('token')||''); }
    catch {return false;}
  }
  function signature(apps) {return apps.map(a=>a.appid).sort().join('|');}
  function validateTasks(tasks, apps) {
    if(!Array.isArray(tasks)||!tasks.length||tasks.length>200) throw new Error('请选择 1–200 个小程序');
    const seen=new Set();
    return tasks.map(t=>{
      const match=apps.filter(a=>a.appid===t.appid && a.name===t.name);
      if(match.length!==1||seen.has(t.appid)) throw new Error('目标不存在、名称变化或任务重复，请刷新列表');
      seen.add(t.appid);
      if(typeof t.version!=='string'||!t.version.trim()||t.version.length>64) throw new Error('请填写有效的提交版本号');
      const desc=String(t.versionDesc??'').trim()||'完善功能';
      if(desc.length>200) throw new Error('版本说明超过 200 字');
      const task={appid:t.appid,name:t.name,version:t.version.trim(),versionDesc:desc};
      if(t.developer) task.developer=String(t.developer).trim();
      if(t.orderPath!==undefined) task.orderPath=String(t.orderPath??'').trim();
      return task;
    });
  }
  function createJob(id,tasks,preview=false) {
    return {id,status:'running',preview,startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
      rows:tasks.map(task=>({task,status:'waiting',percent:0,message:'等待处理',updatedAt:new Date().toISOString()}))};
  }
  function progress(row,event) {
    if(terminal.has(row.status)) return;
    if(!Object.hasOwn(stageNames,event.stage)) throw new Error('无效进度阶段');
    row.status=event.stage;
    row.percent=Math.max(row.percent,Math.min(100,Math.max(0,Number(event.percent)||0)));
    row.message=stageNames[event.stage];
    if(event.audit) row.audit=event.audit;
    if(event.checkpoint) row.checkpoint=event.checkpoint;
    row.updatedAt=new Date().toISOString();
  }
  function result(row,res) {
    if(res.status==='SUBMITTED_VERIFIED') {row.status='success';row.percent=100;row.audit=res.audit;}
    else if(res.status==='SKIP_REVIEWING') {row.status='skipped';row.audit=res.audit;row.percent=0;}
    else if(res.status==='READY') {row.status='ready';row.percent=40;}
    else throw new Error('未知任务结果');
    row.message=stageNames[row.status];row.updatedAt=new Date().toISOString();
  }
  function failure(row,e) {
    const uncertain=row.percent>=60||e.code==='SUBMISSION_UNCONFIRMED';
    row.status=uncertain?'uncertain':'failed';row.code=e.code||'ERROR';
    // 引擎的错误文本不含请求 URL 或凭据；未知异常不直接输出。
    row.message=e.code?String(e.message).slice(0,240):'运行环境发生变化，请刷新列表后检查';
    if(Array.isArray(e.choices))row.developerChoices=e.choices.filter(x=>typeof x==='string').slice(0,30);
    row.updatedAt=new Date().toISOString();
    return !uncertain&&localFailures.has(e.code);
  }
  function interrupt(job,message='页面已刷新或关闭，任务已停止；提交中的项目请先核验') {
    if(!job||!['running','pausing'].includes(job.status)) return job;
    const copy=JSON.parse(JSON.stringify(job));copy.status='interrupted';copy.message=message;
    for(const row of copy.rows) if(!terminal.has(row.status)&&row.status!=='waiting') {
      const sent=row.percent>=60;row.status=sent?'uncertain':'failed';row.message=sent?message:'页面连接已中断，本项尚未发送提审请求；重新连接后可重试';row.code='PAGE_INTERRUPTED';
    }
    copy.updatedAt=new Date().toISOString();return copy;
  }
  function counts(job) {
    const rows=job?.rows||[];
    return {total:rows.length,success:rows.filter(r=>r.status==='success').length,
      failed:rows.filter(r=>['failed','uncertain'].includes(r.status)).length,
      skipped:rows.filter(r=>r.status==='skipped').length,ready:rows.filter(r=>r.status==='ready').length};
  }
  globalThis.AuditShared={runtimeVersion:"1.0.2",protocolVersion:2,stageNames,terminal,validPage,signature,validateTasks,createJob,progress,result,failure,interrupt,counts};
})();
