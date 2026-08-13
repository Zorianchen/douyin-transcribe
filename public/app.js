'use strict';

const API_PREFIX = (() => {
  const m = location.pathname.match(/^\/[^/]+/);
  return m && location.pathname !== '/' ? m[0] : '';
})();

// ========== 工具函数 ==========
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
};

const LINK_RE =
  /https?:\/\/(v\.douyin\.com\/[^\s]+|(?:www\.)?iesdouyin\.com\/share\/(?:video|note)\/\d+[^\s]*|(?:www\.)?douyin\.com\/(?:video|note)\/\d+[^\s]*)/gi;

function extractLink(text) {
  LINK_RE.lastIndex = 0;
  const m = LINK_RE.exec(text || '');
  if (!m) return null;
  return m[0].replace(/[）)】」』。，、；：！？\s]+$/, '');
}
function extractLinks(text) {
  LINK_RE.lastIndex = 0;
  const found = [];
  let m;
  while ((m = LINK_RE.exec(text || '')) !== null) {
    found.push(m[0].replace(/[）)】」』。，、；：！？\s]+$/, ''));
  }
  return [...new Set(found)];
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return m + ':' + s;
}
function fmtDuration(sec) {
  sec = Math.floor(Number(sec) || 0);
  if (sec < 60) return sec + ' 秒';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? m + '分' + s + '秒' : m + '分钟';
}
function fmtDate(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yest = new Date(now); yest.setDate(yest.getDate() - 1);
    const isYest = d.toDateString() === yest.toDateString();
    const pad = (n) => String(n).padStart(2, '0');
    if (sameDay) return '今天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (isYest) return '昨天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  } catch (e) { return ''; }
}

const SOURCE_LABELS = {
  subtitle: { text: '官方字幕', cls: 'badge-subtitle' },
  asr: { text: '语音识别', cls: 'badge-asr' },
  note: { text: '图文文案', cls: 'badge-note' }
};

const ERROR_HINTS = {
  INVALID_LINK: '未识别到有效的抖音链接，请粘贴包含 v.douyin.com 或 douyin.com/video 的分享文案。',
  DETAIL_FAILED: '无法获取视频信息，视频可能已删除、设为私密，或被反爬拦截。云服务器部署请在 .env 配置 DOUYIN_COOKIE。',
  NO_AUDIO: '该视频没有可识别的语音内容。',
  AUDIO_FAILED: '音频提取失败，视频可能无音轨或链接已失效，请更换视频重试。',
  AUDIO_TOO_LARGE: '视频过长或音频过大，请换一条更短的视频。',
  NO_API_KEY: '服务器未配置语音识别密钥，请在 .env 中配置 SILICONFLOW_API_KEY。',
  GROQ_AUTH: '语音识别密钥无效，请检查 .env 中的密钥配置。',
  GROQ_RATE_LIMIT: '识别服务繁忙，请稍后再试。',
  GROQ_ERROR: '语音识别失败，请稍后重试。',
  ASR_AUTH: '语音识别密钥无效或余额不足，请检查密钥配置。',
  ASR_RATE_LIMIT: '识别服务繁忙，请稍后再试。',
  ASR_ERROR: '语音识别失败，请稍后重试。',
  TIMEOUT: '处理超时，请稍后重试或更换更短的视频。'
};

let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.classList.add('hidden'), 300);
  }, 2600);
}

// ========== 视图切换 ==========
function switchView(name) {
  // 非系统拥有者不得进入用户管理视图
  if (name === 'admin' && !(currentUser && currentUser.is_admin)) {
    showToast('仅系统拥有者可访问用户管理');
    name = 'single';
  }
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === 'view-' + name);
  });
  if (name === 'library') loadLibrary();
  if (name === 'admin') loadAdminUsers();
  $('sidebar').classList.remove('open');
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
}
document.querySelectorAll('.nav-item').forEach((b) => {
  b.addEventListener('click', () => switchView(b.dataset.view));
});
$('sidebarToggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));

// 根据 URL hash 切换视图（支持 #single #batch #library）
function applyHashRoute() {
  const h = (location.hash || '').replace('#', '');
  if (h === 'batch' || h === 'library') switchView(h);
  else switchView('single');
}
window.addEventListener('hashchange', applyHashRoute);

// ========== 用户系统：登录 / 注册 / 登出 ==========
let currentUser = null;

async function checkAuth() {
  try {
    const res = await fetch(API_PREFIX + '/api/auth/me');
    const data = await res.json();
    currentUser = data.user;
    return data.user;
  } catch (e) {
    currentUser = null;
    return null;
  }
}

function showAuthGate() {
  $('authGate').classList.remove('hidden');
}
function hideAuthGate() {
  $('authGate').classList.add('hidden');
}

function renderUserChip() {
  const avatar = $('userAvatar');
  const name = $('userName');
  if (currentUser) {
    name.textContent = currentUser.username;
    avatar.textContent = (currentUser.username || 'U').trim().charAt(0).toUpperCase();
  } else {
    name.textContent = '未登录';
    avatar.textContent = 'U';
  }
  updateAdminNav();
}

// 仅系统拥有者可见「用户管理」导航
function updateAdminNav() {
  const nav = $('navAdmin');
  if (nav) nav.classList.toggle('hidden', !(currentUser && currentUser.is_admin));
}

// 401 统一处理：会话失效则退回登录门
function guard401(res) {
  if (res && res.status === 401) {
    currentUser = null;
    renderUserChip();
    showAuthGate();
    return true;
  }
  return false;
}

let authMode = 'login'; // 'login' | 'register'
function setupAuthUI() {
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      authMode = tab.dataset.auth;
      document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t === tab));
      const isReg = authMode === 'register';
      $('authEmailLabel').classList.toggle('hidden', !isReg);
      $('authEmail').classList.toggle('hidden', !isReg);
      $('authSubmit').textContent = isReg ? '注册并登录' : '登录';
      $('authError').classList.add('hidden');
    });
  });

  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('authUsername').value.trim();
    const password = $('authPassword').value;
    const email = $('authEmail').value.trim();
    const errEl = $('authError');
    errEl.classList.add('hidden');

    const url = API_PREFIX + (authMode === 'register' ? '/api/auth/register' : '/api/auth/login');
    const btn = $('authSubmit');
    btn.disabled = true;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, email })
      });
      const data = await res.json();
      if (!res.ok) {
        errEl.textContent = (data.error && data.error.message) || '操作失败，请重试';
        errEl.classList.remove('hidden');
        return;
      }
      currentUser = data.user;
      renderUserChip();
      hideAuthGate();
      // 清空链接输入区 + 设置表单，不预填任何内容，由用户自行填写
      $('urlInput').value = '';
      $('batchInput').value = '';
      clearSettingsForm();
      startApp();
    } catch (err) {
      errEl.textContent = '网络异常，请稍后重试';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });

  $('userLogout').addEventListener('click', async () => {
    try {
      await fetch(API_PREFIX + '/api/auth/logout', { method: 'POST' });
    } catch {}
    currentUser = null;
    renderUserChip();
    showAuthGate();
  });
}

// ========== 健康检查 ==========
async function checkHealth() {
  const dot = $('healthDot');
  const txt = $('healthText');
  try {
    const res = await fetch(API_PREFIX + '/api/health');
    const data = await res.json();
    if (data.ok) {
      // 服务正常 = ASR 已配置 + AI 模型已填写
      if (data.has_asr_key && data.has_ai_config) {
        dot.className = 'health ok';
        txt.textContent = '服务正常';
      } else if (!data.has_ai_config) {
        dot.className = 'health idle';
        txt.textContent = '未配置 AI 模型';
      } else {
        dot.className = 'health err';
        txt.textContent = '未配置语音识别';
      }
    } else {
      dot.className = 'health err';
      txt.textContent = '服务异常';
    }
  } catch (e) {
    dot.className = 'health err';
    txt.textContent = '未连接';
  }
}

// ========== 纯净文字稿 / 完整文字稿 ==========
function buildCleanText(d) {
  const paras = [];
  if (Array.isArray(d.segments) && d.segments.length) {
    let buf = '';
    for (const s of d.segments) {
      const t = (s.text || '').trim();
      if (!t) continue;
      buf += t;
      if (/[。！？!?…."」』）)]$/.test(t)) { paras.push(buf); buf = ''; }
    }
    if (buf) paras.push(buf);
  }
  if (!paras.length && Array.isArray(d.segments)) {
    for (const s of d.segments) {
      if (s.text && s.text.trim()) paras.push(s.text.trim());
    }
  }
  return paras.join('\n');
}
function buildFullText(d) {
  const lines = [];
  if (d.title) lines.push(d.title);
  if (d.author) lines.push('作者：@' + d.author);
  if (d.duration) lines.push('时长：' + fmtDuration(d.duration));
  if (d.source && SOURCE_LABELS[d.source]) lines.push('来源：' + SOURCE_LABELS[d.source].text);
  lines.push('');
  if (d.desc && d.desc.trim()) {
    lines.push('【视频简介】');
    lines.push(d.desc.trim());
    lines.push('');
  }
  lines.push('【文字稿】');
  if (Array.isArray(d.segments)) {
    for (const s of d.segments) lines.push('[' + fmtTime(s.start) + '] ' + s.text);
  }
  if (d.word_count) { lines.push(''); lines.push('（共 ' + d.word_count + ' 字）'); }
  return lines.join('\n');
}

// ========== 单条转写 ==========
const singleInput = $('urlInput');
const singleBtn = $('extractBtn');
const singleHint = $('inputHint');

let currentResult = null;
let loadingTimer = null;
const LOADING_STEPS = ['正在解析链接…', '正在获取视频信息…', '正在提取字幕/识别语音…', '正在整理分段…'];

singleInput.addEventListener('input', () => {
  const val = singleInput.value.trim();
  if (!val) {
    singleInput.classList.remove('invalid');
    singleHint.textContent = '支持 v.douyin.com 短链、douyin.com/video 链接，以及整段分享文案（Ctrl+Enter 快速提取）';
    singleHint.style.color = '';
    return;
  }
  const link = extractLink(val);
  if (link) {
    singleInput.classList.remove('invalid');
    singleHint.textContent = '✓ 已识别链接';
    singleHint.style.color = 'var(--success)';
  } else {
    singleInput.classList.add('invalid');
    singleHint.textContent = '✗ 未找到抖音链接';
    singleHint.style.color = 'var(--error)';
  }
});
singleInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doExtract(); }
});
singleBtn.addEventListener('click', doExtract);

function setLoading(on) {
  if (on) {
    singleBtn.classList.add('loading');
    singleBtn.disabled = true;
    $('loadingSection').classList.remove('hidden');
    $('errorSection').classList.add('hidden');
    $('resultSection').classList.add('hidden');
    let step = 0;
    const update = () => {
      $('loadingText').textContent = LOADING_STEPS[step];
      document.querySelectorAll('#view-single .step').forEach((el) => {
        const s = Number(el.dataset.step);
        el.classList.remove('active', 'done');
        if (s < step) el.classList.add('done');
        else if (s === step) el.classList.add('active');
      });
      step = (step + 1) % LOADING_STEPS.length;
    };
    update();
    loadingTimer = setInterval(update, 2500);
  } else {
    singleBtn.classList.remove('loading');
    singleBtn.disabled = false;
    $('loadingSection').classList.add('hidden');
    if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
  }
}

function showError(err) {
  const code = err && err.code ? err.code : 'ASR_ERROR';
  const hint = (err && err.hint) || ERROR_HINTS[code] || '请稍后重试。';
  $('errorTitle').textContent = '提取失败';
  $('errorMessage').textContent = (err && err.message ? err.message + '。' : '') + hint;
  $('errorSection').classList.remove('hidden');
  $('errorSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderResult(data) {
  currentResult = data;
  const src = SOURCE_LABELS[data.source] || SOURCE_LABELS.asr;
  const stats = [];
  if (data.duration) stats.push('⏱ ' + fmtDuration(data.duration));
  if (data.word_count) stats.push('✍️ ' + data.word_count + ' 字');
  if (data.segments && data.segments.length) stats.push('📑 ' + data.segments.length + ' 段');

  let segmentsHtml = '';
  if (data.segments && data.segments.length) {
    segmentsHtml = data.segments.map((s) =>
      '<div class="segment"><div class="segment-time">' + fmtTime(s.start) + '</div><div class="segment-text">' + escapeHtml(s.text) + '</div></div>'
    ).join('');
  } else {
    segmentsHtml = '<div style="color:var(--text-secondary);font-size:14px;padding:12px 0;">暂无文字稿内容</div>';
  }

  const descHtml = data.desc && data.desc.trim()
    ? '<div class="result-desc">' + escapeHtml(data.desc.trim()) + '</div>'
    : '';

  $('resultSection').innerHTML =
    '<div class="result-header">' +
      '<div class="result-title">' + escapeHtml(data.title || '抖音视频文字稿') + '</div>' +
      '<div class="result-author">' + (data.author ? '@' + escapeHtml(data.author) : '') + '</div>' +
      '<div class="result-badges"><span class="badge ' + src.cls + '">' + src.text + '</span></div>' +
    '</div>' +
    '<div class="result-stats">' + stats.map((s) => '<span>' + escapeHtml(s) + '</span>').join('') + '</div>' +
    (descHtml ? '<div class="result-meta">' + descHtml + '</div>' : '') +
    '<div class="ai-bar">' +
      '<div class="ai-bar-label">✨ AI 智能加工</div>' +
      '<button class="ai-chip" data-ai="quotes" type="button">💡 提炼金句</button>' +
      '<button class="ai-chip" data-ai="structure" type="button">🧱 拆解结构</button>' +
      '<button class="ai-chip" data-ai="xiaohongshu" type="button">📕 小红书笔记</button>' +
      '<button class="ai-chip" data-ai="gongzhonghao" type="button">📰 公众号大纲</button>' +
      '<button class="ai-chip ai-chip-report" data-ai="__report" type="button">🚀 一键生成报告</button>' +
    '</div>' +
    renderAnalysisPanel(data) +
    '<div class="segments-header"><span class="segments-title">文字稿</span>' +
      '<span class="segments-count">' + (data.segments && data.segments.length ? '共 ' + data.segments.length + ' 段' : '') + '</span>' +
    '</div>' +
    '<div class="segments-list">' + segmentsHtml + '</div>' +
    '<div class="clean-section"><div class="clean-label">纯净版（可直接复制）</div><div class="clean-text" id="cleanText"></div></div>' +
    '<div class="result-actions">' +
      '<button class="btn btn-primary" id="copyBtn" type="button">📋 复制文字稿</button>' +
      '<button class="btn btn-secondary" id="downloadBtn" type="button">⬇ 下载 TXT</button>' +
      '<button class="btn btn-secondary" id="copyTimeBtn" type="button">🕐 复制（含时间戳）</button>' +
      '<button class="btn btn-secondary" id="uploadFeishuBtn" type="button">☁️ 上传飞书</button>' +
    '</div>';

  const cleanBox = $('cleanText');
  if (cleanBox) cleanBox.textContent = buildCleanText(currentResult);

  $('copyBtn').addEventListener('click', copyFull);
  $('downloadBtn').addEventListener('click', downloadTxt);
  $('copyTimeBtn').addEventListener('click', copyFullWithTime);
  const ufBtn = $('uploadFeishuBtn');
  if (ufBtn) ufBtn.addEventListener('click', () => uploadToFeishu(currentResult.video_id, ufBtn));
  $('resultSection').querySelectorAll('.ai-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const ai = chip.dataset.ai;
      if (ai === '__report') {
        openDrawer(null, currentResult);
        setTimeout(() => generateReport(), 100);
      } else {
        openDrawer(ai, currentResult);
      }
    });
  });

  // 已生成的 AI 成果面板：查看单个模块 / 查看全部 / 打开完整报告（均读存储，不重新生成）
  $('resultSection').querySelectorAll('[data-view]').forEach((b) => {
    b.addEventListener('click', () => viewModuleInDrawer(currentResult, b.dataset.view));
  });
  const vaBtn = $('resultSection').querySelector('[data-viewall]');
  if (vaBtn) vaBtn.addEventListener('click', () => viewAllInDrawer(currentResult));
  const rpBtn = $('resultSection').querySelector('[data-report]');
  if (rpBtn) rpBtn.addEventListener('click', () => openReportInNewTab(currentResult.id));

  $('resultSection').classList.remove('hidden');
  $('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('✓ ' + (msg || '已复制'));
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showToast('✓ ' + (msg || '已复制')); }
    catch (err) { showToast('复制失败，请手动选择'); }
    document.body.removeChild(ta);
  }
}
function copyFull() { if (currentResult) copyText(buildCleanText(currentResult), '已复制文字稿'); }
function copyFullWithTime() { if (currentResult) copyText(buildFullText(currentResult), '已复制（含时间戳）'); }
function downloadTxt() {
  if (!currentResult) return;
  let text = '';
  if (currentResult.desc && currentResult.desc.trim()) text += currentResult.desc.trim() + '\n\n';
  text += buildCleanText(currentResult);
  const blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safe = (currentResult.title || 'douyin').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 40);
  a.download = safe + '_' + (currentResult.video_id || 'transcript') + '.txt';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('✓ 已开始下载');
}

async function doExtract() {
  const raw = singleInput.value.trim();
  if (!raw) { singleInput.focus(); return; }
  const url = extractLink(raw);
  if (!url) { singleInput.classList.add('invalid'); showError({ code: 'INVALID_LINK' }); return; }

  setLoading(true);
  try {
    const res = await fetch(API_PREFIX + '/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (guard401(res)) return;
    if (!res.ok) throw (data && data.error) || { code: 'GROQ_ERROR' };
    renderResult(data);
  } catch (e) {
    if (e && e.code) showError(e);
    else showError({ code: 'GROQ_ERROR', message: '网络异常或服务不可用' });
  } finally {
    setLoading(false);
  }
}
// ========== 批量转写 ==========
const batchInput = $('batchInput');
const batchBtn = $('batchBtn');
const batchHint = $('batchHint');
const batchProgress = $('batchProgress');
const batchList = $('batchList');

let currentBatchId = null;

batchInput.addEventListener('input', () => {
  const links = extractLinks(batchInput.value);
  if (links.length) {
    batchHint.textContent = '已识别 ' + links.length + ' 个链接';
    batchHint.style.color = 'var(--success)';
  } else {
    batchHint.textContent = '将自动识别其中所有抖音链接，单次最多 30 个';
    batchHint.style.color = '';
  }
});
batchBtn.addEventListener('click', startBatch);

async function startBatch() {
  const links = extractLinks(batchInput.value);
  if (!links.length) { showToast('未识别到抖音链接'); return; }
  if (links.length > 30) { showToast('单次最多 30 个链接'); return; }

  batchBtn.disabled = true;
  batchBtn.classList.add('loading');
  batchProgress.classList.remove('hidden');
  batchList.innerHTML = '';

  links.forEach((url, i) => {
    const div = document.createElement('div');
    div.className = 'batch-item status-pending';
    div.dataset.index = i;
    div.innerHTML =
      '<div class="batch-item-status">⏳</div>' +
      '<div class="batch-item-main">' +
        '<div class="batch-item-title">' + escapeHtml(url) + '</div>' +
        '<div class="batch-item-sub">等待中…</div>' +
      '</div>';
    batchList.appendChild(div);
  });

  try {
    const res = await fetch(API_PREFIX + '/api/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: links })
    });
    const data = await res.json();
    if (!res.ok) throw (data && data.error) || new Error('提交失败');
    currentBatchId = data.job_id;
    pollBatch();
  } catch (e) {
    showToast(e.message || '批量提交失败');
    batchBtn.disabled = false;
    batchBtn.classList.remove('loading');
  }
}

async function pollBatch() {
  if (!currentBatchId) return;
  try {
    const res = await fetch(API_PREFIX + '/api/batch/' + currentBatchId);
    const job = await res.json();
    if (!res.ok) throw new Error('查询失败');

    const percent = job.total ? Math.round((job.done / job.total) * 100) : 0;
    batchProgress.innerHTML =
      '<div class="batch-progress-text">' +
        '<span>进度：' + job.done + ' / ' + job.total + '（成功 ' + (job.done - job.failed) + '，失败 ' + job.failed + '）</span>' +
        '<span>' + percent + '%</span>' +
      '</div>' +
      '<div class="batch-progress-bar"><i style="width:' + percent + '%"></i></div>';

    job.items.forEach((it) => {
      const row = batchList.querySelector('.batch-item[data-index="' + it.index + '"]');
      if (!row) return;
      const statusEl = row.querySelector('.batch-item-status');
      const titleEl = row.querySelector('.batch-item-title');
      const subEl = row.querySelector('.batch-item-sub');
      row.classList.remove('status-pending', 'status-running', 'status-done', 'status-failed');
      row.classList.add('status-' + it.status);

      if (it.status === 'pending') {
        statusEl.textContent = '⏳';
        subEl.textContent = '等待中…';
      } else if (it.status === 'running') {
        statusEl.textContent = '🔄';
        subEl.textContent = '处理中…';
      } else if (it.status === 'done') {
        statusEl.textContent = '✅';
        titleEl.textContent = it.result.title || it.url;
        const meta = [];
        if (it.result.author) meta.push('@' + it.result.author);
        if (it.result.duration) meta.push(fmtDuration(it.result.duration));
        if (it.result.word_count) meta.push(it.result.word_count + '字');
        subEl.textContent = meta.join(' · ') || '已完成';
        if (!row.querySelector('.batch-item-action')) {
          const btn = document.createElement('button');
          btn.className = 'batch-item-action';
          btn.type = 'button';
          btn.textContent = '查看';
          btn.addEventListener('click', () => openHistoryByVideoId(it.result.video_id));
          row.appendChild(btn);
        }
      } else if (it.status === 'failed') {
        statusEl.textContent = '❌';
        subEl.textContent = it.error || '处理失败';
      }
    });

    if (job.status === 'running') {
      setTimeout(pollBatch, 2000);
    } else {
      batchBtn.disabled = false;
      batchBtn.classList.remove('loading');
      if (job.status === 'done') showToast('✓ 全部处理完成');
      else if (job.status === 'partial') showToast('部分完成：' + (job.total - job.failed) + ' 成功，' + job.failed + ' 失败');
      else showToast('全部失败，请重试');
    }
  } catch (e) {
    batchBtn.disabled = false;
    batchBtn.classList.remove('loading');
    showToast('查询进度失败');
  }
}

async function openHistoryByVideoId(videoId) {
  try {
    const res = await fetch(API_PREFIX + '/api/history/' + videoId);
    if (!res.ok) throw new Error();
    const data = await res.json();
    switchView('single');
    renderResult(data);
  } catch (e) {
    showToast('记录加载失败');
  }
}

// ========== 文案库 ==========
const librarySearch = $('librarySearch');
const libraryRefresh = $('libraryRefresh');
const libraryClear = $('libraryClear');
const libraryGrid = $('libraryGrid');
const libraryEmpty = $('libraryEmpty');
let searchTimer = null;

librarySearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadLibrary, 300);
});
libraryRefresh.addEventListener('click', loadLibrary);
libraryClear.addEventListener('click', async () => {
  if (!confirm('确定清空全部文案？此操作不可恢复。')) return;
  await fetch(API_PREFIX + '/api/history', { method: 'DELETE' });
  showToast('已清空');
  loadLibrary();
});

async function loadLibrary() {
  const q = librarySearch.value.trim();
  try {
    const res = await fetch(API_PREFIX + '/api/history' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (guard401(res)) return;
    const data = await res.json();
    renderLibrary(data.items || []);
  } catch (e) {
    libraryGrid.innerHTML = '<div style="color:var(--error);padding:20px;">加载失败，请刷新重试</div>';
  }
}

const ANALYSIS_LABELS = {
  quotes: '金句', structure: '结构', pains: '痛点',
  topics: '选题', outline: '大纲', highlights: '亮点', extension: '拓展',
  xiaohongshu: '小红书', gongzhonghao: '公众号'
};

function renderLibrary(items) {
  if (!items.length) {
    libraryGrid.innerHTML = '';
    libraryEmpty.classList.remove('hidden');
    return;
  }
  libraryEmpty.classList.add('hidden');
  libraryGrid.innerHTML = items.map((it) => {
    const src = SOURCE_LABELS[it.source] || SOURCE_LABELS.asr;
    const meta = [];
    if (it.author) meta.push('@' + it.author);
    if (it.duration) meta.push(fmtDuration(it.duration));
    if (it.word_count) meta.push(it.word_count + '字');
    const preview = (it.preview || '').slice(0, 80);

    // AI 分析标记
    let tagsHtml = '';
    if (it.has_analysis) {
      const done = Object.keys(it.has_analysis).filter((k) => it.has_analysis[k]);
      if (done.length) {
        tagsHtml = '<div class="analysis-tags">' +
          done.map((k) => '<span class="analysis-tag">' + escapeHtml(ANALYSIS_LABELS[k] || k) + '</span>').join('') +
          '</div>';
      }
    }

    // 飞书上传状态
    let feishuHtml = '';
    if (it.feishu && it.feishu.uploaded) {
      feishuHtml = '<span class="lib-card-feishu uploaded">☁️ 已上传</span>';
    } else if (it.feishu && it.feishu.uploaded === false && it.feishu.error) {
      feishuHtml = '<span class="lib-card-feishu failed" title="' + escapeHtml(it.feishu.error) + '">⚠️ 上传失败</span>';
    }

    return '<div class="lib-card" data-id="' + escapeHtml(it.id) + '">' +
      '<div class="lib-card-title">' + escapeHtml(it.title || '未命名视频') + '</div>' +
      '<div class="lib-card-meta">' +
        '<span class="badge ' + src.cls + '" style="font-size:10px;padding:1px 6px;">' + src.text + '</span>' +
        meta.map((m) => '<span>' + escapeHtml(m) + '</span>').join('') +
      '</div>' +
      (preview ? '<div class="lib-card-preview">' + escapeHtml(preview) + '</div>' : '') +
      tagsHtml +
      '<div class="lib-card-actions">' +
        '<button class="lib-card-ai" type="button">✨ AI加工</button>' +
        (it.report_ready || (it.has_analysis && (it.has_analysis.outline || it.has_analysis.topics))
          ? '<button class="lib-card-report" type="button">📄 报告</button>'
          : '') +
        '<button class="lib-card-upload" type="button">☁️ 上传飞书</button>' +
      '</div>' +
      '<div class="lib-card-footer">' +
        '<span class="lib-card-date">' + escapeHtml(fmtDate(it.created_at)) + '</span>' +
        feishuHtml +
        '<button class="lib-card-del" title="删除" type="button">×</button>' +
      '</div>' +
    '</div>';
  }).join('');

  libraryGrid.querySelectorAll('.lib-card').forEach((card) => {
    const id = card.dataset.id;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.lib-card-del') || e.target.closest('.lib-card-actions')) return;
      openHistoryItem(id);
    });
    card.querySelector('.lib-card-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('确定删除这条文案？删除后不可恢复。')) return;
      await fetch(API_PREFIX + '/api/history/' + id, { method: 'DELETE' });
      showToast('已删除');
      loadLibrary();
    });
    // AI 加工：先取记录再开抽屉
    card.querySelector('.lib-card-ai').addEventListener('click', async (e) => {
      e.stopPropagation();
      const data = await fetchHistoryItem(id);
      if (data) openDrawer(null, data);
    });
    // 上传飞书
    card.querySelector('.lib-card-upload').addEventListener('click', (e) => {
      e.stopPropagation();
      uploadToFeishu(id, e.currentTarget);
    });
    // 查看报告（新标签页打开 HTML 报告）
    const reportBtn = card.querySelector('.lib-card-report');
    if (reportBtn) {
      reportBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await openReportInNewTab(id);
      });
    }
  });
}

async function fetchHistoryItem(id) {
  try {
    const res = await fetch(API_PREFIX + '/api/history/' + id);
    if (!res.ok) throw new Error();
    return await res.json();
  } catch (e) {
    showToast('记录加载失败');
    return null;
  }
}

async function uploadToFeishu(videoId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '上传中…'; }
  try {
    const res = await fetch(API_PREFIX + '/api/feishu/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: videoId, include_analysis: true })
    });
    const data = await res.json();
    if (guard401(res)) return;
    if (!res.ok) throw (data && data.error) || new Error('上传失败');
    showToast('✓ 已上传到飞书');
    if (btn) btn.textContent = '✓ 已上传';
    loadLibrary();
  } catch (e) {
    showToast('上传失败：' + (e.message || '未知错误'));
    if (btn) { btn.disabled = false; btn.textContent = '☁️ 重试上传'; }
  }
}

// 批量上传全部
$('libraryUploadAll').addEventListener('click', async () => {
  if (!confirm('将文案库全部记录上传到飞书（含已生成的 AI 分析），确定继续？')) return;
  const btn = $('libraryUploadAll');
  btn.disabled = true; btn.textContent = '上传中…';
  try {
    const res = await fetch(API_PREFIX + '/api/feishu/batch-upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json();
    if (!res.ok) throw (data && data.error) || new Error('批量上传失败');
    showToast('完成：成功 ' + data.success.length + ' 条，失败 ' + data.failed.length + ' 条');
    loadLibrary();
  } catch (e) {
    showToast('批量上传失败：' + (e.message || ''));
  } finally {
    btn.disabled = false; btn.textContent = '☁️ 上传全部到飞书';
  }
});

async function openHistoryItem(id) {
  try {
    const res = await fetch(API_PREFIX + '/api/history/' + id);
    if (!res.ok) throw new Error();
    const data = await res.json();
    switchView('single');
    renderResult(data);
  } catch (e) {
    showToast('记录加载失败');
  }
}

// ========== 用户管理（系统拥有者） ==========
async function loadAdminUsers() {
  const body = $('adminTableBody');
  const countEl = $('adminCount');
  if (!currentUser || !currentUser.is_admin) {
    showToast('仅系统拥有者可访问用户管理');
    switchView('single');
    return;
  }
  // 同时加载默认配置模板状态
  loadAdminTemplate();
  body.innerHTML = '<tr><td colspan="6" class="admin-loading">加载中…</td></tr>';
  try {
    const res = await fetch(API_PREFIX + '/api/admin/users');
    if (res.status === 403) {
      body.innerHTML = '<tr><td colspan="6" class="admin-error">无权限：仅系统拥有者可访问</td></tr>';
      countEl.textContent = '访问被拒绝';
      return;
    }
    if (guard401(res)) return;
    const data = await res.json();
    countEl.textContent = '共 ' + data.total + ' 位已注册用户';
    if (!data.users || !data.users.length) {
      body.innerHTML = '<tr><td colspan="6" class="admin-empty">暂无注册用户</td></tr>';
      return;
    }
    body.innerHTML = data.users.map((u) => {
      const roleTag = u.is_admin
        ? '<span class="role-tag admin">系统拥有者</span>'
        : '<span class="role-tag user">成员</span>';
      const adminBadge = u.is_admin ? ' <span class="admin-badge">👑</span>' : '';
      // 系统拥有者不可删除自己
      const isSelf = u.id === (currentUser && currentUser.id);
      const deleteBtn = u.is_admin
        ? ''
        : '<button class="btn-link danger" data-act="delete" data-id="' + escapeHtml(u.id) + '" data-name="' + escapeHtml(u.username) + '" type="button">删除</button>';
      return '<tr>' +
        '<td class="admin-username">' + escapeHtml(u.username) + adminBadge + '</td>' +
        '<td>' + escapeHtml(u.display_name || '-') + '</td>' +
        '<td>' + escapeHtml(u.email || '-') + '</td>' +
        '<td>' + escapeHtml(fmtDateISO(u.created_at)) + '</td>' +
        '<td>' + roleTag + '</td>' +
        '<td class="admin-actions">' +
          '<button class="btn-link" data-act="view" data-id="' + escapeHtml(u.id) + '" type="button">查看配置</button>' +
          (!u.is_admin ? ' <button class="btn-link" data-act="reset" data-id="' + escapeHtml(u.id) + '" type="button">重置为默认</button>' : '') +
          (deleteBtn ? ' ' + deleteBtn : '') +
        '</td>' +
      '</tr>';
    }).join('');
    body.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (btn.dataset.act === 'view') viewUserConfig(id);
        else if (btn.dataset.act === 'reset') resetUserConfig(id);
        else if (btn.dataset.act === 'delete') deleteUser(id, btn.dataset.name);
      });
    });
  } catch (e) {
    body.innerHTML = '<tr><td colspan="6" class="admin-error">加载失败，请刷新重试</td></tr>';
    countEl.textContent = '加载失败';
  }
}

// 系统拥有者：加载默认配置模板状态
async function loadAdminTemplate() {
  const statusEl = $('adminTemplateStatus');
  try {
    const res = await fetch(API_PREFIX + '/api/admin/config-template');
    if (guard401(res)) return;
    if (!res.ok) { statusEl.textContent = '（暂无模板，新用户使用系统默认配置）'; return; }
    const tpl = await res.json();
    const parts = [];
    if (tpl.feishu && tpl.feishu.configured) parts.push('飞书：已连接（' + escapeHtml(tpl.feishu.table_id) + '）');
    else if (tpl.feishu && tpl.feishu.app_id) parts.push('飞书：已填 App ID（未完全连接）');
    else parts.push('飞书：未配置');
    if (tpl.ai && tpl.ai.enabled) parts.push('AI：' + escapeHtml(tpl.ai.model || '自定义模型') + (tpl.ai.has_key ? '' : '（缺 Key）'));
    else parts.push('AI：未启用');
    statusEl.textContent = parts.join('　|　');
  } catch (e) {
    statusEl.textContent = '模板状态加载失败';
  }
}

// 系统拥有者：打开模板编辑弹窗（始终空白，不预填旧密钥）
function openTemplateEditor() {
  // 始终以空白默认状态打开，避免暴露服务器残留的旧密钥
  $('tplFeishuAppId').value = '';
  $('tplFeishuAppSecret').value = '';
  $('tplFeishuUrl').value = '';
  $('tplAiEnabled').checked = false;
  $('tplAiBaseUrl').value = '';
  $('tplAiApiKey').value = '';
  $('tplAiModel').value = '';
  $('tplAiTemp').value = '0.6';
  showModal('templateModal', 'templateMask');
}

// 系统拥有者：保存默认配置模板
async function saveTemplate() {
  const body = {
    feishu: {
      app_id: $('tplFeishuAppId').value.trim(),
      app_secret: $('tplFeishuAppSecret').value === SECRET_PLACEHOLDER ? undefined : $('tplFeishuAppSecret').value.trim(),
      raw_url: $('tplFeishuUrl').value.trim()
    },
    ai: {
      enabled: $('tplAiEnabled').checked,
      base_url: $('tplAiBaseUrl').value.trim(),
      api_key: $('tplAiApiKey').value === SECRET_PLACEHOLDER ? undefined : $('tplAiApiKey').value.trim(),
      model: $('tplAiModel').value.trim(),
      temperature: parseFloat($('tplAiTemp').value) || 0.6
    }
  };
  if (!body.feishu.app_secret) delete body.feishu.app_secret;
  if (!body.ai.api_key) delete body.ai.api_key;
  try {
    const res = await fetch(API_PREFIX + '/api/admin/config-template', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('保存失败');
    showToast('✓ 默认配置模板已更新');
    hideModal('templateModal', 'templateMask');
    loadAdminTemplate();
  } catch (e) {
    showToast('保存失败：' + e.message);
  }
}

// 系统拥有者：查看某用户配置（只读）
let userConfigTargetId = null;
async function viewUserConfig(id) {
  try {
    const res = await fetch(API_PREFIX + '/api/admin/users/' + id + '/config');
    if (guard401(res)) return;
    if (res.status === 403) { showToast('无权限'); return; }
    if (res.status === 404) { showToast('用户不存在'); return; }
    const cfg = await res.json();
    userConfigTargetId = id;
    const feishu = cfg.feishu || {};
    const ai = cfg.ai || {};
    const rows = [];
    rows.push(['飞书 App ID', feishu.app_id || '（空）']);
    rows.push(['飞书连接状态', feishu.configured ? '已连接（' + (feishu.table_id || '') + '）' : '未连接']);
    rows.push(['飞书表格', feishu.table_id || '（空）']);
    rows.push(['AI 模型', ai.enabled ? (ai.model || '自定义') : '未启用']);
    rows.push(['AI API 地址', ai.base_url || '（默认）']);
    rows.push(['AI API Key', ai.has_key ? '已配置' : '（空）']);
    rows.push(['AI 温度', ai.temperature != null ? ai.temperature : 0.6]);
    $('userConfigTitle').textContent = '用户配置 · ' + (cfg.username || '');
    $('userConfigBody').innerHTML = '<div class="config-readonly">' +
      rows.map((r) => '<div class="config-row"><span class="config-key">' + escapeHtml(r[0]) + '</span><span class="config-val">' + escapeHtml(String(r[1])) + '</span></div>').join('') +
      '</div>';
    showModal('userConfigModal', 'userConfigMask');
  } catch (e) {
    showToast('加载用户配置失败');
  }
}

// 系统拥有者：将某用户配置重置为默认模板
async function resetUserConfig(id) {
  if (!confirm('确定将该用户的配置重置为默认模板？此操作不可撤销。')) return;
  try {
    const res = await fetch(API_PREFIX + '/api/admin/users/' + id + '/config/reset', { method: 'POST' });
    if (guard401(res)) return;
    const data = await res.json();
    showToast(data.message || '已重置');
    if (userConfigTargetId === id) hideModal('userConfigModal', 'userConfigMask');
  } catch (e) {
    showToast('重置失败');
  }
}

// ========== 系统拥有者：新增用户 / 删除用户 ==========

// 打开创建用户弹窗（清空表单）
function openCreateUserModal() {
  $('cuUsername').value = '';
  $('cuPassword').value = '';
  $('cuConfirmPwd').value = '';
  $('cuEmail').value = '';
  $('cuStatus').textContent = '';
  $('cuStatus').className = 'form-status';
  showModal('createUserModal', 'createUserMask');
  $('cuUsername').focus();
}

// 提交创建新用户
async function saveNewUser() {
  const username = $('cuUsername').value.trim();
  const password = $('cuPassword').value;
  const confirmPwd = $('cuConfirmPwd').value;
  const email = $('cuEmail').value.trim();
  const statusEl = $('cuStatus');

  // 前端校验
  if (!username) return (statusEl.textContent = '请输入用户名', statusEl.className = 'form-status err');
  if (username.length < 3 || username.length > 20) return (statusEl.textContent = '用户名需 3-20 个字符', statusEl.className = 'form-status err');
  if (!password) return (statusEl.textContent = '请输入密码', statusEl.className = 'form-status err');
  if (password.length < 6) return (statusEl.textContent = '密码至少 6 位', statusEl.className = 'form-status err');
  if (password !== confirmPwd) return (statusEl.textContent = '两次密码不一致', statusEl.className = 'form-status err');

  statusEl.textContent = '创建中…';
  statusEl.className = 'form-status';
  try {
    const res = await fetch(API_PREFIX + '/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, email: email || undefined })
    });
    if (guard401(res)) return;
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = (data.error && data.error.message) || '创建失败';
      statusEl.className = 'form-status err';
      return;
    }
    showToast('✓ 用户「' + username + '」已创建');
    hideModal('createUserModal', 'createUserMask');
    loadAdminUsers(); // 刷新列表
  } catch (e) {
    statusEl.textContent = '网络异常，请稍后重试';
    statusEl.className = 'form-status err';
  }
}

// 删除用户（带确认）
async function deleteUser(id, name) {
  if (!confirm('确定删除用户「' + name + '」？\n\n⚠️ 该操作将同时清除其历史记录、个人资料和配置，且不可撤销！')) return;
  try {
    const res = await fetch(API_PREFIX + '/api/admin/users/' + id, { method: 'DELETE' });
    if (guard401(res)) return;
    const data = await res.json();
    if (!res.ok) {
      showToast((data.error && data.error.message) || '删除失败');
      return;
    }
    showToast('✓ 用户「' + name + '」已删除');
    loadAdminUsers(); // 刷新列表
  } catch (e) {
    showToast('删除失败，请刷新重试');
  }
}

// ========== AI 加工抽屉 ==========

// 构建「已生成的 AI 成果」面板（点击卡片正文后展示，数据来自已持久化的 analysis）
function renderAnalysisPanel(data) {
  const a = data.analysis || {};
  const keys = Object.keys(a).filter((k) => a[k] && !String(a[k]).startsWith('⚠️'));
  if (!keys.length) return '';
  const labelOf = (k) => ALL_MODULES.find((m) => m.key === k) || { label: k, icon: '📝' };
  const reportKeys = REPORT_MODULES.map((m) => m.key).filter((k) => a[k] && !String(a[k]).startsWith('⚠️'));
  const otherKeys = keys.filter((k) => !REPORT_MODULES.find((m) => m.key === k));

  let html = '<div class="ai-results-panel">';
  html += '<div class="ai-results-head"><span>✨ AI 加工成果（' + keys.length + '）</span>' +
          '<button class="ai-results-viewall" data-viewall type="button">查看全部</button></div>';

  if (reportKeys.length) {
    html += '<div class="ai-results-grid">';
    reportKeys.forEach((k) => {
      const m = labelOf(k);
      const preview = String(a[k]).replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 42);
      html += '<div class="ai-result-card">' +
        '<div class="ai-result-card-icon">' + m.icon + '</div>' +
        '<div class="ai-result-card-body">' +
          '<div class="ai-result-card-title">' + m.label + '</div>' +
          '<div class="ai-result-card-preview">' + escapeHtml(preview) + (preview.length >= 42 ? '…' : '') + '</div>' +
        '</div>' +
        '<button class="ai-result-card-btn" data-view="' + k + '" type="button">查看</button>' +
      '</div>';
    });
    html += '</div>';
    html += '<button class="ai-report-full" data-report type="button">📄 查看完整报告</button>';
  }

  if (otherKeys.length) {
    html += '<div class="ai-results-chips">';
    otherKeys.forEach((k) => {
      const m = labelOf(k);
      html += '<button class="ai-result-chip" data-view="' + k + '" type="button">' + m.icon + ' 查看' + m.label + '</button>';
    });
    html += '</div>';
  }
  html += '</div>';
  return html;
}

// 只读查看单个已生成的模块（从存储读取，不重新生成）
function viewModuleInDrawer(data, key) {
  if (!data || !data.analysis || !data.analysis[key]) { showToast('该模块尚未生成'); return; }
  drawerData = data;
  drawerResults = { [key]: data.analysis[key] };
  drawerStatus = { [key]: 'done' };
  reportData = null;
  isGenerating = false;
  drawerMinimized = false;
  if (drawerMini) drawerMini.classList.add('hidden');
  const m = ALL_MODULES.find((mod) => mod.key === key) || { icon: '📝', label: key };
  drawerTitle.textContent = m.icon + ' ' + m.label;
  drawer.classList.remove('hidden');
  drawerMask.classList.remove('hidden');
  renderResultsView([key]);
  drawerFooter.classList.add('hidden');
  aiCopyBtn.classList.remove('hidden');
  setReportBtnsVisible(false);
}

// 只读查看全部已生成的模块
function viewAllInDrawer(data) {
  if (!data || !data.analysis) { showToast('暂无 AI 成果'); return; }
  drawerData = data;
  drawerResults = {};
  drawerStatus = {};
  Object.keys(data.analysis).forEach((k) => {
    if (data.analysis[k] && !String(data.analysis[k]).startsWith('⚠️')) {
      drawerResults[k] = data.analysis[k];
      drawerStatus[k] = 'done';
    }
  });
  if (!Object.keys(drawerResults).length) { showToast('暂无 AI 成果'); return; }
  reportData = null;
  isGenerating = false;
  drawerMinimized = false;
  if (drawerMini) drawerMini.classList.add('hidden');
  drawerTitle.textContent = '✨ AI 加工成果';
  drawer.classList.remove('hidden');
  drawerMask.classList.remove('hidden');
  renderResultsView();
  drawerFooter.classList.add('hidden');
  aiCopyBtn.classList.remove('hidden');
  setReportBtnsVisible(false);
}

const drawer = $('drawer');
const drawerMask = $('drawerMask');
const drawerTitle = $('drawerTitle');
const drawerBody = $('drawerBody');
const drawerFooter = $('drawerFooter');
const drawerClose = $('drawerClose');
const aiCopyBtn = $('aiCopyBtn');

const ACTION_LABELS = {
  quotes: '提炼金句',
  structure: '拆解爆款结构',
  pains: '挖掘痛点',
  topics: '选题建议',
  xiaohongshu: '改写小红书笔记',
  gongzhonghao: '生成公众号大纲',
  outline: '内容大纲',
  highlights: '亮点提炼',
  extension: '内容拓展'
};

// 所有可生成的模块（按分组）
const ALL_MODULES = [
  { key: 'quotes',      label: '提炼金句',    icon: '💡', group: '创作素材' },
  { key: 'structure',   label: '拆解结构',    icon: '🧱', group: '创作素材' },
  { key: 'pains',       label: '挖掘痛点',    icon: '🎯', group: '创作素材' },
  { key: 'topics',      label: '选题建议',    icon: '🔍', group: '创作素材' },
  { key: 'outline',     label: '内容大纲',    icon: '📋', group: '深度分析' },
  { key: 'highlights',  label: '亮点提炼',    icon: '✨', group: '深度分析' },
  { key: 'extension',   label: '内容拓展',    icon: '🔗', group: '深度分析' },
  { key: 'xiaohongshu', label: '小红书笔记',  icon: '📕', group: '多平台改写' },
  { key: 'gongzhonghao',label: '公众号大纲',  icon: '📰', group: '多平台改写' }
];

// 报告专用 5 模块
const REPORT_MODULES = [
  { key: 'outline', label: '内容大纲', icon: '📋' },
  { key: 'topics', label: '选题建议', icon: '💡' },
  { key: 'pains', label: '痛点分析', icon: '🎯' },
  { key: 'highlights', label: '亮点提炼', icon: '✨' },
  { key: 'extension', label: '内容拓展', icon: '🔗' }
];

let drawerData = null;
let drawerResults = {};
let drawerStatus = {};
let reportData = null;
let isGenerating = false;
let drawerMinimized = false;
let currentGenKeys = [];   // 当前正在生成的模块列表
let genDone = 0;           // 已完成数量
let genToken = 0;          // 生成令牌：强制关闭后让旧循环退出
let genMode = null;        // 'modules' | 'report'

// ---- 最小化 / 还原 ----
const drawerMini = $('drawerMini');
const miniText = $('miniText');
const miniSpinner = $('miniSpinner');

function minimizeDrawer() {
  drawer.classList.add('hidden');
  drawerMask.classList.add('hidden');
  drawerMinimized = true;
  updateMiniUI();
  drawerMini.classList.remove('hidden');
}

function restoreDrawer() {
  drawerMinimized = false;
  drawerMini.classList.add('hidden');
  drawer.classList.remove('hidden');
  drawerMask.classList.remove('hidden');
  // 根据当前状态重新渲染
  if (isGenerating && currentGenKeys.length) {
    renderProgressView(currentGenKeys);
    if (genMode === 'report') drawerTitle.textContent = '📄 内容分析报告';
    currentGenKeys.forEach(key => {
      const st = drawerStatus[key];
      if (st === 'loading') updateStepUI(key, 'running');
      else if (st === 'done') updateStepUI(key, 'done');
      else if (st === 'error') updateStepUI(key, 'error');
    });
    updateProgressBar(genDone / Math.max(1, currentGenKeys.length));
  } else if (reportData) {
    renderReport(reportData.results);
  } else if (Object.keys(drawerResults).length) {
    renderResultsView();
  } else {
    renderModuleList();
  }
}

function updateMiniUI() {
  if (!drawerMini) return;
  if (isGenerating) {
    drawerMini.classList.remove('done');
    miniSpinner.style.display = '';
    miniText.textContent = '生成中 ' + genDone + '/' + Math.max(1, currentGenKeys.length) + '，点击还原';
  } else {
    drawerMini.classList.add('done');
    miniSpinner.style.display = 'none';
    miniText.textContent = '✓ 生成完成，点击查看';
  }
}

document.getElementById('drawerMin').addEventListener('click', minimizeDrawer);
drawerMini.addEventListener('click', (e) => {
  if (e.target.id === 'miniClose') return;
  restoreDrawer();
});
document.getElementById('miniClose').addEventListener('click', (e) => {
  e.stopPropagation();
  if (isGenerating) {
    if (!confirm('正在生成中，确定要中止并关闭吗？')) return;
    genToken++; // 让旧循环退出
    isGenerating = false;
    setActionBtnsDisabled(false);
  }
  drawerMinimized = false;
  drawerMini.classList.add('hidden');
  drawerData = null;
  drawerResults = {};
  drawerStatus = {};
  reportData = null;
  currentGenKeys = [];
});

function closeDrawer() {
  if (isGenerating) {
    if (!confirm('正在生成中，可以点"—"最小化后台运行。确定要中止并关闭吗？')) return;
    genToken++; // 中止旧循环
    isGenerating = false;
    setActionBtnsDisabled(false);
  }
  drawer.classList.add('hidden');
  drawerMask.classList.add('hidden');
  if (drawerMini) drawerMini.classList.add('hidden');
  drawerMinimized = false;
  drawerData = null;
  drawerResults = {};
  drawerStatus = {};
  reportData = null;
  currentGenKeys = [];
}
drawerClose.addEventListener('click', closeDrawer);
drawerMask.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !drawer.classList.contains('hidden')) closeDrawer();
});

function statusIcon(key) {
  const s = drawerStatus[key];
  if (s === 'loading') return '<div class="step-spinner"></div>';
  if (s === 'done') return '<span class="mod-done">✓</span>';
  if (s === 'error') return '<span class="mod-error">!</span>';
  return '<span class="mod-pending">○</span>';
}

function renderModuleList() {
  const groups = {};
  ALL_MODULES.forEach(m => {
    if (!groups[m.group]) groups[m.group] = [];
    groups[m.group].push(m);
  });

  let html = '<div class="module-list">';
  for (const [group, mods] of Object.entries(groups)) {
    html += '<div class="module-group"><div class="module-group-title">' + group + '</div>';
    mods.forEach(m => {
      const st = drawerStatus[m.key] || 'pending';
      const hasResult = drawerResults[m.key] && !drawerResults[m.key].startsWith('⚠️');
      html += '<div class="module-card module-' + st + '" data-module="' + m.key + '">';
      html += '<label class="module-check" onclick="event.stopPropagation()">';
      html += '<input type="checkbox" data-check="' + m.key + '"';
      if (st === 'loading') html += ' disabled';
      html += '><span class="checkmark"></span></label>';
      html += '<div class="module-info" data-action="' + m.key + '">';
      html += '<span class="module-icon">' + statusIcon(m.key) + '</span>';
      html += '<span class="module-label">' + m.icon + ' ' + m.label + '</span>';
      if (hasResult) html += '<span class="module-badge">已生成</span>';
      html += '</div></div>';
    });
    html += '</div>';
  }
  html += '</div>';
  drawerBody.innerHTML = html;

  drawerBody.querySelectorAll('.module-info').forEach(el => {
    el.addEventListener('click', () => {
      if (isGenerating) return;
      generateModules([el.dataset.action]);
    });
  });
  drawerBody.querySelectorAll('input[data-check]').forEach(cb => {
    cb.addEventListener('change', updateSelectedBtn);
  });
  updateSelectedBtn();
}

function updateSelectedBtn() {
  const checked = drawerBody.querySelectorAll('input[data-check]:checked:not(:disabled)');
  const btn = document.getElementById('btnGenSelected');
  if (btn) {
    btn.disabled = checked.length === 0 || isGenerating;
    btn.innerHTML = checked.length > 0
      ? '<span>✅</span> 生成选中(' + checked.length + ')'
      : '<span>✅</span> 生成选中';
  }
}

function openDrawer(action, data) {
  if (!data || !data.video_id) {
    showToast('暂无可加工的文字稿');
    return;
  }
  if (isGenerating) {
    if (!confirm('上一个生成任务还在进行中，切换将中止它。继续吗？')) return;
    genToken++;
    isGenerating = false;
    setActionBtnsDisabled(false);
  }
  drawerData = data;
  drawerResults = {};
  drawerStatus = {};
  reportData = null;
  isGenerating = false;
  drawerMinimized = false;
  currentGenKeys = [];
  if (drawerMini) drawerMini.classList.add('hidden');

  drawerTitle.textContent = '✨ AI 智能加工';
  drawerFooter.classList.add('hidden');
  drawer.classList.remove('hidden');
  drawerMask.classList.remove('hidden');

  // 预填已持久化的 analysis
  if (data.analysis) {
    for (const [key, val] of Object.entries(data.analysis)) {
      if (val && ALL_MODULES.find(m => m.key === key)) {
        drawerResults[key] = val;
        drawerStatus[key] = 'done';
      }
    }
  }

  if (action && action !== '__report') {
    renderModuleList();
    setTimeout(() => generateModules([action]), 150);
  } else {
    renderModuleList();
  }
}

// ---- 顶部按钮 ----
const btnGenAll = document.getElementById('btnGenAll');
if (btnGenAll) {
  btnGenAll.addEventListener('click', () => {
    if (!drawerData || isGenerating) return;
    generateModules(ALL_MODULES.map(m => m.key));
  });
}

const btnGenSelected = document.getElementById('btnGenSelected');
if (btnGenSelected) {
  btnGenSelected.addEventListener('click', () => {
    if (!drawerData || isGenerating) return;
    const keys = Array.from(drawerBody.querySelectorAll('input[data-check]:checked'))
      .map(cb => cb.dataset.check);
    if (keys.length) generateModules(keys);
  });
}

// AI 生成失败的友好提示：识别配置类错误并引导去设置
function friendlyGenError(e) {
  const msg = (e && e.message) || '未知错误';
  if (/密钥|api.?key|未配置|unauthorized|401|鉴权/i.test(msg)) {
    return '生成失败：' + msg + '（请在 ⚙️ 设置 → AI 模型 中检查配置）';
  }
  if (/超时|timeout/i.test(msg)) {
    return '生成失败：AI 响应超时，请稍后重试';
  }
  return '生成失败：' + msg;
}

// ---- 通用串行生成 ----
async function generateModules(keys) {
  if (!drawerData || isGenerating || keys.length === 0) return;
  isGenerating = true;
  currentGenKeys = keys.slice();
  genDone = 0;
  genMode = 'modules';
  const myToken = ++genToken;
  setActionBtnsDisabled(true);
  drawerFooter.classList.add('hidden');
  aiCopyBtn.classList.remove('hidden');
  setReportBtnsVisible(false);

  renderProgressView(keys);

  for (let i = 0; i < keys.length; i++) {
    if (myToken !== genToken) return; // 已被中止
    const key = keys[i];
    drawerStatus[key] = 'loading';
    updateStepUI(key, 'running');
    updateProgressBar(i / keys.length);

    try {
      const res = await fetch(API_PREFIX + '/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: key, video_id: drawerData.video_id, persist: true })
      });
      const data = await res.json();
      if (!res.ok) throw (data && data.error) || new Error('生成失败');
      drawerResults[key] = data.result || '';
      drawerStatus[key] = 'done';
      updateStepUI(key, 'done');
    } catch (e) {
      drawerResults[key] = '⚠️ ' + friendlyGenError(e);
      drawerStatus[key] = 'error';
      updateStepUI(key, 'error');
    }
    genDone++;
    updateProgressBar(genDone / keys.length);
    if (drawerMinimized) updateMiniUI();
  }

  if (myToken !== genToken) return; // 已被中止
  isGenerating = false;
  setActionBtnsDisabled(false);

  if (drawerMinimized) {
    updateMiniUI();
    showToast('✓ AI 生成完成，点击右下角胶囊查看');
  } else {
    renderResultsView(keys);
  }

  if (document.getElementById('view-library').classList.contains('active')) {
    loadLibrary();
  }
}

function renderProgressView(keys) {
  drawerTitle.textContent = keys.length > 1
    ? '⏳ AI 正在生成 ' + keys.length + ' 个模块…'
    : '⏳ ' + (ACTION_LABELS[keys[0]] || 'AI 生成中') + '…';
  const stepsHtml = keys.map((key, i) => {
    const m = ALL_MODULES.find(mod => mod.key === key) || { icon: '📝', label: key };
    return '<div class="report-step" data-step="' + key + '">' +
      '<div class="step-icon" id="step-icon-' + key + '">' + (i + 1) + '</div>' +
      '<span>' + m.icon + ' ' + m.label + '</span></div>';
  }).join('');
  drawerBody.innerHTML =
    '<div class="report-progress">' +
      '<div class="report-progress-bar"><div id="reportBar" style="width:0%"></div></div>' +
      stepsHtml +
    '</div>';
}

function updateStepUI(key, state) {
  const stepEl = drawerBody.querySelector('[data-step="' + key + '"]');
  const iconEl = document.getElementById('step-icon-' + key);
  if (!stepEl || !iconEl) return;
  stepEl.classList.remove('running', 'done', 'error');
  stepEl.classList.add(state);
  if (state === 'running') iconEl.innerHTML = '<div class="step-spinner"></div>';
  else if (state === 'done') iconEl.textContent = '✓';
  else if (state === 'error') iconEl.textContent = '!';
}

function updateProgressBar(pct) {
  const bar = document.getElementById('reportBar');
  if (bar) bar.style.width = (pct * 100) + '%';
}

function setActionBtnsDisabled(disabled) {
  drawer.querySelectorAll('.drawer-actions .ai-btn').forEach(b => { b.disabled = disabled; });
  if (!disabled) updateSelectedBtn();
}

// ---- 结果展示：折叠卡片 ----
function renderResultsView(keys) {
  const doneKeys = Object.keys(drawerResults).filter(k => drawerResults[k]);
  if (doneKeys.length === 0) {
    drawerTitle.textContent = '✨ AI 智能加工';
    drawerBody.innerHTML = '<div class="drawer-placeholder" style="color:var(--error);">所有模块生成失败，请稍后重试</div>';
    return;
  }

  drawerTitle.textContent = '✨ AI 智能加工（' + doneKeys.length + ' 个模块）';
  let html = '<div class="report-results">';
  doneKeys.forEach(key => {
    const m = ALL_MODULES.find(mod => mod.key === key) || { icon: '📝', label: key };
    const content = drawerResults[key];
    const isError = content.startsWith('⚠️');
    html += '<div class="result-card' + (isError ? ' result-error' : '') + '" data-result="' + key + '">';
    html += '<div class="result-card-header">';
    html += '<span class="result-card-icon">' + m.icon + '</span>';
    html += '<span class="result-card-title">' + m.label + '</span>';
    if (!isError) html += '<button class="result-copy-btn" data-copy="' + key + '" type="button" title="复制">📋</button>';
    html += '<button class="result-toggle" type="button">▾</button>';
    html += '</div>';
    html += '<div class="result-card-body">' +
      (isError ? '<div style="color:var(--error)">' + escapeHtml(content) + '</div>' : renderMarkdownLite(content)) +
      '</div></div>';
  });
  html += '</div>';
  drawerBody.innerHTML = html;

  drawerBody.querySelectorAll('.result-card-header').forEach(h => {
    h.addEventListener('click', (e) => {
      if (e.target.classList.contains('result-copy-btn')) return;
      h.parentElement.classList.toggle('collapsed');
    });
  });
  drawerBody.querySelectorAll('.result-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.copy;
      if (drawerResults[key]) copyText(drawerResults[key], '已复制');
    });
  });

  drawerFooter.classList.remove('hidden');
  aiCopyBtn.classList.remove('hidden');
  setReportBtnsVisible(false);
}

// ===== 一键生成分析报告（5 模块） =====
const btnGenReport = document.getElementById('btnGenReport');
if (btnGenReport) {
  btnGenReport.addEventListener('click', () => {
    if (!drawerData || isGenerating) { if (!drawerData) showToast('暂无可加工的文字稿'); return; }
    generateReport();
  });
}

async function generateReport() {
  if (!drawerData || !drawerData.video_id || isGenerating) return;
  isGenerating = true;
  currentGenKeys = REPORT_MODULES.map(m => m.key);
  genDone = 0;
  genMode = 'report';
  const myToken = ++genToken;
  setActionBtnsDisabled(true);
  drawerTitle.textContent = '📄 内容分析报告';
  reportData = null;
  drawerFooter.classList.add('hidden');
  setReportBtnsVisible(false);

  renderProgressView(currentGenKeys);
  drawerTitle.textContent = '📄 内容分析报告';

  const results = {};
  const total = REPORT_MODULES.length;
  for (let i = 0; i < total; i++) {
    if (myToken !== genToken) return; // 已被中止
    const mod = REPORT_MODULES[i];
    drawerStatus[mod.key] = 'loading';
    updateStepUI(mod.key, 'running');
    updateProgressBar(i / total);

    try {
      const res = await fetch(API_PREFIX + '/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: mod.key, video_id: drawerData.video_id, persist: true })
      });
      const data = await res.json();
      if (!res.ok) throw (data && data.error) || new Error('生成失败');
      results[mod.key] = data.result || '';
      drawerResults[mod.key] = data.result || '';
      drawerStatus[mod.key] = 'done';
    } catch (e) {
      results[mod.key] = '⚠️ ' + friendlyGenError(e);
      drawerStatus[mod.key] = 'error';
    }
    genDone++;
    updateStepUI(mod.key, results[mod.key].startsWith('⚠️') ? 'error' : 'done');
    updateProgressBar(genDone / total);
    if (drawerMinimized) updateMiniUI();
  }

  if (myToken !== genToken) return; // 已被中止
  isGenerating = false;
  setActionBtnsDisabled(false);

  if (drawerMinimized) {
    // 先构建 reportData 供还原后渲染
    reportData = {
      title: drawerData.title || '抖音视频文字稿',
      author: drawerData.author || '',
      duration: drawerData.duration || 0,
      word_count: drawerData.word_count || 0,
      share_url: drawerData.share_url || '',
      segments: drawerData.segments || [],
      results
    };
    updateMiniUI();
    showToast('✓ 报告生成完成，点击右下角胶囊查看');
  } else {
    renderReport(results);
  }
}

function renderReport(results) {
  reportData = {
    title: drawerData.title || '抖音视频文字稿',
    author: drawerData.author || '',
    duration: drawerData.duration || 0,
    word_count: drawerData.word_count || 0,
    share_url: drawerData.share_url || '',
    segments: drawerData.segments || [],
    results
  };

  const sectionsHtml = REPORT_MODULES.map((m) => {
    const content = results[m.key] || '';
    const isError = content.startsWith('⚠️');
    return '<div class="report-section">' +
      '<div class="report-section-title">' + m.icon + ' ' + m.label + '</div>' +
      '<div class="report-section-body">' +
        (isError ? '<div style="color:var(--error)">' + escapeHtml(content) + '</div>' : renderMarkdownLite(content)) +
      '</div></div>';
  }).join('');

  const meta = reportData;
  const mins = Math.floor(meta.duration / 60);
  const secs = Math.floor(meta.duration % 60);

  drawerTitle.textContent = '📄 内容分析报告';
  drawerBody.innerHTML =
    '<div class="report-meta">' +
      '<div class="report-meta-title">' + escapeHtml(meta.title) + '</div>' +
      '<div>👤 ' + escapeHtml(meta.author) + ' &nbsp; ⏱ ' + mins + ':' + String(secs).padStart(2, '0') +
      ' &nbsp; 📝 ' + meta.word_count + '字</div>' +
    '</div>' +
    sectionsHtml;

  drawerFooter.classList.remove('hidden');
  aiCopyBtn.classList.add('hidden');
  setReportBtnsVisible(true);

  if (document.getElementById('view-library').classList.contains('active')) {
    loadLibrary();
  }
}

// 报告相关按钮统一显隐
function setReportBtnsVisible(visible) {
  ['viewReportBtn', 'exportReportBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !visible);
  });
}

// 在线查看报告（新标签页打开，无需下载）
document.getElementById('viewReportBtn').addEventListener('click', () => {
  if (!reportData) return;
  const html = buildReportHTML(reportData);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  showToast('已在新标签页打开报告');
});

// 导出 HTML 报告
document.getElementById('exportReportBtn').addEventListener('click', () => {
  if (!reportData) return;
  const html = buildReportHTML(reportData);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '内容分析报告_' + (reportData.title || 'video').slice(0, 30).replace(/[\\/:*?"<>|]/g, '') + '.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('报告已导出');
});

// 从文案库卡片打开 HTML 报告（新标签页，复用 buildReportHTML）
async function openReportInNewTab(id) {
  const data = await fetchHistoryItem(id);
  if (!data) return;
  if (!data.analysis) { showToast('该文案尚未生成报告'); return; }
  const results = {};
  REPORT_MODULES.forEach((m) => {
    if (data.analysis[m.key]) results[m.key] = data.analysis[m.key];
  });
  if (!Object.keys(results).length) { showToast('该文案尚未生成报告'); return; }
  const reportData = {
    title: data.title || '抖音视频文字稿',
    author: data.author || '',
    duration: data.duration || 0,
    word_count: data.word_count || 0,
    share_url: data.share_url || '',
    segments: data.segments || [],
    results
  };
  const html = buildReportHTML(reportData);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  showToast('已在新标签页打开报告');
}

function buildReportHTML(data) {
  const mins = Math.floor(data.duration / 60);
  const secs = Math.floor(data.duration % 60);
  const date = new Date().toLocaleString('zh-CN');

  const sections = REPORT_MODULES.map((m, i) => {
    const content = (data.results && data.results[m.key]) || '';
    const num = String(i + 1).padStart(2, '0');
    return '<section class="mod-section" id="sec-' + m.key + '">' +
      '<div class="sec-head">' +
        '<div class="sec-kicker">' + num + ' / ' + m.icon + '</div>' +
        '<h2 class="sec-title">' + m.label + '</h2>' +
      '</div>' +
      '<div class="sec-card"><div class="sec-body">' + renderMarkdownForExport(content) + '</div></div>' +
      '</section>';
  }).join('');

  const transcript = Array.isArray(data.segments)
    ? data.segments.map(s => '<p><span class="ts">[' + formatTime(s.start) + ']</span>' + escapeHtml(s.text) + '</p>').join('')
    : '';

  const navLinks = REPORT_MODULES.map(m =>
    '<a href="#sec-' + m.key + '">' + m.label + '</a>'
  ).join('') + '<a href="#sec-transcript">文字稿</a>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>内容分析报告 · ${escapeHtml(data.title)}</title>
<style>
:root{
  --paper:#f4eee2;--paper2:#fffaf0;--ink:#211f1b;--muted:#746a5c;
  --line:rgba(38,31,24,.16);--orange:#c6572a;--red:#8e2d22;--gold:#d8a647;
  --radius:26px;--shadow:0 20px 60px rgba(57,43,28,.12);
}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  color:var(--ink);line-height:1.8;
  background:
    radial-gradient(circle at 8% 4%, rgba(198,87,42,.16), transparent 30rem),
    radial-gradient(circle at 92% 0%, rgba(57,91,122,.12), transparent 28rem),
    linear-gradient(135deg,#eee3d2 0%,var(--paper) 46%,#eadcc8 100%);
  font-family:ui-serif,"Songti SC","Noto Serif CJK SC","SimSun",Georgia,serif;
  -webkit-font-smoothing:antialiased;
}
.sans{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.shell{width:min(1080px,calc(100% - 40px));margin:0 auto}

/* 顶部导航 */
.topbar{position:sticky;top:0;z-index:20;border-bottom:1px solid var(--line);
  background:rgba(244,238,226,.85);backdrop-filter:blur(16px)}
.topbar-inner{width:min(1080px,calc(100% - 40px));margin:0 auto;min-height:60px;
  display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{display:flex;align-items:center;gap:10px;font-size:12px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--muted);white-space:nowrap;
  font-family:ui-sans-serif,system-ui,sans-serif}
.mark{width:24px;height:24px;border:1.5px solid var(--ink);border-radius:50%;position:relative;flex-shrink:0}
.mark::after{content:"";position:absolute;inset:5px;border-radius:50%;
  background:var(--orange);box-shadow:8px 0 0 rgba(57,91,122,.7)}
.nav{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;
  font-family:ui-sans-serif,system-ui,sans-serif;font-size:13px}
.nav a{text-decoration:none;color:var(--muted);padding:7px 11px;border-radius:999px;transition:.2s}
.nav a:hover{background:rgba(198,87,42,.12);color:var(--ink)}

/* Hero */
.hero{padding:clamp(48px,7vw,90px) 0 40px}
.kicker{display:inline-flex;align-items:center;gap:10px;margin-bottom:22px;color:var(--red);
  font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;font-weight:800;
  letter-spacing:.18em;text-transform:uppercase}
.kicker::before{content:"";width:48px;height:1px;background:currentColor}
h1{font-size:clamp(30px,4.6vw,56px);line-height:1.18;letter-spacing:-.02em;font-weight:900;max-width:860px}
.meta-strip{display:flex;flex-wrap:wrap;gap:10px;margin-top:28px;
  font-family:ui-sans-serif,system-ui,sans-serif}
.pill{border:1px solid var(--line);border-radius:999px;padding:8px 14px;
  background:rgba(255,250,240,.75);color:var(--muted);font-size:13px;text-decoration:none}
.pill b{color:var(--ink);font-weight:700}
a.pill:hover{background:rgba(198,87,42,.12);color:var(--ink)}

/* 数据条 */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:14px 0 10px}
.stat{border:1px solid var(--line);border-radius:var(--radius);background:rgba(255,250,240,.72);
  box-shadow:var(--shadow);padding:22px 24px}
.stat .num{font-family:ui-sans-serif,system-ui,sans-serif;font-size:clamp(30px,4vw,46px);
  font-weight:900;line-height:1;letter-spacing:-.04em;color:var(--orange)}
.stat .lbl{margin-top:8px;font-size:13px;color:var(--muted);font-family:ui-sans-serif,system-ui,sans-serif}

/* 模块章节 */
.mod-section{padding:clamp(30px,4vw,50px) 0;scroll-margin-top:80px}
.sec-head{display:flex;align-items:baseline;gap:18px;margin-bottom:18px;flex-wrap:wrap}
.sec-kicker{color:var(--red);font-family:ui-sans-serif,system-ui,sans-serif;
  font-size:13px;font-weight:800;letter-spacing:.16em;white-space:nowrap}
.sec-title{font-size:clamp(24px,3vw,38px);line-height:1.15;letter-spacing:-.02em;font-weight:900}
.sec-card{border:1px solid var(--line);border-radius:var(--radius);
  background:rgba(255,250,240,.78);box-shadow:var(--shadow);
  padding:clamp(22px,3vw,36px);overflow:hidden}
.sec-body{font-size:16px;color:#332e26}
.sec-body h1,.sec-body h2,.sec-body h3{font-size:19px;margin:20px 0 8px;font-weight:800;line-height:1.4}
.sec-body h1:first-child,.sec-body h2:first-child,.sec-body h3:first-child{margin-top:0}
.sec-body ul,.sec-body ol{padding-left:24px;margin:10px 0}
.sec-body li{margin:6px 0}
.sec-body strong{color:var(--red);background:linear-gradient(transparent 62%,rgba(216,166,71,.35) 0)}
.sec-body p{margin:10px 0}
.sec-body code{background:rgba(33,31,27,.07);padding:2px 7px;border-radius:6px;font-size:13px;
  font-family:ui-monospace,monospace}
.sec-body hr{border:none;border-top:1px solid var(--line);margin:18px 0}

/* 文字稿 */
.transcript{max-height:480px;overflow-y:auto;font-size:15px;color:#4a4238}
.transcript p{margin:8px 0;line-height:1.9}
.ts{display:inline-block;min-width:52px;color:var(--orange);font-weight:700;
  font-family:ui-sans-serif,system-ui,sans-serif;font-size:13px;font-variant-numeric:tabular-nums}

.footer{text-align:center;color:var(--muted);font-size:12px;padding:34px 0 44px;
  font-family:ui-sans-serif,system-ui,sans-serif;letter-spacing:.06em}

@media(max-width:720px){
  .nav{display:none}
  .stats{grid-template-columns:1fr 1fr 1fr;gap:10px}
  .stat{padding:14px 16px}
  .hero{padding:36px 0 24px}
}
@media print{
  body{background:#fff}
  .topbar{display:none}
  .sec-card,.stat{box-shadow:none;border:1px solid #ddd;page-break-inside:avoid}
  .mod-section{padding:18px 0}
  .transcript{max-height:none;overflow:visible}
}
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-inner">
    <div class="brand"><span class="mark"></span>内容分析报告</div>
    <nav class="nav">${navLinks}</nav>
  </div>
</div>
<div class="shell">
  <header class="hero">
    <div class="kicker">Content Analysis Report</div>
    <h1>${escapeHtml(data.title)}</h1>
    <div class="meta-strip">
      ${data.author ? '<span class="pill">👤 <b>@' + escapeHtml(data.author) + '</b></span>' : ''}
      <span class="pill">⏱ 时长 <b>${mins}:${String(secs).padStart(2, '0')}</b></span>
      <span class="pill">📝 全文 <b>${data.word_count}</b> 字</span>
      <span class="pill">📅 ${date}</span>
      ${data.share_url ? '<a class="pill" href="' + escapeHtml(data.share_url) + '" target="_blank">🔗 查看原视频</a>' : ''}
    </div>
    <div class="stats">
      <div class="stat"><div class="num">${mins}<span style="font-size:.45em">分</span>${String(secs).padStart(2, '0')}<span style="font-size:.45em">秒</span></div><div class="lbl">视频时长</div></div>
      <div class="stat"><div class="num">${data.word_count}</div><div class="lbl">文字稿字数</div></div>
      <div class="stat"><div class="num">${REPORT_MODULES.length}</div><div class="lbl">深度分析模块</div></div>
    </div>
  </header>
  ${sections}
  <section class="mod-section" id="sec-transcript">
    <div class="sec-head">
      <div class="sec-kicker">06 / 📄</div>
      <h2 class="sec-title">完整文字稿</h2>
    </div>
    <div class="sec-card"><div class="transcript">${transcript}</div></div>
  </section>
  <div class="footer">由 抖音文字稿工作台 生成 · ${date}</div>
</div>
</body>
</html>`;
}

function renderMarkdownForExport(md) {
  if (!md) return '';
  const lines = md.split('\n');
  let html = '';
  let inUl = false;
  let inOl = false;
  let inPara = false;
  const closeLists = () => {
    if (inUl) { html += '</ul>'; inUl = false; }
    if (inOl) { html += '</ol>'; inOl = false; }
  };
  const closePara = () => { if (inPara) { html += '</p>'; inPara = false; } };
  const inline = (s) => escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/🔥推荐/g, '<span style="color:#fe2c55;font-weight:600">🔥推荐</span>');

  // 预扫描：判断某行是否为列表项
  const isUlItem = (l) => /^[-*]\s+/.test(l);
  const isOlItem = (l) => /^\d+\.\s+/.test(l);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      // 空行：向前看下一个非空行，如果是同类列表项则保持列表
      const nextIdx = i + 1;
      while (nextIdx < lines.length && !lines[nextIdx].trim()) nextIdx++;
      const next = nextIdx < lines.length ? lines[nextIdx].trim() : '';
      if ((inUl && isUlItem(next)) || (inOl && isOlItem(next))) {
        continue; // 保持列表开启
      }
      closeLists(); closePara();
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.+)$/))) {
      closeLists(); closePara();
      const level = m[1].length;
      html += '<h' + level + '>' + inline(m[2]) + '</h' + level + '>';
    } else if ((m = line.match(/^[-*]\s+(.+)$/))) {
      closePara();
      if (inOl) { html += '</ol>'; inOl = false; }
      if (!inUl) { html += '<ul>'; inUl = true; }
      html += '<li>' + inline(m[1]) + '</li>';
    } else if ((m = line.match(/^\d+\.\s+(.+)$/))) {
      closePara();
      if (inUl) { html += '</ul>'; inUl = false; }
      if (!inOl) { html += '<ol>'; inOl = true; }
      html += '<li>' + inline(m[1]) + '</li>';
    } else if (/^---+$/.test(line)) {
      closeLists(); closePara();
      html += '<hr>';
    } else {
      closeLists();
      if (!inPara) { html += '<p>'; inPara = true; }
      html += inline(line) + '<br>';
    }
  }
  closeLists(); closePara();
  return html;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

// 极简 markdown → html（支持 # ## ###、-/* 无序列表、1. 有序列表、**加粗**、空行分段、---）
function renderMarkdownLite(md) {
  const lines = (md || '').split('\n');
  let html = '';
  let inUl = false;
  let inOl = false;
  let inPara = false;
  const closeLists = () => {
    if (inUl) { html += '</ul>'; inUl = false; }
    if (inOl) { html += '</ol>'; inOl = false; }
  };
  const closePara = () => { if (inPara) { html += '</p>'; inPara = false; } };
  const inline = (s) => escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  const isUlItem = (l) => /^[-*]\s+/.test(l);
  const isOlItem = (l) => /^\d+\.\s+/.test(l);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      const nextIdx = i + 1;
      while (nextIdx < lines.length && !lines[nextIdx].trim()) nextIdx++;
      const next = nextIdx < lines.length ? lines[nextIdx].trim() : '';
      if ((inUl && isUlItem(next)) || (inOl && isOlItem(next))) continue;
      closeLists(); closePara();
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.+)$/))) {
      closeLists(); closePara();
      const lvl = m[1].length;
      html += '<h' + lvl + '>' + inline(m[2]) + '</h' + lvl + '>';
    } else if ((m = line.match(/^[-*]\s+(.+)$/))) {
      closePara();
      if (inOl) { html += '</ol>'; inOl = false; }
      if (!inUl) { html += '<ul>'; inUl = true; }
      html += '<li>' + inline(m[1]) + '</li>';
    } else if ((m = line.match(/^\d+\.\s+(.+)$/))) {
      closePara();
      if (inUl) { html += '</ul>'; inUl = false; }
      if (!inOl) { html += '<ol>'; inOl = true; }
      html += '<li>' + inline(m[1]) + '</li>';
    } else if (/^---+$/.test(line)) {
      closeLists(); closePara();
      html += '<hr>';
    } else {
      closeLists();
      if (!inPara) { html += '<p>'; inPara = true; } else { html += '<br>'; }
      html += inline(line);
    }
  }
  closeLists(); closePara();
  return html;
}

aiCopyBtn.addEventListener('click', () => {
  const keys = Object.keys(drawerResults).filter(k => drawerResults[k] && !drawerResults[k].startsWith('⚠️'));
  if (keys.length === 0) return;
  const text = keys.map(k => {
    const m = ALL_MODULES.find(mod => mod.key === k) || {};
    return '【' + (m.label || k) + '】\n' + drawerResults[k];
  }).join('\n\n');
  copyText(text, '已复制全部结果');
});

// ========== 设置弹窗 ==========
const settingsModal = $('settingsModal');
const settingsMask = $('settingsMask');
const settingsClose = $('settingsClose');
const settingsCancel = $('settingsCancel');
const settingsSave = $('settingsSave');
const settingsBtn = $('settingsBtn');

let fieldMapSnapshot = {}; // 字段映射编辑快照

function openSettings(tab) {
  // 刚登录/注册的会话，首次打开设置：保留个人资料+字段映射，只跳过飞书/AI配置加载
  if (sessionFresh) {
    sessionFresh = false;
    loadProfileIntoForm();  // 加载用户名、角色等个人信息
    loadFieldMapOnly();     // 保留字段映射
    settingsModal.classList.remove('hidden');
    settingsMask.classList.remove('hidden');
    if (tab) switchSettingsTab(tab);
    return;
  }
  loadSettingsIntoForm();
  settingsModal.classList.remove('hidden');
  settingsMask.classList.remove('hidden');
  if (tab) switchSettingsTab(tab);
}
function closeSettings() {
  settingsModal.classList.add('hidden');
  settingsMask.classList.add('hidden');
}
settingsBtn.addEventListener('click', () => openSettings());
settingsClose.addEventListener('click', closeSettings);
settingsCancel.addEventListener('click', closeSettings);
settingsMask.addEventListener('click', closeSettings);
$('pfChangePwdBtn').addEventListener('click', savePassword);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsModal.classList.contains('hidden')) closeSettings();
});

// 通用弹窗显隐（供模板编辑 / 用户配置查看复用）
function showModal(id, maskId) {
  $(id).classList.remove('hidden');
  $(maskId).classList.remove('hidden');
}
function hideModal(id, maskId) {
  $(id).classList.add('hidden');
  $(maskId).classList.add('hidden');
}
// 模板编辑弹窗事件
$('editTemplateBtn').addEventListener('click', openTemplateEditor);
$('templateClose').addEventListener('click', () => hideModal('templateModal', 'templateMask'));
$('templateCancel').addEventListener('click', () => hideModal('templateModal', 'templateMask'));
$('templateMask').addEventListener('click', () => hideModal('templateModal', 'templateMask'));
$('templateSave').addEventListener('click', saveTemplate);
// 用户配置查看弹窗事件
$('userConfigClose').addEventListener('click', () => hideModal('userConfigModal', 'userConfigMask'));
$('userConfigCancel').addEventListener('click', () => hideModal('userConfigModal', 'userConfigMask'));
$('userConfigMask').addEventListener('click', () => hideModal('userConfigModal', 'userConfigMask'));
$('userConfigReset').addEventListener('click', () => { if (userConfigTargetId) resetUserConfig(userConfigTargetId); });

// 创建用户弹窗
$('createUserBtn').addEventListener('click', openCreateUserModal);
$('createUserClose').addEventListener('click', () => hideModal('createUserModal', 'createUserMask'));
$('createUserCancel').addEventListener('click', () => hideModal('createUserModal', 'createUserMask'));
$('createUserMask').addEventListener('click', () => hideModal('createUserModal', 'createUserMask'));
$('createUserSubmit').addEventListener('click', saveNewUser);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('templateModal').classList.contains('hidden')) hideModal('templateModal', 'templateMask');
    if (!$('userConfigModal').classList.contains('hidden')) hideModal('userConfigModal', 'userConfigMask');
    if (!$('createUserModal').classList.contains('hidden')) hideModal('createUserModal', 'createUserMask');
  }
});

// Tab 切换
document.querySelectorAll('.modal-tab').forEach((t) => {
  t.addEventListener('click', () => switchSettingsTab(t.dataset.tab));
});
function switchSettingsTab(tab) {
  document.querySelectorAll('.modal-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
}

// 绑定密钥显示/隐藏切换按钮（眼睛图标）
bindTogglePwBtn('toggleFeishuSecret', 'feishuAppSecret');
bindTogglePwBtn('toggleAiKey', 'aiApiKey');

// 清空设置弹窗所有表单字段（注册/登录/切换用户时调用）
let sessionFresh = false; // 标记本次会话是否刚登录/注册（模板编辑器首次打开不自动拉取）
function clearSettingsForm() {
  sessionFresh = true;
  // 飞书多维表格（配置项，清空）
  $('feishuAppId').value = '';
  $('feishuAppSecret').value = '';
  const tFs = $('toggleFeishuSecret');
  if (tFs) { tFs.classList.remove('active'); tFs.textContent = '👁'; }
  $('feishuUrl').value = '';
  const fs = $('feishuStatus');
  if (fs) { fs.textContent = ''; fs.className = 'form-status'; }
  // AI 模型（配置项，清空）
  $('aiEnabled').checked = false;
  $('aiBaseUrl').value = '';
  $('aiApiKey').value = '';
  const tAk = $('toggleAiKey');
  if (tAk) { tAk.classList.remove('active'); tAk.textContent = '👁'; }
  $('aiModel').value = '';
  $('aiTemp').value = '0.6';
  $('aiAutoGen').checked = true;
  // 密码修改区（清空）
  const oldPwd = $('pfOldPassword');
  if (oldPwd) oldPwd.value = '';
  const newPwd = $('pfNewPassword');
  if (newPwd) newPwd.value = '';
  const cfPwd = $('pfConfirmPassword');
  if (cfPwd) cfPwd.value = '';
  // 默认配置模板编辑器
  const tAppId = $('tplFeishuAppId');
  if (tAppId) tAppId.value = '';
  const tSecret = $('tplFeishuAppSecret');
  if (tSecret) tSecret.value = '';
  const tUrl = $('tplFeishuUrl');
  if (tUrl) tUrl.value = '';
  const tAiEn = $('tplAiEnabled');
  if (tAiEn) tAiEn.checked = false;
  const tAiBase = $('tplAiBaseUrl');
  if (tAiBase) tAiBase.value = '';
  const tAiKey = $('tplAiApiKey');
  if (tAiKey) tAiKey.value = '';
  const tAiModel = $('tplAiModel');
  if (tAiModel) tAiModel.value = '';
  const tAiTemp = $('tplAiTemp');
  if (tAiTemp) tAiTemp.value = '0.6';
}

// 仅加载个人资料到表单（不含飞书/AI配置，供首次打开设置用）
async function loadProfileIntoForm() {
  try {
    const res = await fetch(API_PREFIX + '/api/profile');
    if (res.ok) {
      const p = await res.json();
      $('pfDisplayName').value = p.display_name || '';
      $('pfBio').value = (p.contact && p.contact.bio) || '';
      $('pfEmail').value = (p.contact && p.contact.email) || '';
      $('pfWechat').value = (p.contact && p.contact.wechat) || '';
      if (p.preferences) {
        $('pfNotifBrowser').checked = p.preferences.notifications.browser !== false;
        $('pfAutoAi').checked = p.preferences.auto_generate_ai !== false;
      }
      const roleEl = $('pfRole');
      if (currentUser && currentUser.is_admin) {
        roleEl.textContent = '系统拥有者';
        roleEl.className = 'profile-role-badge admin';
      } else {
        roleEl.textContent = '成员';
        roleEl.className = 'profile-role-badge user';
      }
      $('pfCreatedAt').textContent = fmtDateISO(p.created_at);
      $('pfUpdatedAt').textContent = fmtDateISO(p.updated_at);
    }
  } catch (e) { /* 静默 */ }
}

// 仅加载字段映射（不清空飞书/AI配置，供首次打开设置用）
async function loadFieldMapOnly() {
  try {
    const res = await fetch(API_PREFIX + '/api/config');
    if (res.ok) {
      const cfg = await res.json();
      fieldMapSnapshot = Object.assign({}, cfg.field_map);
      renderFieldMapEditor();
    }
  } catch (e) { /* 静默 */ }
}

// 加载配置到表单
const SECRET_PLACEHOLDER = '••••••••';
async function loadSettingsIntoForm() {
  try {
    const res = await fetch(API_PREFIX + '/api/config');
    const cfg = await res.json();
    $('feishuAppId').value = cfg.feishu.app_id || '';
    // 飞书密钥：已存储则显示占位符，否则空（眼睛按钮始终可见）
    if (cfg.feishu.has_secret) {
      $('feishuAppSecret').value = SECRET_PLACEHOLDER;
    } else {
      $('feishuAppSecret').value = '';
    }
    $('feishuUrl').value = cfg.feishu.raw_url || '';
    if (cfg.feishu.configured) {
      $('feishuStatus').textContent = '✓ 已连接：' + cfg.feishu.table_id;
      $('feishuStatus').className = 'form-status ok';
    }
    $('aiEnabled').checked = !!cfg.ai.enabled;
    $('aiBaseUrl').value = cfg.ai.base_url || '';
    // AI 密钥：已存储则显示占位符，否则空（眼睛按钮始终可见）
    if (cfg.ai.has_key) {
      $('aiApiKey').value = SECRET_PLACEHOLDER;
    } else {
      $('aiApiKey').value = '';
    }
    $('aiModel').value = cfg.ai.model || '';
    $('aiTemp').value = cfg.ai.temperature != null ? cfg.ai.temperature : 0.6;
    $('aiAutoGen').checked = cfg.ai.auto_generate !== false;

    fieldMapSnapshot = Object.assign({}, cfg.field_map);
    renderFieldMapEditor();
  } catch (e) {
    showToast('加载配置失败');
  }

  // 加载个人资料
  try {
    const res = await fetch(API_PREFIX + '/api/profile');
    if (res.ok) {
      const p = await res.json();
      $('pfDisplayName').value = p.display_name || '';
      $('pfBio').value = (p.contact && p.contact.bio) || '';
      $('pfEmail').value = (p.contact && p.contact.email) || '';
      $('pfWechat').value = (p.contact && p.contact.wechat) || '';
      if (p.preferences) {
        $('pfNotifBrowser').checked = p.preferences.notifications.browser !== false;
        $('pfAutoAi').checked = p.preferences.auto_generate_ai !== false;
      }
      // 角色标签（以登录态 is_admin 为准，避免与 profile.role 死字段不一致）
      const roleEl = $('pfRole');
      if (currentUser && currentUser.is_admin) {
        roleEl.textContent = '系统拥有者';
        roleEl.className = 'profile-role-badge admin';
      } else {
        roleEl.textContent = '成员';
        roleEl.className = 'profile-role-badge user';
      }
      // 时间戳
      $('pfCreatedAt').textContent = fmtDateISO(p.created_at);
      $('pfUpdatedAt').textContent = fmtDateISO(p.updated_at);
    }
  } catch (e) {
    // 静默失败，profile 不影响核心功能
  }
}

function fmtDateISO(iso) {
  if (!iso) return '-';
  try { const d = new Date(iso); return d.toLocaleString('zh-CN'); } catch { return '-'; }
}

function renderFieldMapEditor() {
  const labels = {
    title: '视频标题', url: '视频链接', author: '作者', content: '文案原文',
    hook: '开头钩子', pains: '核心痛点', solution: '解决方案',
    quotes: '金句', structure: '结构拆解', insight: '我的启发',
    topics: '选题建议', outline: '内容大纲', highlights: '亮点提炼', extension: '内容拓展',
    xiaohongshu: '小红书笔记', gongzhonghao: '公众号大纲',
    tags: '标签', status: '分析状态',
    duration: '时长(秒)', word_count: '字数', source: '来源',
    created_at: '抓取时间'
  };
  const list = $('fieldMapList');
  list.innerHTML = Object.keys(fieldMapSnapshot).map((key) =>
    '<div class="field-map-row">' +
      '<label>' + escapeHtml(labels[key] || key) + '</label>' +
      '<input type="text" data-key="' + escapeHtml(key) + '" value="' + escapeHtml(fieldMapSnapshot[key] || '') + '" />' +
      '<span class="field-map-key">' + escapeHtml(key) + '</span>' +
    '</div>'
  ).join('');
  list.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('input', () => { fieldMapSnapshot[inp.dataset.key] = inp.value; });
  });
}

// 保存个人资料
async function saveProfile() {
  const body = {
    display_name: $('pfDisplayName').value.trim(),
    contact: {
      bio: $('pfBio').value.trim(),
      email: $('pfEmail').value.trim(),
      wechat: $('pfWechat').value.trim()
    },
    preferences: {
      notifications: { browser: $('pfNotifBrowser').checked },
      auto_generate_ai: $('pfAutoAi').checked
    }
  };
  try {
    const res = await fetch(API_PREFIX + '/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('保存失败');
    showToast('✓ 个人资料已更新');
    closeSettings();
  } catch (e) {
    showToast('保存失败：' + e.message);
  }
}

// 修改密码
async function savePassword() {
  const oldPwd = $('pfOldPwd').value;
  const newPwd = $('pfNewPwd').value;
  const confirmPwd = $('pfConfirmPwd').value;
  const statusEl = $('pfPwdStatus');

  if (!oldPwd || !newPwd || !confirmPwd) {
    statusEl.textContent = '请填写完整';
    statusEl.className = 'form-status err';
    return;
  }
  if (newPwd.length < 6) {
    statusEl.textContent = '新密码至少 6 位';
    statusEl.className = 'form-status err';
    return;
  }
  if (newPwd !== confirmPwd) {
    statusEl.textContent = '两次输入的新密码不一致';
    statusEl.className = 'form-status err';
    return;
  }

  const btn = $('pfChangePwdBtn');
  btn.disabled = true;
  statusEl.textContent = '修改中…';
  statusEl.className = 'form-status';

  try {
    const res = await fetch(API_PREFIX + '/api/auth/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_password: oldPwd, new_password: newPwd })
    });
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = (data.error && data.error.message) || '修改失败';
      statusEl.className = 'form-status err';
      return;
    }
    // 密码修改成功，服务端已清除会话，前端退回登录门
    showToast(data.message || '密码已更新，请重新登录');
    closeSettings();
    // 清空密码字段
    $('pfOldPwd').value = '';
    $('pfNewPwd').value = '';
    $('pfConfirmPwd').value = '';
    statusEl.textContent = '';
    // 退出并显示登录门
    currentUser = null;
    renderUserChip();
    showAuthGate();
  } catch (e) {
    statusEl.textContent = '网络异常，请稍后重试';
    statusEl.className = 'form-status err';
  } finally {
    btn.disabled = false;
  }
}

// 密钥字段处理：占位符→undefined(不修改)；空字符串→null(显式删除)；有值→原值
function handleSecretField(inputId) {
  const el = $(inputId);
  if (!el) return undefined;
  const v = el.value.trim();
  if (v === SECRET_PLACEHOLDER) return undefined; // 占位符 = 不修改
  if (v === '') return null;                     // 空值 = 显式清除
  return v;                                      // 新值 = 更新
}

// 密钥显示/隐藏切换按钮事件（眼睛图标）
function bindTogglePwBtn(btnId, inputId) {
  const btn = $(btnId);
  if (!btn) return;
  btn.addEventListener('click', () => {
    const input = $(inputId);
    if (!input) return;
    if (input.type === 'password') {
      input.type = 'text';
      btn.classList.add('active');
      btn.textContent = '🙈';
      btn.title = '隐藏密钥';
    } else {
      input.type = 'password';
      btn.classList.remove('active');
      btn.textContent = '👁';
      btn.title = '显示密钥';
    }
  });
}

// 保存设置
settingsSave.addEventListener('click', async () => {
  // 如果当前在「个人资料」Tab，先保存资料
  const activePane = document.querySelector('.tab-pane.active');
  if (activePane && activePane.dataset.pane === 'profile') {
    await saveProfile();
    return;
  }

  const body = {
    feishu: {
      app_id: $('feishuAppId').value.trim(),
      // 占位符 → 不修改；空字符串 + 清除标记 → 显式删除；有值 → 更新
      app_secret: handleSecretField('feishuAppSecret'),
      raw_url: $('feishuUrl').value.trim()
    },
    ai: {
      enabled: $('aiEnabled').checked,
      base_url: $('aiBaseUrl').value.trim(),
      api_key: handleSecretField('aiApiKey'),
      model: $('aiModel').value.trim(),
      temperature: parseFloat($('aiTemp').value) || 0.6,
      auto_generate: $('aiAutoGen').checked
    },
    field_map: fieldMapSnapshot
  };
  // undefined 字段不发送（后端 deepMerge 不会覆盖）
  if (body.feishu.app_secret === undefined) delete body.feishu.app_secret;
  if (body.ai.api_key === undefined) delete body.ai.api_key;

  try {
    const res = await fetch(API_PREFIX + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('保存失败');
    showToast('✓ 设置已保存');
    closeSettings();
    checkHealth(); // 刷新状态栏（AI/ASR 配置状态）
  } catch (e) {
    showToast('保存失败：' + e.message);
  }
});

// 测试飞书连接
$('feishuConnectBtn').addEventListener('click', async () => {
  const status = $('feishuStatus');
  status.textContent = '连接中…'; status.className = 'form-status';
  const body = {
    app_id: $('feishuAppId').value.trim(),
    app_secret: $('feishuAppSecret').value === SECRET_PLACEHOLDER ? undefined : $('feishuAppSecret').value.trim(),
    url: $('feishuUrl').value.trim()
  };
  try {
    const res = await fetch(API_PREFIX + '/api/feishu/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw (data && data.error) || new Error('连接失败');
    status.textContent = '✓ 连接成功，表格共 ' + data.fields.length + ' 个字段';
    status.className = 'form-status ok';
    renderFeishuFields(data.fields);
  } catch (e) {
    status.textContent = '✗ ' + (e.message || '连接失败');
    status.className = 'form-status err';
  }
});

function renderFeishuFields(fields) {
  const box = $('feishuFields');
  box.classList.remove('hidden');
  const typeNames = { 1: '文本', 2: '数字', 3: '单选', 5: '日期', 7: '复选框', 11: '人员', 15: '超链接', 17: '附件' };
  box.innerHTML = fields.map((f) =>
    '<div class="field-list-item"><span class="fname">' + escapeHtml(f.field_name) +
    (f.is_primary ? ' <em style="color:#9ca3af">(主字段)</em>' : '') + '</span>' +
    '<span class="ftype">' + escapeHtml(typeNames[f.type] || ('类型' + f.type)) + '</span></div>'
  ).join('');
}

// 同步字段
$('feishuSyncBtn').addEventListener('click', async () => {
  const status = $('feishuStatus');
  status.textContent = '同步中…'; status.className = 'form-status';
  try {
    const res = await fetch(API_PREFIX + '/api/feishu/sync-fields', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (!res.ok) throw (data && data.error) || new Error('同步失败');
    let msg = '✓ 已就绪';
    if (data.created && data.created.length) msg += '，新建列：' + data.created.join('、');
    status.textContent = msg;
    status.className = 'form-status ok';
    if (data.fields) renderFeishuFields(data.fields);
    showToast(msg);
  } catch (e) {
    status.textContent = '✗ ' + (e.message || '同步失败');
    status.className = 'form-status err';
  }
});

// 测试 AI 连接
$('aiTestBtn').addEventListener('click', async () => {
  const btn = $('aiTestBtn');
  const status = $('aiStatus');
  btn.disabled = true;
  status.textContent = '正在连接测试，通常需要 5-15 秒…'; status.className = 'form-status';
  const ai = {
    enabled: $('aiEnabled').checked,
    base_url: $('aiBaseUrl').value.trim(),
    model: $('aiModel').value.trim(),
    temperature: parseFloat($('aiTemp').value) || 0.6
  };
  // 只有填了新 key 才发送，否则用已保存的（占位符表示未修改，不要覆盖）
  const keyVal = $('aiApiKey').value.trim();
  if (keyVal && keyVal !== SECRET_PLACEHOLDER) ai.api_key = keyVal;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    const res = await fetch(API_PREFIX + '/api/config/ai-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai }), signal: ctrl.signal
    });
    clearTimeout(timer);
    const data = await res.json();
    if (data.ok) {
      status.textContent = '✓ ' + (data.message || '连接成功');
      status.className = 'form-status ok';
    } else {
      status.textContent = '✗ ' + (data.message || '连接失败');
      status.className = 'form-status err';
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      status.textContent = '✗ 连接超时（30秒），请检查 API 地址和网络';
    } else {
      status.textContent = '✗ ' + e.message;
    }
    status.className = 'form-status err';
  } finally {
    btn.disabled = false;
  }
});

// ========== 初始化 ==========
// 登录后正式拉起应用；未登录则展示登录/注册门
function startApp() {
  // 刚登录/注册的会话，先显示初始状态（不调健康检查），等用户配置后再显示真实状态
  if (sessionFresh) {
    const dot = $('healthDot');
    const txt = $('healthText');
    if (dot) dot.className = 'health idle';
    if (txt) txt.textContent = '待配置';
  } else {
    checkHealth();
  }
  setInterval(checkHealth, 60000);
  applyHashRoute();
  if (location.hash !== '#library') singleInput.focus();

  // 演示/截图辅助：URL 带 ?demo=xxx 时自动打开对应面板
  (async function demoTrigger() {
    const params = new URLSearchParams(location.search);
    const demo = params.get('demo');
    if (!demo) return;
    // 等数据加载
    await new Promise((r) => setTimeout(r, 800));
    if (demo === 'settings') {
      openSettings(params.get('tab') || 'feishu');
    } else if (demo === 'drawer') {
      // 取文案库第一条记录打开抽屉
      try {
        const res = await fetch(API_PREFIX + '/api/history');
        if (guard401(res)) return;
        const data = await res.json();
        const first = data.items && data.items[0];
        if (first) {
          const full = await fetchHistoryItem(first.id);
          if (full) openDrawer(params.get('action') || null, full);
        }
      } catch (e) {}
    }
  })();
}

(async function boot() {
  setupAuthUI();
  const me = await checkAuth();
  if (me) {
    renderUserChip();
    hideAuthGate();
    // 每次页面加载（含刷新），设置表单都从清空状态开始，不自动加载旧数据
    clearSettingsForm();
    startApp();
  } else {
    renderUserChip();
    showAuthGate();
  }
})();
