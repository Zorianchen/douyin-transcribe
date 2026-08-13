'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const { transcribeDouyin, TEMP_DIR } = require('./pipeline');
const { cleanStale } = require('./clean');
const { AppError, CODES } = require('./errors');
const history = require('./history');
const { processText, ACTIONS } = require('./process');
const configStore = require('./configStore');
const feishu = require('./feishu');
const { testCustom } = require('./aichat');
const asr = require('./asr');
const autogen = require('./autogen');
const users = require('./users');
const auth = require('./auth');
const profiles = require('./profiles');

const app = express();
const PORT = process.env.PORT || 3000;

// 检查当前 ASR provider 的密钥是否已配置（环境变量层面；用户配置层在路由内单独判断）
function hasAsrKey() {
  if (asr.provider === 'tencent') {
    return !!(process.env.TENCENT_APP_ID && process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY);
  }
  // siliconflow（默认）：用户设置中的硅基流动 Key 或环境变量均可
  return !!process.env.SILICONFLOW_API_KEY;
}

// 确保临时目录存在并清理残留
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}
cleanStale(TEMP_DIR);

// 任命系统拥有者（首次启动且无任何拥有者时，注册最早的用户自动成为系统拥有者）
const systemOwner = users.ensureSystemOwner();
// 迁移旧全局 config.json → 系统拥有者配置 + 默认模板（仅一次）
configStore.migrate(systemOwner ? systemOwner.id : null);
// 迁移旧版硅基流动 Key（存于 ai.api_key）→ 独立 siliconflow 模块（仅对旧结构生效）
configStore.migrateSiliconFlow();

// 中间件
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// 静态前端
app.use(express.static(path.join(__dirname, '..', 'public')));

// 健康检查（可选登录：已登录则读当前用户配置，否则读系统拥有者）
app.get('/api/health', auth.attachUser, (req, res) => {
  // 优先用当前登录用户的配置，未登录则 fallback 到系统拥有者
  const uid = req.userId || (systemOwner ? systemOwner.id : 'system');
  const cfg = configStore.get(uid);
  const ai = (cfg && cfg.ai) || {};
  const hasAiConfig = !!(ai.enabled && ai.base_url && ai.api_key && ai.model);
  // ASR 密钥：环境变量优先，否则读当前登录账号配置文件里的 siliconflow.api_key（均不进仓库）
  const hasAsrKeyNow = hasAsrKey() || !!(req.userId && (configStore.get(req.userId).siliconflow || {}).api_key);
  res.json({
    ok: true,
    asr_provider: asr.provider,
    has_asr_key: hasAsrKeyNow,
    has_ai_config: hasAiConfig
  });
});

// ============ 认证：注册 / 登录 / 退出 / 当前用户 ============
// 轻量防暴破：同一 IP 10 分钟内最多 15 次认证尝试
const authAttempts = new Map(); // ip -> { count, resetAt }
function authRateLimit(ip) {
  const now = Date.now();
  const rec = authAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    authAttempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return true;
  }
  rec.count++;
  if (rec.count > 15) return false;
  return true;
}

app.post('/api/auth/register', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!authRateLimit(ip)) {
    return res.status(429).json({ error: { message: '尝试过于频繁，请稍后再试' } });
  }
  const { username, password, email } = req.body || {};
  const wasEmpty = users.count() === 0; // 注册前是否无任何用户（用于游客数据迁移）
  const result = users.create({ username, password, email });
  if (result.error) {
    return res.status(400).json({ error: { message: result.error } });
  }
  // 首位注册用户继承升级前的游客历史数据，保证可追溯、不丢数据
  if (wasEmpty) {
    const n = history.migrateGuestToUser(result.user.id);
    if (n) console.log('[auth] 已迁移游客历史记录', n, '条给首位用户', result.user.username);
  }
  // 自动创建用户默认配置（个人资料、偏好设置、权限角色）
  profiles.createDefaultProfile(result.user.id, result.user.username);
  // 自动初始化该用户的飞书 / AI 配置（继承系统拥有者设定的默认模板）
  configStore.ensureInitialized(result.user.id);
  auth.setAuthCookie(res, result.user.id);
  res.json({ user: result.user });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!authRateLimit(ip)) {
    return res.status(429).json({ error: { message: '尝试过于频繁，请稍后再试' } });
  }
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: { message: '请输入用户名和密码' } });
  }
  const result = users.verify(username, password);
  if (result.error) {
    return res.status(401).json({ error: { message: result.error } });
  }
  // 确保用户资料已初始化（兼容升级前注册的老用户）
  profiles.ensureInitialized(result.user.id, result.user.username);
  auth.setAuthCookie(res, result.user.id);
  res.json({ user: result.user });
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const uid = auth.getCurrentUid(req);
  if (!uid) return res.json({ user: null });
  const u = users.findById(uid);
  if (!u) return res.json({ user: null });
  res.json({ user: users.publicUser(u) });
});

// 修改登录密码
app.put('/api/auth/password', auth.requireAuth, (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!old_password || !new_password) {
    return res.status(400).json({ error: { message: '请填写旧密码和新密码' } });
  }
  const result = users.changePassword(req.userId, old_password, new_password);
  if (result.error) {
    return res.status(400).json({ error: { message: result.error } });
  }
  // 密码修改成功后，清除当前会话强制重新登录
  auth.clearAuthCookie(res);
  res.json({ ok: true, message: '密码已更新，请重新登录' });
});

// ============ 用户资料（个人配置） ============
// 获取当前用户资料
app.get('/api/profile', auth.requireAuth, (req, res) => {
  // 确保已初始化（防御性检查）
  const { profile } = profiles.ensureInitialized(req.userId);
  if (!profile) {
    return res.status(500).json({ error: { message: '无法加载用户资料' } });
  }
  // 不返回敏感内部字段
  const safe = { ...profile };
  delete safe.user_id; // 前端已知当前用户，不重复返回
  res.json(safe);
});

// 更新用户资料（部分更新）
app.put('/api/profile', auth.requireAuth, (req, res) => {
  try {
    const updated = profiles.updateProfile(req.userId, req.body || {});
    const safe = { ...updated };
    delete safe.user_id;
    res.json(safe);
  } catch (e) {
    res.status(400).json({ error: { message: e.message } });
  }
});

// ============ 系统拥有者：用户管理 ============
// 仅系统拥有者可访问；返回所有已注册用户的基本信息（脱敏，不含密码）
app.get('/api/admin/users', auth.requireSystemOwner, (req, res) => {
  const list = users.listAll().map((u) => {
    const p = profiles.getProfile(u.id);
    return {
      id: u.id,
      username: u.username,
      email: u.email || '',
      created_at: u.created_at,
      is_admin: !!u.is_admin,
      display_name: p ? (p.display_name || '') : '',
      role: u.is_admin ? 'owner' : 'user'
    };
  });
  res.json({ users: list, total: list.length });
});

// 系统拥有者：创建新用户（无需走公开注册流程，自动初始化 profile + config）
app.post('/api/admin/users', auth.requireSystemOwner, (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: { message: '用户名和密码不能为空' } });
  }
  // 复用 create 做校验和哈希
  const result = users.create({ username, password, email });
  if (result.error) {
    return res.status(400).json({ error: { message: result.error } });
  }
  // 自动初始化 profile 和 config
  profiles.createDefaultProfile(result.user.id, result.user.username);
  configStore.ensureInitialized(result.user.id);
  res.status(201).json(result.user);
});

// 系统拥有者：删除指定用户（级联清理关联数据）
app.delete('/api/admin/users/:id', auth.requireSystemOwner, (req, res) => {
  if (req.params.id === req.userId) {
    return res.status(400).json({ error: { message: '不能删除自己' } });
  }
  const result = users.remove(req.params.id);
  if (result.error) {
    return res.status(400).json({ error: { message: result.error } });
  }
  // 级联清理：历史记录、个人资料、配置文件
  try { history.clear(req.params.id); } catch (e) { console.warn('[admin] 清理 history 失败:', e.message); }
  try { profiles.deleteProfile(req.params.id); } catch (e) { console.warn('[admin] 清理 profile 失败:', e.message); }
  try { configStore.removeUserConfig(req.params.id); } catch (e) { console.warn('[admin] 清理 config 失败:', e.message); }
  res.json({ ok: true, deleted: result.user });
});

// 脱敏助手：隐藏 app_secret / api_key 明文，返回展示所需字段
function maskConfig(cfg) {
  return {
    feishu: {
      app_id: cfg.feishu.app_id,
      has_secret: !!cfg.feishu.app_secret,
      app_token: cfg.feishu.app_token,
      table_id: cfg.feishu.table_id,
      view_id: cfg.feishu.view_id,
      wiki_token: cfg.feishu.wiki_token,
      raw_url: cfg.feishu.raw_url,
      configured: !!(cfg.feishu.app_id && cfg.feishu.app_secret && cfg.feishu.app_token && cfg.feishu.table_id)
    },
    field_map: cfg.field_map,
    siliconflow: {
      model: cfg.siliconflow.model,
      has_key: !!cfg.siliconflow.api_key
    },
    ai: {
      enabled: cfg.ai.enabled,
      base_url: cfg.ai.base_url,
      model: cfg.ai.model,
      has_key: !!cfg.ai.api_key,
      temperature: cfg.ai.temperature,
      auto_generate: cfg.ai.auto_generate !== false
    }
  };
}

// 系统拥有者：获取默认配置模板（新用户注册时继承）
app.get('/api/admin/config-template', auth.requireSystemOwner, (req, res) => {
  const tpl = configStore.getTemplate();
  res.json(maskConfig(tpl || configStore.defaultConfig()));
});

// 系统拥有者：更新默认配置模板
app.put('/api/admin/config-template', auth.requireSystemOwner, (req, res) => {
  const patch = {};
  if (req.body.feishu) patch.feishu = req.body.feishu;
  if (req.body.siliconflow) patch.siliconflow = req.body.siliconflow;
  if (req.body.ai) patch.ai = req.body.ai;
  if (req.body.field_map) patch.field_map = req.body.field_map;
  configStore.setTemplate(patch);
  res.json({ ok: true });
});

// 系统拥有者：查看某用户的配置（脱敏，只读）
app.get('/api/admin/users/:id/config', auth.requireSystemOwner, (req, res) => {
  const u = users.findById(req.params.id);
  if (!u) return res.status(404).json({ error: { message: '用户不存在' } });
  res.json(Object.assign({ username: u.username }, maskConfig(configStore.get(u.id))));
});

// 系统拥有者：将某用户配置重置为默认模板
app.post('/api/admin/users/:id/config/reset', auth.requireSystemOwner, (req, res) => {
  const u = users.findById(req.params.id);
  if (!u) return res.status(404).json({ error: { message: '用户不存在' } });
  configStore.resetToTemplate(u.id);
  res.json({ ok: true, message: '已将用户配置重置为默认模板' });
});

// 核心接口：提取文字稿
app.post('/api/transcribe', auth.requireAuth, async (req, res) => {
  // 硅基流动 Key：① 服务器 .env 的 SILICONFLOW_API_KEY  ② 当前账号配置 JSON 的 siliconflow.api_key
  // 两种来源都在服务器本地，密钥不进入代码仓库。
  const siliconflowKey = process.env.SILICONFLOW_API_KEY || (req.userId ? ((configStore.get(req.userId).siliconflow || {}).api_key || '') : '');
  if (!siliconflowKey) {
    let hint;
    if (asr.provider === 'tencent') hint = '请在 .env 中配置 TENCENT_APP_ID、TENCENT_SECRET_ID、TENCENT_SECRET_KEY。';
    else hint = '未配置语音识别密钥：请在服务器 .env 添加 SILICONFLOW_API_KEY，或在 data/configs/{userId}.json 的 siliconflow.api_key 填入密钥，然后重启服务。';
    return res.status(500).json({
      error: {
        code: CODES.NO_API_KEY,
        message: '未配置语音识别密钥',
        hint
      }
    });
  }

  const { url } = req.body || {};
  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({
      error: {
        code: CODES.INVALID_LINK,
        message: '请提供抖音链接',
        hint: '请将抖音分享文案或视频链接粘贴到输入框。'
      }
    });
  }

  try {
    const result = await transcribeDouyin(url.trim(), siliconflowKey);
    // 保存到历史记录（不影响主流程，出错不返回给前端）
    try {
      history.add(result, req.userId);
      // 后台自动生成全部 AI 分析模块（异步，不阻塞响应）
      autogen.trigger(result.video_id, configStore.get(req.userId).ai);
    } catch (e) {
      console.error('[history] 保存失败：', e.message);
    }
    res.json(result);
  } catch (e) {
    const err =
      e instanceof AppError
        ? e
        : new AppError(CODES.ASR_ERROR, e.message || '处理失败', '请稍后重试。');
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        hint: err.hint
      }
    });
  }
});

// ---- 历史记录接口 ----
app.get('/api/history', auth.requireAuth, (req, res) => {
  const q = req.query.q;
  res.json({ items: q ? history.search(q, req.userId) : history.list(req.userId) });
});

app.get('/api/history/:id', auth.requireAuth, (req, res) => {
  const item = history.get(req.params.id, req.userId);
  if (!item) return res.status(404).json({ error: { message: '记录不存在' } });
  res.json(item);
});

app.delete('/api/history/:id', auth.requireAuth, (req, res) => {
  const ok = history.remove(req.params.id, req.userId);
  if (!ok) return res.status(404).json({ error: { message: '记录不存在或无权限' } });
  res.json({ ok: true });
});

app.delete('/api/history', auth.requireAuth, (req, res) => {
  history.clear(req.userId);
  res.json({ ok: true });
});

// ---- 智能加工：金句/结构/小红书/公众号/痛点/选题 ----
// 结果可持久化到历史记录（传 persist:true），便于随文案一起上传飞书
app.post('/api/process', auth.requireAuth, async (req, res) => {
  const { action, video_id, persist } = req.body || {};
  if (!action || !ACTIONS[action]) {
    return res.status(400).json({ error: { message: '不支持的加工类型：' + action } });
  }
  let data;
  if (video_id) {
    data = history.get(video_id, req.userId);
    if (!data) return res.status(404).json({ error: { message: '未找到该文字稿记录' } });
  } else if (req.body.data) {
    data = req.body.data;
  } else {
    return res.status(400).json({ error: { message: '缺少要加工的文字稿' } });
  }
  try {
    const out = await processText(action, data, configStore.get(req.userId).ai);
    // 持久化到历史记录的 analysis 字段
    if (persist !== false && video_id) {
      try { history.updateAnalysis(video_id, { [action]: out.result }, req.userId); } catch (e) {}
    }
    res.json(out);
  } catch (e) {
    const status = e.statusCode || 500;
    res.status(status).json({ error: { message: e.message || '加工失败' } });
  }
});

// ---- 批量转写 ----
const batchJobs = new Map(); // id -> { status, items, total, done, failed }

function parseLinksFromText(text) {
  // 复用 douyin.js 的 parseInput；这里简单按行/空白切分后用正则提取
  const re = /https?:\/\/(v\.douyin\.com\/[^\s]+|(?:www\.)?iesdouyin\.com\/share\/(?:video|note)\/\d+[^\s]*|(?:www\.)?douyin\.com\/(?:video|note)\/\d+[^\s]*)/gi;
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push(m[0].replace(/[）)】」』。，、；：！？\s]+$/, ''));
  }
  return [...new Set(found)];
}

app.post('/api/batch', auth.requireAuth, (req, res) => {
  const { urls } = req.body || {};
  let links = [];
  if (Array.isArray(urls)) links = urls;
  else if (typeof urls === 'string') links = parseLinksFromText(urls);

  if (!links.length) {
    return res.status(400).json({ error: { message: '未识别到有效的抖音链接' } });
  }
  if (links.length > 30) {
    return res.status(400).json({ error: { message: '单次最多处理 30 个链接' } });
  }

  const jobId = 'batch_' + Date.now();
  const job = {
    id: jobId,
    status: 'running',
    total: links.length,
    done: 0,
    failed: 0,
    items: links.map((u, i) => ({ index: i, url: u, status: 'pending', result: null, error: null })),
    createdAt: new Date().toISOString()
  };
  batchJobs.set(jobId, job);

  // 异步串行处理（避免并发太高被抖音/Groq 限流）
  (async () => {
    for (const item of job.items) {
      item.status = 'running';
      try {
        const result = await transcribeDouyin(item.url, process.env.SILICONFLOW_API_KEY || (req.userId ? ((configStore.get(req.userId).siliconflow || {}).api_key || '') : ''));
        item.result = result;
        item.status = 'done';
        try { history.add(result, req.userId); autogen.trigger(result.video_id, configStore.get(req.userId).ai); } catch {}
      } catch (e) {
        item.error = (e && e.message) || '处理失败';
        item.status = 'failed';
        job.failed++;
      }
      job.done++;
    }
    job.status = job.failed === job.total ? 'failed' : (job.failed > 0 ? 'partial' : 'done');
    // 保留 1 小时后清理
    setTimeout(() => batchJobs.delete(jobId), 3600000);
  })();

  res.json({ job_id: jobId, total: job.total });
});

app.get('/api/batch/:id', auth.requireAuth, (req, res) => {
  const job = batchJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: { message: '任务不存在或已过期' } });
  res.json({
    id: job.id,
    status: job.status,
    total: job.total,
    done: job.done,
    failed: job.failed,
    items: job.items.map((it) => ({
      index: it.index,
      url: it.url,
      status: it.status,
      error: it.error,
      result: it.status === 'done' ? {
        video_id: it.result.video_id,
        title: it.result.title,
        author: it.result.author,
        duration: it.result.duration,
        source: it.result.source,
        word_count: it.result.word_count
      } : null
    }))
  });
});

// ============ 配置：飞书 + 语音识别（硅基流动）+ AI 模型（按用户隔离） ============
// 获取当前用户的配置（返回密钥明文供表单回填；用户可通过眼睛图标切换显示）
app.get('/api/config', auth.requireAuth, (req, res) => {
  const cfg = configStore.get(req.userId);
  res.json({
    feishu: {
      app_id: cfg.feishu.app_id,
      app_secret: cfg.feishu.app_secret || '',
      app_token: cfg.feishu.app_token,
      table_id: cfg.feishu.table_id,
      view_id: cfg.feishu.view_id,
      wiki_token: cfg.feishu.wiki_token,
      raw_url: cfg.feishu.raw_url,
      configured: !!(cfg.feishu.app_id && cfg.feishu.app_secret && cfg.feishu.app_token && cfg.feishu.table_id)
    },
    field_map: cfg.field_map,
    siliconflow: {
      model: cfg.siliconflow.model
    },
    ai: {
      enabled: cfg.ai.enabled,
      base_url: cfg.ai.base_url,
      api_key: cfg.ai.api_key || '',
      model: cfg.ai.model,
      temperature: cfg.ai.temperature,
      auto_generate: cfg.ai.auto_generate !== false
    },
    actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, v.label]))
  });
});

// 更新当前用户的配置（部分更新）
app.post('/api/config', auth.requireAuth, (req, res) => {
  const patch = {};
  if (req.body.feishu) patch.feishu = req.body.feishu;
  if (req.body.siliconflow) patch.siliconflow = req.body.siliconflow;
  if (req.body.ai) patch.ai = req.body.ai;
  if (req.body.field_map) patch.field_map = req.body.field_map;
  const cfg = configStore.set(req.userId, patch);
  res.json({
    ok: true,
    field_map: cfg.field_map,
    siliconflow: { model: cfg.siliconflow.model },
    ai: { enabled: cfg.ai.enabled, model: cfg.ai.model }
  });
});

// 测试自定义 AI 配置
app.post('/api/config/ai-test', auth.requireAuth, async (req, res) => {
  // 如果请求里带了临时配置，先应用当前用户配置再测试（跳过 undefined 值，避免覆盖已存的 key）
  if (req.body && req.body.ai) {
    const incoming = {};
    for (const [k, v] of Object.entries(req.body.ai)) {
      if (v !== undefined && v !== null && v !== '') incoming[k] = v;
    }
    if (Object.keys(incoming).length) configStore.set(req.userId, { ai: incoming });
  }
  const result = await testCustom(configStore.get(req.userId).ai);
  res.json(result);
});

// ============ 飞书 ============
// 测试连接：用传入的（或已存的）凭证连接表格，返回字段列表
app.post('/api/feishu/connect', auth.requireAuth, async (req, res) => {
  const cfg = configStore.get(req.userId);
  const body = req.body || {};
  const app_id = body.app_id || cfg.feishu.app_id;
  const app_secret = body.app_secret || cfg.feishu.app_secret;
  const url = body.url || cfg.feishu.raw_url;
  const app_token = body.app_token || cfg.feishu.app_token;
  const table_id = body.table_id || cfg.feishu.table_id;
  const view_id = body.view_id || cfg.feishu.view_id;

  if (!app_id || !app_secret) {
    return res.status(400).json({ error: { message: '缺少 app_id 或 app_secret' } });
  }
  try {
    const info = await feishu.connect({ app_id, app_secret, url, app_token, table_id, view_id });
    const token = info._token;
    delete info._token;

    // 连接成功则持久化
    const f = {
      app_id, app_secret,
      app_token: info.app_token,
      table_id: info.table_id,
      view_id: info.view_id,
      wiki_token: info.wiki_token || '',
      raw_url: url || cfg.feishu.raw_url || ''
    };
    configStore.set(req.userId, { feishu: f });

    res.json({ ok: true, ...info });
  } catch (e) {
    res.status(e.statusCode || 500).json({
      error: { message: e.message || '连接失败', feishu_code: e.feishuCode }
    });
  }
});

// 同步字段：根据 field_map 自动创建缺失字段；可选删除指定列
// body: { delete_fields: ['列名1',...] }
app.post('/api/feishu/sync-fields', auth.requireAuth, async (req, res) => {
  const cfg = configStore.get(req.userId);
  const f = cfg.feishu;
  if (!f.app_id || !f.app_token || !f.table_id) {
    return res.status(400).json({ error: { message: '请先连接飞书表格' } });
  }
  try {
    const token = await feishu.getTenantToken(f.app_id, f.app_secret);

    // 先删用户不要的字段
    let deleted = [];
    if (Array.isArray(req.body.delete_fields) && req.body.delete_fields.length) {
      const r = await feishu.removeFieldsByName(f.app_token, f.table_id, token, req.body.delete_fields);
      deleted = r.deleted;
    }

    // 再确保映射字段存在
    const ensured = await feishu.ensureFields(f.app_token, f.table_id, token, cfg.field_map);
    const fields = await feishu.listFields(f.app_token, f.table_id, token);

    res.json({
      ok: true,
      deleted,
      created: ensured.created,
      existing: ensured.existing,
      fields: fields.map((x) => ({ field_id: x.field_id, field_name: x.field_name, type: x.type, is_primary: x.is_primary === true }))
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: { message: e.message || '字段同步失败' } });
  }
});

// 上传一条文案记录到飞书
// body: { video_id, include_analysis: true }
app.post('/api/feishu/upload', auth.requireAuth, async (req, res) => {
  const cfg = configStore.get(req.userId);
  const f = cfg.feishu;
  if (!f.app_id || !f.app_secret || !f.app_token || !f.table_id) {
    return res.status(400).json({ error: { message: '请先连接并配置飞书表格' } });
  }
  const { video_id } = req.body || {};
  if (!video_id) return res.status(400).json({ error: { message: '缺少 video_id' } });

  const record = history.get(video_id, req.userId);
  if (!record) return res.status(404).json({ error: { message: '文案记录不存在' } });

  try {
    const token = await feishu.getTenantToken(f.app_id, f.app_secret);

    // 确保字段存在（容错：用户改过表结构也能自动补）
    const ensured = await feishu.ensureFields(f.app_token, f.table_id, token, cfg.field_map);

    // 收集要上传的 AI 分析结果
    const analysis = req.body.include_analysis === false ? {} : (record.analysis || {});

    const created = await feishu.writeRecord(
      f.app_token, f.table_id, token,
      cfg.field_map, record, analysis
    );

    // 更新飞书上传状态
    const status = {
      uploaded: true,
      record_id: created && created.record_id,
      uploaded_at: new Date().toISOString()
    };
    history.updateFeishu(video_id, status, req.userId);

    res.json({ ok: true, record_id: created && created.record_id, feishu_url: buildFeishuUrl(f, created) });
  } catch (e) {
    history.updateFeishu(video_id, { uploaded: false, error: e.message, at: new Date().toISOString() }, req.userId);
    res.status(e.statusCode || 500).json({ error: { message: e.message || '上传失败' } });
  }
});

// 批量上传文案库记录
// body: { video_ids: [...] }  不传则上传全部
app.post('/api/feishu/batch-upload', auth.requireAuth, async (req, res) => {
  const cfg = configStore.get(req.userId);
  const f = cfg.feishu;
  if (!f.app_id || !f.app_secret || !f.app_token || !f.table_id) {
    return res.status(400).json({ error: { message: '请先连接并配置飞书表格' } });
  }
  const ids = Array.isArray(req.body.video_ids) && req.body.video_ids.length
  ? req.body.video_ids
  : history.list(req.userId).map((it) => it.id);

  const token = await feishu.getTenantToken(f.app_id, f.app_secret);
  await feishu.ensureFields(f.app_token, f.table_id, token, cfg.field_map);

  const results = { success: [], failed: [] };
  for (const id of ids) {
    const record = history.get(id);
    if (!record) { results.failed.push({ id, error: '记录不存在' }); continue; }
    try {
      const created = await feishu.writeRecord(
        f.app_token, f.table_id, token, cfg.field_map,
        record, record.analysis || {}
      );
      history.updateFeishu(id, { uploaded: true, record_id: created.record_id, uploaded_at: new Date().toISOString() });
      results.success.push({ id, record_id: created.record_id });
    } catch (e) {
      history.updateFeishu(id, { uploaded: false, error: e.message, at: new Date().toISOString() });
      results.failed.push({ id, error: e.message });
    }
  }
  res.json({ ok: true, ...results, total: ids.length });
});

function buildFeishuUrl(f, record) {
  if (!f || !f.app_token || !f.table_id) return '';
  let url = 'https://feishu.cn/base/' + f.app_token + '?table=' + f.table_id;
  if (f.view_id) url += '&view=' + f.view_id;
  if (record && record.record_id) url += '&record=' + record.record_id;
  return url;
}

// SPA 回退
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  const labelMap = { tencent: '腾讯云 ASR', siliconflow: '硅基流动' };
  const keyLabel = labelMap[asr.provider] || asr.provider;
  const keyStatus = hasAsrKey() ? '已配置 ✓' : '未配置 ✗';
  console.log(`\n  抖音文字稿服务已启动`);
  console.log(`  ➜  本地:   http://localhost:${PORT}`);
  console.log(`  ➜  ASR:    ${asr.provider} (${keyLabel}: ${keyStatus})\n`);
});

// 长请求保护
server.requestTimeout = 180000;
server.headersTimeout = 185000;
server.keepAliveTimeout = 190000;

// 进程级容错：单个请求的异步异常不应导致整个服务退出
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
