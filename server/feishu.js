'use strict';

// 飞书多维表格联动模块
// 功能：鉴权、wiki链接解析、字段管理（列表/创建/删除）、记录写入
// 统一传参：app_id、app_secret、多维表格链接（含 wiki/base、table、view）

const https = require('https');
const { getProxyAgent } = require('./proxy');

const FEISHU_HOST = 'open.feishu.cn';
const TOKEN_CACHE = new Map(); // app_id -> { token, expireAt }

// ============ 通用 HTTP 请求 ============
function request(method, pathname, { token, body, query } = {}) {
  return new Promise((resolve, reject) => {
    let path = pathname;
    if (query && Object.keys(query).length) {
      const qs = Object.entries(query)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
        .join('&');
      if (qs) path += (path.includes('?') ? '&' : '?') + qs;
    }
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const agent = getProxyAgent(FEISHU_HOST);
    const opts = { host: FEISHU_HOST, path, method, headers };
    if (agent) opts.agent = agent;

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = { raw: text }; }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('飞书请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}

// ============ 鉴权 ============
async function getTenantToken(appId, appSecret) {
  if (!appId || !appSecret) {
    const e = new Error('缺少 app_id 或 app_secret');
    e.statusCode = 400;
    throw e;
  }
  const cached = TOKEN_CACHE.get(appId);
  if (cached && cached.expireAt > Date.now() + 60000) {
    return cached.token;
  }
  const { status, json } = await request('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
    body: { app_id: appId, app_secret: appSecret }
  });
  if (status !== 200 || json.code !== 0 || !json.tenant_access_token) {
    const msg = (json && json.msg) || ('鉴权失败 HTTP ' + status);
    const e = new Error('飞书鉴权失败：' + msg);
    e.statusCode = 401;
    e.feishuCode = json && json.code;
    throw e;
  }
  TOKEN_CACHE.set(appId, {
    token: json.tenant_access_token,
    expireAt: Date.now() + (json.expire || 7200) * 1000
  });
  return json.tenant_access_token;
}

// ============ 解析多维表格链接 ============
// 支持：
//   https://xxx.feishu.cn/base/<app_token>?table=tbl...&view=vew...
//   https://xxx.feishu.cn/wiki/<wiki_token>?table=tbl...&view=vew...
//   直接传 app_token/table_id 也可以
function parseUrl(inputUrl) {
  if (!inputUrl || typeof inputUrl !== 'string') return null;
  const result = { app_token: '', table_id: '', view_id: '', wiki_token: '', isWiki: false, raw_url: inputUrl };

  // 提取 query 参数
  let queryStr = '';
  const qIdx = inputUrl.indexOf('?');
  if (qIdx >= 0) {
    queryStr = inputUrl.slice(qIdx + 1);
    for (const pair of queryStr.split('&')) {
      const [k, v] = pair.split('=');
      if (k === 'table') result.table_id = decodeURIComponent(v || '');
      if (k === 'view') result.view_id = decodeURIComponent(v || '');
    }
  }

  // 判断是 base 还是 wiki
  let pathPart = inputUrl.split('?')[0].replace(/#.*$/, '');
  // 去尾部斜杠
  pathPart = pathPart.replace(/\/+$/, '');
  const segs = pathPart.split('/').filter(Boolean);

  // 找最后一段作为 token
  const lastSeg = segs[segs.length - 1] || '';
  // 协议域名后第一段是 base 或 wiki
  const typeIdx = segs.findIndex((s) => s === 'base' || s === 'wiki');
  if (typeIdx >= 0 && segs[typeIdx + 1]) {
    const type = segs[typeIdx];
    const token = segs[typeIdx + 1];
    if (type === 'wiki') {
      result.isWiki = true;
      result.wiki_token = token;
      // app_token 需通过 wiki API 解析
    } else {
      result.app_token = token;
    }
  } else if (lastSeg && /^[A-Za-z0-9]{10,}$/.test(lastSeg)) {
    // 裸 token
    result.app_token = lastSeg;
  }

  return result;
}

// wiki 节点 token -> 真实的 Base app_token
async function resolveWikiNode(token, accessToken) {
  const { status, json } = await request('GET', '/open-apis/wiki/v2/spaces/get_node', {
    token: accessToken,
    query: { token }
  });
  if (status !== 200 || json.code !== 0 || !json.data || !json.data.node) {
    const e = new Error('解析知识库节点失败：' + ((json && json.msg) || ('HTTP ' + status)));
    e.statusCode = 400;
    e.feishuCode = json && json.code;
    throw e;
  }
  const node = json.data.node;
  return {
    app_token: node.obj_token,
    obj_type: node.obj_type,
    title: node.title
  };
}

// ============ 字段管理 ============
// 飞书字段类型：1多行文本 2数字 3单选 5日期 7复选框 11人员 13电话 15超链接 17附件 18单向关联 20公式 21双向关联 22地理位置 1001创建时间 1002最后更新 1003创建人 1004修改人 1005自动编号
const FIELD_TYPE = { TEXT: 1, NUMBER: 2, DATETIME: 5, URL: 15 };

async function listFields(appToken, tableId, accessToken) {
  const { status, json } = await request('GET', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
    token: accessToken
  });
  if (status !== 200 || json.code !== 0) {
    const e = new Error('获取字段列表失败：' + ((json && json.msg) || ('HTTP ' + status)));
    e.statusCode = 400;
    e.feishuCode = json && json.code;
    throw e;
  }
  return (json.data && json.data.items) || [];
}

async function createField(appToken, tableId, accessToken, fieldName, fieldType = FIELD_TYPE.TEXT) {
  const body = { field_name: fieldName, type: fieldType };
  const { status, json } = await request('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
    token: accessToken,
    body
  });
  if (status !== 200 || json.code !== 0) {
    const e = new Error('创建字段「' + fieldName + '」失败：' + ((json && json.msg) || ('HTTP ' + status)));
    e.statusCode = 400;
    e.feishuCode = json && json.code;
    throw e;
  }
  return json.data && json.data.field;
}

async function deleteField(appToken, tableId, accessToken, fieldId) {
  const { status, json } = await request('DELETE',
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`,
    { token: accessToken });
  if (status !== 200 || json.code !== 0) {
    const e = new Error('删除字段失败：' + ((json && json.msg) || ('HTTP ' + status)));
    e.statusCode = 400;
    throw e;
  }
  return true;
}

// ============ 连接并准备表格（核心入口） ============
// 传入 app_id, app_secret, url（或已解析的 app_token/table_id）
// 1) 鉴权 2) 解析 wiki 3) 返回字段现状
async function connect({ app_id, app_secret, url, app_token, table_id, view_id }) {
  const token = await getTenantToken(app_id, app_secret);

  let at = app_token || '';
  let isWiki = false;
  let wikiToken = '';
  let tableId = table_id || '';
  let viewId = view_id || '';
  let wikiTitle = '';

  if (url) {
    const parsed = parseUrl(url);
    if (parsed) {
      tableId = tableId || parsed.table_id;
      viewId = viewId || parsed.view_id;
      if (parsed.isWiki) {
        isWiki = true;
        wikiToken = parsed.wiki_token;
      } else if (parsed.app_token) {
        at = parsed.app_token;
      }
    }
  }

  if (isWiki && !at) {
    const node = await resolveWikiNode(wikiToken, token);
    if (node.obj_type && node.obj_type !== 'bitable') {
      const e = new Error('该知识库节点不是多维表格（类型：' + node.obj_type + '）');
      e.statusCode = 400;
      throw e;
    }
    at = node.app_token;
    wikiTitle = node.title;
  }

  if (!at) {
    const e = new Error('无法从链接中解析出多维表格 app_token，请使用 /base/ 或 /wiki/ 链接');
    e.statusCode = 400;
    throw e;
  }
  if (!tableId) {
    const e = new Error('链接中缺少 table 参数（?table=tblxxx）');
    e.statusCode = 400;
    throw e;
  }

  const fields = await listFields(at, tableId, token);

  return {
    app_token: at,
    table_id: tableId,
    view_id: viewId,
    is_wiki: isWiki,
    wiki_token: wikiToken,
    wiki_title: wikiTitle,
    fields: fields.map((f) => ({
      field_id: f.field_id,
      field_name: f.field_name,
      type: f.type,
      is_primary: f.is_primary === true
    })),
    _token: token // 内部用，不返回给前端
  };
}

// 确保字段存在：根据 field_map，缺失的自动创建
// field_map: { internalKey: '飞书列名' }
// 返回 { fieldMap: {internalKey: field_id}, created: [...], existing: [...] }
async function ensureFields(appToken, tableId, accessToken, fieldMap) {
  const existing = await listFields(appToken, tableId, accessToken);
  const byName = new Map();
  const primary = existing.find((f) => f.is_primary);
  for (const f of existing) byName.set(f.field_name, f);

  const result = { fieldMap: {}, created: [], existing: [], primaryFieldId: primary ? primary.field_id : null };

  for (const [internalKey, feishuName] of Object.entries(fieldMap)) {
    if (!feishuName) continue;
    let f = byName.get(feishuName);
    if (f) {
      result.fieldMap[internalKey] = f.field_id;
      result.existing.push(feishuName);
    } else {
      // 主字段（第一个）不能删但会存在；若缺失则创建
      const created = await createField(appToken, tableId, accessToken, feishuName, FIELD_TYPE.TEXT);
      result.fieldMap[internalKey] = created.field_id;
      result.created.push(feishuName);
      byName.set(feishuName, created);
    }
  }
  return result;
}

// 删除指定字段名（用于清理用户不要的列）
async function removeFieldsByName(appToken, tableId, accessToken, namesToDelete) {
  if (!namesToDelete || !namesToDelete.length) return { deleted: [] };
  const existing = await listFields(appToken, tableId, accessToken);
  const deleted = [];
  for (const f of existing) {
    if (f.is_primary) continue; // 主字段不能删
    if (namesToDelete.includes(f.field_name)) {
      await deleteField(appToken, tableId, accessToken, f.field_id);
      deleted.push(f.field_name);
    }
  }
  return { deleted };
}

// ============ 记录写入 ============

// 从 AI 结构分析结果中提取某一段（【开头钩子】... 格式）
function extractSection(text, label) {
  if (!text) return '';
  const re = new RegExp('【' + label + '】([\\s\\S]*?)(?=【[^】]+】|$)');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

// 从痛点分析中提取"最痛的点"
function extractWorstPain(text) {
  if (!text) return '';
  const m = text.match(/###?\s*最痛的点\s*\n([\s\S]*?)(?=\n###?|\n##|$)/);
  if (m) return m[1].trim();
  // 退而求其次：取痛点清单第一条
  const first = text.match(/(?:^|\n)\d+\.\s*(.+)/);
  return first ? first[1].trim() : text.slice(0, 200);
}

// 从选题建议中提取推荐选题（去掉 markdown 符号）
function extractTopics(text) {
  if (!text) return '';
  const lines = text.split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l && l.length > 4);
  return lines.slice(0, 10).join('\n');
}

// 将一条文案记录按字段映射写入飞书
// fieldDefs: 从 listFields 拿到的字段定义数组（用于判断类型）
async function writeRecord(appToken, tableId, accessToken, fieldMap, record, analysis = {}, fieldDefs) {
  // 拉取字段定义（如果没传）
  let defs = fieldDefs;
  if (!defs) {
    defs = await listFields(appToken, tableId, accessToken);
  }
  const defByName = new Map();
  for (const f of defs) defByName.set(f.field_name, f);

  // 按列名找到字段类型，正确格式化值
  const set = (internalKey, value, opts = {}) => {
    const colName = fieldMap[internalKey];
    if (!colName || value == null || value === '') return;
    const def = defByName.get(colName);
    const type = def ? def.type : 1; // 默认文本
    fields[colName] = formatValue(type, value, opts, def);
  };

  const fields = {};
  const content = buildContent(record);

  // 基础字段
  set('title', record.title);
  set('author', record.author ? '@' + record.author : '');
  // 视频链接：优先 share_url，兜底用 video_id 拼标准链接
  const videoUrl = record.share_url || record.url ||
    (record.video_id ? 'https://www.douyin.com/video/' + record.video_id : '');
  set('url', videoUrl, { linkText: record.title || '抖音视频' });
  set('content', content);
  set('duration', Math.round(record.duration || 0));
  set('word_count', record.word_count || 0);

  // 时间字段（飞书日期需要毫秒时间戳）
  if (record.created_at) {
    set('created_at', new Date(record.created_at).getTime());
  }

  // AI 分析结果
  const structure = analysis.structure || '';
  const pains = analysis.pains || '';

  set('quotes', analysis.quotes || '');
  set('structure', structure);
  set('pains', pains ? extractWorstPain(pains) : '');
  set('xiaohongshu', analysis.xiaohongshu || '');
  set('gongzhonghao', analysis.gongzhonghao || '');
  set('topics', analysis.topics ? extractTopics(analysis.topics) : '');
  set('outline', analysis.outline || '');
  set('highlights', analysis.highlights || '');
  set('extension', analysis.extension || '');

  // 从结构分析中拆解
  set('hook', extractSection(structure, '开头钩子'));
  set('solution', extractSection(structure, '可复用点') || extractSection(structure, '核心观点'));
  set('insight', extractSection(structure, '可复用点'));

  // 标签（多选字段）
  const tags = [];
  if (record.source) tags.push(SOURCE_TAG[record.source] || record.source);
  if (analysis.quotes) tags.push('已提炼金句');
  if (analysis.pains) tags.push('已挖痛点');
  if (analysis.topics) tags.push('已有选题');
  set('tags', tags);

  // 分析状态（单选）
  const doneCount = ['quotes', 'structure', 'pains', 'topics', 'xiaohongshu', 'gongzhonghao', 'outline', 'highlights', 'extension']
    .filter((k) => analysis[k]).length;
  if (doneCount >= 6) set('status', '已分析');
  else if (doneCount > 0) set('status', '部分分析');
  else set('status', '待分析');

  const { status, json } = await request('POST',
    `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    { token: accessToken, body: { fields } });

  if (status !== 200 || json.code !== 0) {
    const e = new Error('写入记录失败：' + ((json && json.msg) || ('HTTP ' + status)));
    e.statusCode = 400;
    e.feishuCode = json && json.code;
    throw e;
  }
  return json.data && json.data.record;
}

const SOURCE_TAG = {
  subtitle: '官方字幕',
  asr: '语音识别',
  note: '图文笔记'
};

// 根据飞书字段类型格式化值
// type: 1文本 2数字 3单选 4多选 5日期 7复选 11人员 13电话 15超链接 17附件
function formatValue(type, value, opts = {}, def) {
  switch (type) {
    case 2: // 数字
      return Number(value) || 0;
    case 5: // 日期（毫秒时间戳）
      return Number(value) || Date.now();
    case 3: // 单选：传字符串
      return String(value);
    case 4: // 多选：传字符串数组
      if (Array.isArray(value)) return value.map(String);
      return String(value).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    case 15: // 超链接：{ link, text }
      return { link: String(value), text: opts.linkText || String(value) };
    case 7: // 复选框
      return Boolean(value);
    default: // 1 文本及其他
      return String(value);
  }
}

function buildContent(record) {
  if (Array.isArray(record.segments) && record.segments.length) {
    return record.segments.map((s) => s.text).join('').replace(/\s+/g, '');
  }
  return record.desc || record.content || '';
}

module.exports = {
  connect,
  parseUrl,
  getTenantToken,
  listFields,
  createField,
  deleteField,
  ensureFields,
  removeFieldsByName,
  writeRecord,
  FIELD_TYPE
};
