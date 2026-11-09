'use strict';
const $=id=>document.getElementById(id), S=AuditShared;
let windowId, state={view:null,tabs:[],history:[]}, selected=new Set(), signature='', dismissedJobId=null, pending=false;
let pane='tasks', developerOverrides=new Map(), messageSerial=Promise.resolve(), reconnectTimer=null;
const busy=()=>['running','pausing'].includes(state.view?.job?.status);
const shownJob=()=>state.view?.job?.id!==dismissedJobId?state.view?.job:null;
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
function alertMessage(text){$('alert').textContent=text||'';$('alert').hidden=!text;}
async function request(type,extra={}){
  let timer;
  try {
    const timeoutMs=type==='STATE'?15000:100000;
    const r=await Promise.race([
      chrome.runtime.sendMessage({type,windowId,...extra}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('操作等待超时，请查看当前进度；任务可能仍在后台执行，不要重复启动')),timeoutMs);})
    ]);
    if(!r?.ok)throw new Error(r?.error||'扩展连接中断');return r;
  }finally{clearTimeout(timer);}
}
function prefs(){return {version:$('version').value,description:$('description').value,developer:$('developer').value,
  orderMode:$('orderMode').value,orderPath:$('orderPath').value};}
function saveUI(){if(windowId!==undefined)void chrome.storage.session.set({[`ui:${windowId}`]:{selected:[...selected],signature,dismissedJobId}});}
function duration(t){if(!t)return '';const sec=Math.max(0,Math.floor((Date.now()-new Date(t))/1000));return sec<60?`${sec}s`:`${Math.floor(sec/60)}m ${sec%60}s`;}
function appCard(app,index,row){
  const status=row?.status||'waiting',active=!!row&&!S.terminal.has(status)&&status!=='waiting';
  const card=el('article',`app-card ${status}${active?' current':''}`);
  const head=el('div','row-head'),box=el('input');box.type='checkbox';box.id=`app-${index}`;
  box.checked=!!row||selected.has(app.appid);box.disabled=busy()||pending||!!shownJob();
  box.addEventListener('change',()=>{if(box.checked)selected.add(app.appid);else selected.delete(app.appid);saveUI();renderCounts();});
  const label=el('label','',app.name);label.htmlFor=box.id;
  head.append(box,label,el('span','app-version',row?.task.version||''));card.append(head);
  const sub=el('div','row-sub'),stage=el('span',`row-stage ${status}`);
  if(active)stage.append(el('i','spinner'));else if(status==='success')stage.append(el('span','','✓'));
  stage.append(document.createTextNode(S.stageNames[status]||status));
  const percent=row?.percent||0;sub.append(stage,el('span','percent',status==='skipped'?'—':`${percent}%`));card.append(sub);
  const track=el('div','progress-track');track.setAttribute('role','progressbar');track.setAttribute('aria-label',`${app.name}提审步骤进度`);
  track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.setAttribute('aria-valuenow',String(percent));
  track.setAttribute('aria-valuetext',status==='skipped'?'已跳过':`${percent}%，${S.stageNames[status]||status}`);
  const fill=el('div','progress-fill');fill.style.width=`${percent}%`;track.append(fill);card.append(track);
  if(active){const time=el('div','row-time',`本步骤 ${duration(row.updatedAt)}`);time.dataset.since=row.updatedAt;card.append(time);}
  if(['failed','uncertain'].includes(status))card.append(el('p','row-message',row.message));
  if(status==='uncertain')card.append(el('p','row-message','请先到后台核验结果，此项不会自动重发。'));
  if(row?.audit?.auditId)card.append(el('div','receipt',`审核编号 ${row.audit.auditId}${row.audit.submittedAt?' · '+new Date(row.audit.submittedAt).toLocaleString('zh-CN',{hour12:false}):''}`));
  if(row?.developerChoices?.length){const pick=el('select');pick.setAttribute('aria-label',`${app.name}选择开发者`);
    pick.append(new Option('选择开发者后重新检查失败项',''));
    for(const name of row.developerChoices)pick.append(new Option(name,name));
    pick.value=developerOverrides.get(app.appid)||'';pick.addEventListener('change',()=>developerOverrides.set(app.appid,pick.value));card.append(pick);
  }
  return card;
}
function renderCounts(){
  const job=shownJob(),n=S.counts(job);
  $('selectedCount').textContent=job?`本批 ${job.rows.length} 个`:`已选 ${selected.size} 个`;
  $('resultCounts').textContent=job?`成功 ${n.success} / 失败 ${n.failed} / 跳过 ${n.skipped}`:'';
  $('startBtn').textContent=`开始提审${selected.size?' · '+selected.size+' 个':''}`;
  $('startBtn').disabled=pending||busy()||!state.view?.connected||!selected.size||state.activeElsewhere||!!job;
  $('previewBtn').disabled=$('startBtn').disabled;
  $('footerNote').textContent=busy()?'每项独立推进，请勿刷新或手动切换公众平台账号':job?'每条进度条代表一个小程序，不代表微信审核进度':`已选择 ${selected.size} 个小程序 · 顺序处理`;
}
function render(){
  const view=state.view,job=shownJob(),connected=view?.connected;
  $('connectionDot').classList.toggle('online',!!connected);
  $('connectionTitle').textContent=connected?'已连接公众平台':state.reconnect?.waiting?'正在自动重连':'等待连接';
  $('connectionNote').textContent=connected?`连接时的小程序：${view.current.name} · 可管理 ${view.apps.length} 个`:state.reconnect?.message||'请在当前窗口登录公众平台并进入小程序后台，无需刷新页面。';
  const choose=state.tabs.length>1&&!connected;
  $('tabPickerWrap').hidden=!choose;
  const existing=$('tabPicker').value;$('tabPicker').replaceChildren();
  for(const tab of state.tabs)$('tabPicker').append(new Option(`${tab.title}${tab.incognito?' · 无痕':''} · 标签 ${tab.id}`,String(tab.id)));
  if(state.tabs.some(t=>String(t.id)===existing))$('tabPicker').value=existing;
  $('refreshBtn').disabled=pending||busy()||state.activeElsewhere;$('connectBtn').disabled=pending;
  $('refreshBtn').textContent=pending?'处理中…':connected?'刷新列表':'重新连接';
  $('appCount').textContent=job?job.rows.length:(view?.apps?.length||0);
  document.querySelector('.form-section').hidden=!!job;
  for(const id of ['version','description','developer','orderMode','orderPath'])$(id).disabled=busy()||pending;
  $('orderPath').hidden=$('orderMode').value!=='custom';
  $('selectAll').disabled=busy()||pending||!!job;$('clearSelection').disabled=$('selectAll').disabled;
  const query=$('search').value.trim().toLocaleLowerCase();
  const list=job?job.rows.map(r=>({app:{name:r.task.name,appid:r.task.appid},row:r})):(view?.apps||[]).map(app=>({app}));
  const filtered=list.filter(x=>x.app.name.toLocaleLowerCase().includes(query));
  $('appsList').replaceChildren(...filtered.map((x,i)=>appCard(x.app,i,x.row)));
  $('empty').hidden=filtered.length>0;
  if(!filtered.length){$('empty').querySelector('h2').textContent=view?'没有匹配的小程序':'先连接一个小程序';$('empty').querySelector('p').textContent=view?'试试其他名称，或清空搜索条件。':'在当前窗口登录公众平台，进入小程序后台，列表将从账号切换接口自动读取。';}
  $('jobBanner').hidden=!job;
  if(job){const labels={running:job.preview?'正在预检查，不提交审核':'正在串行提审',pausing:'本项完成后暂停，请等待回查结束',paused:'已暂停，未处理项目保留',completed:job.preview?'预检查结束':'本批处理结束',halted:'队列已停止，请检查异常项目',interrupted:connected?(job.rows.some(r=>r.status==='uncertain')?'已重连，待确认项仅回查，请先核验':'已重连，可继续未处理项或重试未提交项'):(job.rows.some(r=>r.status==='uncertain')?'连接中断，提交中的项目请先核验':'正在等待重连，尚未发出的请求没有自动重试')};$('jobBanner').textContent=labels[job.status]||job.status;}
  $('batchActions').hidden=!job||busy();$('resumeBtn').hidden=!job?.rows.some(r=>r.status==='waiting');
  $('retryBtn').hidden=!job?.rows.some(r=>r.status==='failed');
  $('resumeBtn').disabled=pending||!connected;$('retryBtn').disabled=pending||!connected;$('newBatchBtn').disabled=pending;
  $('openCurrentBtn').disabled=pending||!connected;
  $('pauseBtn').hidden=!busy();$('pauseBtn').disabled=pending||job?.status==='pausing';
  $('pauseBtn').textContent=job?.status==='pausing'?'等待当前项结束…':'本项完成后暂停';
  $('startBtn').hidden=busy();$('previewBtn').hidden=busy();
  $('scopeNote').textContent=busy()?'收起侧边栏仍继续；刷新或关闭目标标签页会中断。':'开始提审会真实提交至微信；不会发布上线。';
  $('taskPane').hidden=pane!=='tasks';$('historyPane').hidden=pane!=='history';$('footer').hidden=pane!=='tasks';
  $('tasksTab').classList.toggle('active',pane==='tasks');$('historyTab').classList.toggle('active',pane==='history');
  $('tasksTab').setAttribute('aria-selected',String(pane==='tasks'));$('historyTab').setAttribute('aria-selected',String(pane==='history'));
  renderCounts();renderHistory();
}
function exportJob(job){
  const publicResult={id:job.id,startedAt:job.startedAt,finishedAt:job.finishedAt,status:job.status,preview:job.preview,
    results:job.rows.map(r=>({name:r.task.name,appid:r.task.appid,version:r.task.version,status:r.status,percent:r.percent,message:r.message,audit:r.audit,code:r.code}))};
  const blob=new Blob([JSON.stringify(publicResult,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);
  const a=el('a');a.href=url;a.download=`小程序提审-${job.id.slice(0,8)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function renderHistory(){
  const cards=state.history.map(job=>{
    const n=S.counts(job),card=el('article','history-card');card.append(el('h3','',`${job.preview?'预检查':'提审'} · ${n.total} 个小程序`));
    card.append(el('p','',`${new Date(job.startedAt).toLocaleString('zh-CN',{hour12:false})} · ${job.status}`));
    card.append(el('p','',`成功 ${n.success} · 失败 ${n.failed} · 跳过 ${n.skipped}${job.preview?' · 就绪 '+n.ready:''}`));
    const details=el('details'),summary=el('summary','','查看逐项结果');details.append(summary);
    for(const row of job.rows){const r=el('div','history-row');r.append(el('span','',row.task.name),el('span','',S.stageNames[row.status]||row.status));details.append(r);}
    card.append(details);const btn=el('button','text-button','导出结果');btn.addEventListener('click',()=>exportJob(job));card.append(btn);return card;
  });
  $('historyList').replaceChildren(...cards);if(!cards.length)$('historyList').append(el('div','empty','还没有执行记录'));
}
async function pull(){
  const r=await request('STATE');state=r;
  const next=r.view?`${r.view.documentKey||''}:${r.view.signature||''}`:'';
  if(next&&signature!==next){signature=next;selected.clear();dismissedJobId=null;developerOverrides.clear();saveUI();}
  if(r.view?.job&&['running','pausing'].includes(r.view.job.status))dismissedJobId=null;
  if(r.view?.apps){const ids=new Set(r.view.apps.map(a=>a.appid));selected=new Set([...selected].filter(id=>ids.has(id)));}
  render();
  if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}
  if(r.reconnect?.waiting)reconnectTimer=setTimeout(()=>{
    reconnectTimer=null;
    messageSerial=messageSerial.catch(()=>{}).then(()=>pull()).catch(e=>alertMessage(e.message));
  },1500);
}
async function guarded(fn){pending=true;alertMessage('');render();try{await fn();}catch(e){alertMessage(e.message);}finally{pending=false;render();await pull().catch(e=>alertMessage(e.message));render();}}
async function refresh(tabId){
  const current=state.view?.tabId;
  const active=state.tabs.find(t=>t.active);
  const chosen=tabId||active?.id||(state.tabs.some(t=>t.id===current)?current:null)||(state.tabs.length===1?state.tabs[0].id:null);
  if(!chosen){if(state.tabs.length>1)throw new Error('有多个公众平台页面，请先选择一个连接');throw new Error('未找到已登录的公众平台页面，请打开小程序后台');}
  await request('REFRESH',{tabId:chosen});
}
function newTasks(){
  const p=prefs();return state.view.apps.filter(a=>selected.has(a.appid)).map(a=>({name:a.name,appid:a.appid,version:p.version,
    versionDesc:p.description,developer:p.developer||undefined,
    ...(p.orderMode==='empty'?{orderPath:''}:p.orderMode==='custom'?{orderPath:p.orderPath}:{})}));
}
async function start(preview,tasks){
  const chosen=tasks||newTasks();S.validateTasks(chosen,state.view.apps);
  await chrome.storage.local.set({preferences:prefs()});
  dismissedJobId=null;selected=new Set(chosen.map(t=>t.appid));saveUI();
  await request('START',{tasks:chosen,preview});
}
$('refreshBtn').addEventListener('click',()=>guarded(()=>refresh()));
$('connectBtn').addEventListener('click',()=>guarded(()=>refresh(Number($('tabPicker').value))));
$('search').addEventListener('input',render);
$('selectAll').addEventListener('click',()=>{const q=$('search').value.trim().toLocaleLowerCase();for(const a of state.view?.apps||[])if(a.name.toLocaleLowerCase().includes(q))selected.add(a.appid);saveUI();render();});
$('clearSelection').addEventListener('click',()=>{selected.clear();saveUI();render();});
$('orderMode').addEventListener('change',()=>{$('orderPath').hidden=$('orderMode').value!=='custom';});
$('startBtn').addEventListener('click',()=>guarded(()=>start(false)));
$('previewBtn').addEventListener('click',()=>guarded(()=>start(true)));
$('pauseBtn').addEventListener('click',()=>guarded(()=>request('PAUSE')));
$('newBatchBtn').addEventListener('click',()=>{dismissedJobId=state.view.job.id;saveUI();render();});
$('resumeBtn').addEventListener('click',()=>guarded(()=>start(shownJob().preview,shownJob().rows.filter(r=>r.status==='waiting').map(r=>r.task))));
$('retryBtn').addEventListener('click',()=>guarded(()=>start(shownJob().preview,shownJob().rows.filter(r=>r.status==='failed').map(r=>({...r.task,...(developerOverrides.get(r.task.appid)?{developer:developerOverrides.get(r.task.appid)}:{})})))));
$('exportBtn').addEventListener('click',()=>{if(shownJob())exportJob(shownJob());});
$('openCurrentBtn').addEventListener('click',()=>guarded(()=>request('OPEN_CURRENT')));
$('tasksTab').addEventListener('click',()=>{pane='tasks';render();});$('historyTab').addEventListener('click',()=>{pane='history';render();});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='session'&&(changes[viewKey()]||changes.active)||area==='local'&&changes.history){
    messageSerial=messageSerial.catch(()=>{}).then(()=>pull()).catch(e=>alertMessage(e.message));
  }
});
function viewKey(){return `view:${windowId}`;}
setInterval(()=>{for(const e of document.querySelectorAll('[data-since]'))e.textContent=`本步骤 ${duration(e.dataset.since)}${Date.now()-new Date(e.dataset.since)>12000?' · 正在等待接口响应':''}`;},1000);
(async()=>{
  try{
    windowId=(await chrome.windows.getCurrent()).id;
    const stored=(await chrome.storage.session.get(`ui:${windowId}`))[`ui:${windowId}`];
    if(stored){signature=stored.signature||'';selected=new Set(stored.selected||[]);dismissedJobId=stored.dismissedJobId;}
    const {preferences:p}=await chrome.storage.local.get('preferences');
    if(p)for(const [id,key]of[['version','version'],['description','description'],['developer','developer'],['orderMode','orderMode'],['orderPath','orderPath']])if(p[key]!==undefined)$(id).value=p[key];
    await pull();
    if(!state.view?.connected&&!state.activeElsewhere&&!state.reconnect){const active=state.tabs.find(t=>t.active);if(active||state.tabs.length===1)await guarded(()=>refresh(active?.id));}
  }catch(e){alertMessage(e.message);render();}
})();
