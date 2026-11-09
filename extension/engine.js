/* 微信公众平台接口引擎。运行于扩展的隔离 content-script world。
 * 加载只注册 WechatAudit，不切号、不提交。接口路径来自公众平台网页端请求；微信可能随时调整。
 * 不读取/导出 Cookie；页面 TOKEN 仅在内存。每次提交不自动重试。
 */
(() => {
  'use strict';
  const root = globalThis;
  if (root.location?.origin !== 'https://mp.weixin.qq.com') {
    throw new Error('请在 HTTPS 微信公众平台已登录页面运行');
  }
  if (root.__auditBridgeV2?.version === "1.0.2" && root.__auditBridgeV2.alive()) return;
  // 后台已等待同源任务锁释放；新代执行器不受旧对象的残留 busy 标志影响。
  const epoch = {};
  root.__auditEngineEpochV2 = epoch;
  function assertActive() {
    if (root.__auditEngineEpochV2 !== epoch) throw error('ENGINE_REPLACED', '旧执行器已退出，未继续发送请求');
    if (root.chrome?.runtime) {
      try {
        if (!root.chrome.runtime.id || root.chrome.runtime.getManifest().version !== '1.0.2') throw new Error();
      } catch { throw error('EXTENSION_RELOADED', '扩展已更新，等待自动重连'); }
    }
  }
  const origin = root.location.origin;
  let token = new URL(root.location.href).searchParams.get('token');
  let busy = false;
  let stopRequested = false;
  const results = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const notify = async (options, stage, percent, extra = {}) => {
    assertActive();
    if (options?.onProgress) await options.onProgress({stage, percent, ...extra});
  };
  const error = (code, message) => Object.assign(new Error(message), {code});
  const decode = (value, label) => {
    if (typeof value === 'string') {
      try { return JSON.parse(value); }
      catch { throw error('SCHEMA_CHANGED', `${label} 不是有效 JSON`); }
    }
    if (value && typeof value === 'object') return value;
    throw error('SCHEMA_CHANGED', `${label} 缺失`);
  };
  const isReviewing = b => !!b?.audit_id && Number(b.audit_status) === 1;
  const auditId = b => b?.audit_id ? String(b.audit_id) : null;
  const receipt = b => b ? {
    version: b.version, auditId: b.audit_id, submittedAtEpoch: b.time,
    submittedAt: b.time ? new Date(b.time * 1000).toISOString() : null,
    status: b.status, auditStatus: b.audit_status
  } : null;

  async function request(path, {method = 'GET', query = {}, form} = {}) {
    assertActive();
    if (!token) throw error('LOGIN_REQUIRED', '当前 URL 没有 token，请先进入小程序后台');
    const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/wxamp/cgi/')) {
      throw error('WRONG_ORIGIN', '请求仅允许发送到当前公众平台后台');
    }
    url.searchParams.set('token', token);
    url.searchParams.set('lang', 'zh_CN');
    url.searchParams.set('random', String(Math.random()));
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let data;
    try {
      const response = await fetch(url.href, {
        method, credentials: 'include', cache: 'no-store', redirect: 'error',
        signal: controller.signal,
        ...(form ? {headers: {'Content-Type': 'application/x-www-form-urlencoded'},
          body: new URLSearchParams(form).toString()} : {})
      });
      if (!response.ok) throw error('HTTP_ERROR', `请求 HTTP ${response.status}`);
      try { data = await response.json(); }
      catch { throw error('LOGIN_OR_RESPONSE_CHANGED', '响应不是 JSON，请检查登录状态'); }
    } catch (e) {
      if (e.code) throw e;
      throw error('TRANSPORT_UNCERTAIN', '网络失败或超时；若刚提交，先回查状态，不重复发送');
    } finally { clearTimeout(timer); }
    assertActive();
    if (data.ret !== 0) throw error('API_ERROR', `接口返回 ret=${String(data.ret)}，任务停止`);
    if (data.base_resp?.ret !== undefined && data.base_resp.ret !== 0) {
      throw error('API_ERROR', `接口 base_resp.ret=${data.base_resp.ret}`);
    }
    return data;
  }

  function routePath(path, action, extra = {}) {
    return `${path}?${new URLSearchParams({action, f: 'json', token, lang: 'zh_CN', ...extra})}`;
  }
  const route = path => request('/wxamp/cgi/route', {query: {path}});
  async function identity() {
    const r = await route(routePath('/wxopen/basicprofile', 'index'));
    const i = r.setting_info;
    const name = typeof i?.nickname === 'object' ? i.nickname.nickname : i?.nickname;
    if (!i?.original_appid || !name) throw error('SCHEMA_CHANGED', '账号身份字段缺失');
    return {appid: i.original_appid, name, username: i.original_username};
  }
  async function versions() {
    const r = await route(routePath('/wxopen/wacodepage', 'getcodepage'));
    const data = decode(r.code_data, 'code_data');
    if (!Array.isArray(data.develop_info?.info_list)) throw error('SCHEMA_CHANGED', '开发版本列表缺失');
    return {data, canSubmit: r.can_submit_check};
  }
  async function apps() {
    const r = await request('/wxamp/cgi/getWxaList');
    // 微信实际响应字段拼写为 wax_list。
    if (!Array.isArray(r.wax_list)) throw error('SCHEMA_CHANGED', 'wax_list 缺失');
    return r.wax_list.map(a => ({name: a.app_name, appid: a.appid, username: a.username}));
  }
  async function switchTo(target) {
    const current = await identity();
    if (current.appid === target.appid) return current;
    const r = await request('/wxamp/cgi/switchAccount', {method: 'POST', form: {appid: target.appid}});
    if (!r.token) throw error('SCHEMA_CHANGED', '切号响应没有新 token');
    token = String(r.token);
    // 仅更新地址中的 token，不导航，保留本脚本的内存和串行队列。
    const visible = new URL('/wxamp/wacodepage/getcodepage', origin);
    visible.searchParams.set('token', token);
    visible.searchParams.set('lang', 'zh_CN');
    root.history.replaceState(null, '', visible.href);
    const actual = await identity();
    if (actual.appid !== target.appid || actual.name !== target.name) {
      throw error('IDENTITY_MISMATCH', '切号后账号身份与目标不一致');
    }
    return actual;
  }
  async function privacy(openid) {
    const r = await request('/wxamp/cgi/version/getMpPrivacyMetaMsg', {query: {version_openid: openid}});
    const d = r.data;
    if (!d || d.ret !== 0 || d.success !== true || Number(d.needFill) !== 0 || Number(d.checkRet) !== 0 ||
        ![0, 1].includes(Number(d.ackNoPrivacy))) {
      throw error('PRIVACY_NEEDS_INPUT', '隐私指引需要人工处理，未发送提审');
    }
    return Number(d.ackNoPrivacy);
  }
  async function prepare(task, expected) {
    if (!task.version || !task.name) throw error('INVALID_TASK', '任务必须有 name 和 version');
    const who = await identity();
    if (who.name !== task.name || (expected && who.appid !== expected.appid)) {
      throw error('IDENTITY_MISMATCH', '当前小程序与任务名称/AppID 不一致');
    }
    const {data} = await versions();
    const audit = data.experience_info?.basic_info;
    if (isReviewing(audit)) return {skip: 'SKIP_REVIEWING', who, audit: receipt(audit)};
    // 同版本已上线或保留非审核中的旧记录，都不阻止用户再次提审。
    // allowResubmit 为旧参数，兼容接受但不再作为门槛；最终由微信接口判定。
    const candidates = data.develop_info.info_list.map(x => x.basic_info)
      .filter(x => x?.version === task.version && (!task.developer || x.nick_name === task.developer));
    if (candidates.length === 0) throw error('VERSION_NOT_FOUND', '没有找到指定开发版本');
    if (candidates.length !== 1) throw Object.assign(error('AMBIGUOUS_VERSION', `匹配开发版 ${candidates.length} 个，请选择开发者`), {choices:[...new Set(candidates.map(x=>x.nick_name).filter(Boolean))]});
    const dev = candidates[0];
    if (!dev.open_id) throw error('SCHEMA_CHANGED', '开发版 open_id 缺失');
    const formData = await route(routePath('/wxopen/wadevelopcode', 'get_class', {
      openid: dev.open_id, user_name: dev.nick_name || ''
    }));
    if (formData.code_info?.open_id !== dev.open_id || formData.code_info?.version !== task.version) {
      throw error('VERSION_CHANGED', '审核表单对应的开发版发生变化');
    }
    const cls = decode(formData.class_info, 'class_info');
    const key = decode(formData.public_key_info, 'public_key_info');
    if (Number(formData.need_add_test_account) !== 0 || cls.last_audit_info?.test_account_list?.length) {
      throw error('TEST_ACCOUNT_REQUIRED', '此版本涉及测试账号，需补充专门适配，不复用其他小程序账号');
    }
    if (formData.need_report || cls.scan_info) throw error('EXTRA_FLOW_REQUIRED', '此账号有额外声明或扫码步骤，需要在网页处理');
    if (!Number.isInteger(Number(key.auto_id))) throw error('SCHEMA_CHANGED', 'public_key_info.auto_id 缺失');
    // 版本说明未填、null、空串或仅空白时统一使用默认值，不要求手动补填。
    const description = String(task.versionDesc ?? '').trim() || '完善功能';
    if (description.length > 200) throw error('DESCRIPTION_TOO_LONG', '版本说明 versionDesc 超过 200 字');
    // 省略订单路径时沿用已有值；显式空值保持为空，交由微信接口处理。
    const orderPath = String(task.orderPath === undefined
      ? (formData.online_order_path ?? '') : (task.orderPath ?? '')).trim();
    if (orderPath.includes('?') || orderPath.includes('#')) throw error('INVALID_ORDER_PATH', '订单路径须不含参数');
    const privacyValue = await privacy(dev.open_id);
    return {who, dev, oldAuditId: auditId(audit), privacyValue, body: {
      ticket: 'qrcheckTicket', openid: dev.open_id, auto_id: String(key.auto_id),
      version_desc: description, speedup_audit: '0', speedup_type: cls.speedup_type || '修复漏洞', speedup_desc: '',
      encrypted_username: '', encrypted_password: '', remark: task.remark ?? cls.remark ?? '',
      order_path: orderPath, feedback_info: '', feedback_status: '1', only_run_wxwork: '0', argue_item: '',
      preview_info: JSON.stringify({pic_id_list: [], video_id_list: []}), feedback_stuff: ''
    }};
  }
  async function verify(p, since) {
    for (let n = 0; n < 5; n++) {
      if (n) await sleep(1500);
      const who = await identity();
      if (who.appid !== p.who.appid) throw error('IDENTITY_MISMATCH', '回查时账号被其他窗口切换');
      const {data} = await versions();
      const a = data.experience_info?.basic_info;
      if (isReviewing(a) && a.open_id === p.dev.open_id && a.version === p.dev.version &&
          auditId(a) !== p.oldAuditId && Number(a.time) >= since - 15) return receipt(a);
    }
    throw error('SUBMISSION_UNCONFIRMED', '提交已发送，但未确认新的审核记录；请在页面回查，勿直接重试');
  }
  async function executeOne(task, expected, execute, options = {}) {
    await notify(options, "reading", 20);
    const p = await prepare(task, expected);
    if (p.skip) return {name: task.name, version: task.version, status: p.skip, audit: p.audit};
    await notify(options, 'prepared', 40);
    if (!execute) return {name: task.name, version: task.version, status: 'READY',
      developer: p.dev.nick_name, versionDesc: p.body.version_desc, orderPath: p.body.order_path,
      privacy: p.privacyValue === 0 ? '沿用采集隐私' : '沿用不采集隐私'};
    // 提交前二次核对身份、版本和已有审核状态，防止串号/重复提交。
    const who = await identity();
    if (who.appid !== p.who.appid) throw error('IDENTITY_MISMATCH', '提交前账号发生变化');
    const now = (await versions()).data;
    if (isReviewing(now.experience_info?.basic_info)) return {name: task.name, version: task.version,
      status: 'SKIP_REVIEWING', audit: receipt(now.experience_info.basic_info)};
    const present = now.experience_info?.basic_info;
    // 不拦截稳定的旧记录，但准备到提交之间若审核记录变化，停止本次操作。
    if (auditId(present) !== p.oldAuditId) {
      throw error('AUDIT_CHANGED', '提交前审核记录发生变化');
    }
    if (!now.develop_info.info_list.some(x => x.basic_info?.open_id === p.dev.open_id &&
      x.basic_info.version === p.dev.version && x.basic_info.time === p.dev.time)) {
      throw error('VERSION_CHANGED', '提交前开发包发生变化');
    }
    const update = await request('/wxamp/cgi/version/updatePrivacyCollectMgr', {
      query: {is_not_collect: p.privacyValue, version_openid: p.dev.open_id}
    });
    if (update.data?.retInNode !== 0) throw error('PRIVACY_UPDATE_FAILED', '沿用隐私选项失败，未提交');
    const since = Math.floor(Date.now() / 1000);
    await notify(options, 'submitting', 60, {checkpoint:{previousAuditId:p.oldAuditId,since}});
    let uncertain = false;
    try {
      await request('/wxamp/cgi/route', {method: 'POST',
        query: {path: '/wxopen/wadevelopcode?action=submit_check'}, form: p.body});
    } catch (e) {
      if (!['TRANSPORT_UNCERTAIN', 'HTTP_ERROR', 'LOGIN_OR_RESPONSE_CHANGED'].includes(e.code)) throw e;
      uncertain = true; // 不重发，只查询是否已经生成审核记录。
    }
    await notify(options, uncertain ? 'checking_uncertain' : 'verifying', 80);
    const audit = await verify(p, since);
    await notify(options, 'success', 100, {audit});
    return {name: task.name, version: task.version, status: 'SUBMITTED_VERIFIED', audit,
      ...(uncertain ? {note: '提交响应异常，但回查已确认成功'} : {})};
  }
  async function exclusive(fn) {
    if (busy) throw error('BUSY', '同一页面已有任务运行');
    busy = true; stopRequested = false;
    try {
      if (!root.navigator?.locks) throw error('LOCKS_REQUIRED', '浏览器缺少跨标签锁支持');
      return await root.navigator.locks.request('wechat-audit-serial-v1', {ifAvailable: true}, async lock => {
        if (!lock) throw error('BUSY', '另一个标签页正在提审');
        return fn();
      });
    } finally { busy = false; }
  }
  function record(row) {
    results.push({...row, recordedAt: new Date().toISOString()});
    console.table([row]);
    return row;
  }
  async function current(task, options = {}) {
    return exclusive(async () => {
      try { return record(await executeOne(task, null, options.execute === true, options)); }
      catch (e) { record({name: task?.name, version: task?.version, status: 'STOPPED', code: e.code || 'ERROR', message: e.message}); throw e; }
    });
  }
  async function run(tasks, options = {}) {
    if (!Array.isArray(tasks) || !tasks.length) throw error('INVALID_TASK', '任务列表为空');
    if (new Set(tasks.map(t => t.name)).size !== tasks.length) throw error('DUPLICATE_TASK', '同批每个小程序只允许一条任务');
    return exclusive(async () => {
      const list = await apps();
      const targets = tasks.map(task => {
        const matches = list.filter(a => a.name === task.name && (!task.appid || a.appid === task.appid));
        if (matches.length !== 1) throw error('UNKNOWN_TARGET', `${task.name} 在当前登录账号列表中未唯一匹配`);
        return matches[0];
      });
      const batch = [];
      for (let i = 0; i < tasks.length; i++) {
        if (stopRequested) break;
        try {
          await switchTo(targets[i]);
          batch.push(record(await executeOne(tasks[i], targets[i], options.execute === true, options)));
        } catch (e) {
          batch.push(record({name: tasks[i].name, version: tasks[i].version, status: 'STOPPED', code: e.code || 'ERROR', message: e.message}));
          break; // 包括不确定状态：停止整批，不将旧会话用于下一项。
        }
        if (i + 1 < tasks.length) await sleep(1000);
      }
      return batch;
    });
  }
  root.WechatAudit = Object.freeze({
    version: '1.1.1',
    runtimeVersion: '1.0.2',
    get busy() {return busy;},
    list: () => exclusive(apps),
    inspect: () => exclusive(async () => ({current: await identity(), apps: await apps()})),
    observeAudit: () => exclusive(async () => {
      const who=await identity();
      const {data}=await versions();
      const basic=data.experience_info?.basic_info;
      return {current:who,reviewing:isReviewing(basic),audit:receipt(basic)};
    }),
    process: (task, options = {}) => exclusive(async () => {
      await notify(options, 'switching', 0);
      await switchTo({name: task.name, appid: task.appid});
      return executeOne(task, {appid: task.appid}, options.execute === true, options);
    }),
    current, run,
    stop() {stopRequested = true;},
    results() {return JSON.parse(JSON.stringify(results));},
    openCurrent() {
      if (busy) throw error('BUSY', '任务运行中，请等待结束');
      const u = new URL('/wxamp/wacodepage/getcodepage', origin);
      u.searchParams.set('token', token); u.searchParams.set('lang', 'zh_CN');
      root.location.assign(u.href);
    },
    exportResults() {
      const blob = new Blob([JSON.stringify(results, null, 2)], {type: 'application/json'});
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = 'wechat-audit-results.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });

})();
