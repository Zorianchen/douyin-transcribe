'use strict';

// 历史记录：本地 JSON 文件存储
// 多用户改造：每条记录归属某个 user_id；所有读写均按当前用户隔离，
// 保证"操作与用户数据正确关联、绑定"，且各用户数据互不串台。

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'history.json');
const MAX_ITEMS = 200; // 单用户最多保留 200 条，超出删最旧的

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readAll() {
  ensureDir();
  try {
    if (!fs.existsSync(FILE)) return [];
    const raw = fs.readFileSync(FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeAll(list) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8');
}

// 仅保留属于该用户（或游客）的记录
function scope(all, userId) {
  if (userId == null) return all; // 未指定则不过滤（系统/迁移场景）
  return all.filter((it) => it.user_id === userId);
}

function summary(it) {
  const preview = Array.isArray(it.segments) && it.segments.length
    ? it.segments.map((s) => s.text).join('').replace(/\s+/g, '').slice(0, 80)
    : (it.desc || '').slice(0, 80);
  const analysis = it.analysis || {};
  return {
    id: it.id,
    video_id: it.video_id,
    title: it.title,
    author: it.author,
    duration: it.duration,
    source: it.source,
    word_count: it.word_count,
    preview,
    // 标记哪些 AI 分析已生成
    has_analysis: {
      quotes: !!analysis.quotes,
      structure: !!analysis.structure,
      xiaohongshu: !!analysis.xiaohongshu,
      gongzhonghao: !!analysis.gongzhonghao,
      pains: !!analysis.pains,
      topics: !!analysis.topics,
      outline: !!analysis.outline,
      highlights: !!analysis.highlights,
      extension: !!analysis.extension
    },
    feishu: it.feishu || null,
    report_ready: !!it.report_ready,
    created_at: it.created_at
  };
}

// 列表（摘要，不含完整 segments，省流量）—— 按用户隔离
function list(userId) {
  return scope(readAll(), userId).map(summary);
}

// 按关键词搜索标题/作者/正文，返回摘要列表 —— 按用户隔离
function search(keyword, userId) {
  const all = scope(readAll(), userId);
  if (!keyword || !String(keyword).trim()) return list(userId);
  const kw = String(keyword).toLowerCase();
  return all
    .filter((it) => {
      const hay = [it.title, it.author, it.desc, (it.segments || []).map((s) => s.text).join(' ')]
        .join(' ')
        .toLowerCase();
      return hay.includes(kw);
    })
    .map(summary);
}

// 获取单条完整记录 —— 校验归属（userId 提供时必须是本人）
function get(id, userId) {
  const it = readAll().find((x) => x.id === id) || null;
  if (!it) return null;
  if (userId != null && it.user_id !== userId) return null;
  return it;
}

// 新增（同一 video_id 已存在则覆盖更新）；记录归属 user_id
function add(result, userId) {
  const all = readAll();
  const now = new Date().toISOString();
  const id = result.video_id || result.aweme_id || ('t_' + Date.now());

  const existing = all.find((it) => it.id === id);
  const record = {
    id,
    user_id: userId || null,
    video_id: result.video_id,
    aweme_id: result.aweme_id,
    title: result.title || '',
    author: result.author || '',
    duration: result.duration || 0,
    desc: result.desc || '',
    source: result.source || 'asr',
    word_count: result.word_count || 0,
    share_url: result.share_url || '',
    segments: Array.isArray(result.segments) ? result.segments : [],
    // AI 分析结果（金句/结构/小红书/公众号/痛点/选题），增量合并
    analysis: (existing && existing.analysis) || {},
    // 飞书上传状态
    feishu: (existing && existing.feishu) || null,
    created_at: now
  };

  const idx = all.findIndex((it) => it.id === id);
  if (idx >= 0) {
    record.created_at = all[idx].created_at; // 保留首次提取时间
    record.user_id = all[idx].user_id || record.user_id; // 保留原归属
    all[idx] = record;
  } else {
    all.unshift(record);
  }

  // 超量裁剪（按用户维度）
  const mine = all.filter((it) => it.user_id === (userId || null));
  if (mine.length > MAX_ITEMS) {
    const overflow = new Set(mine.slice(MAX_ITEMS).map((it) => it.id));
    const trimmed = all.filter((it) => !overflow.has(it.id));
    writeAll(trimmed);
    return record;
  }

  writeAll(all);
  return record;
}

function remove(id, userId) {
  const all = readAll();
  const target = all.find((it) => it.id === id);
  if (!target) return false;
  if (userId != null && target.user_id !== userId) return false; // 非本人不可删
  const next = all.filter((it) => it.id !== id);
  writeAll(next);
  return all.length !== next.length;
}

function clear(userId) {
  const all = readAll();
  const next = all.filter((it) => it.user_id !== userId);
  writeAll(next);
  return true;
}

// 更新某条记录的 AI 分析结果（增量合并：key -> result 文本）
function updateAnalysis(id, patch, userId) {
  const all = readAll();
  const idx = all.findIndex((it) => it.id === id);
  if (idx < 0) return null;
  if (userId != null && all[idx].user_id !== userId) return null;
  all[idx].analysis = Object.assign({}, all[idx].analysis || {}, patch);
  writeAll(all);
  return all[idx].analysis;
}

// 更新某条记录的飞书上传状态
function updateFeishu(id, status, userId) {
  const all = readAll();
  const idx = all.findIndex((it) => it.id === id);
  if (idx < 0) return null;
  if (userId != null && all[idx].user_id !== userId) return null;
  all[idx].feishu = status;
  writeAll(all);
  return all[idx].feishu;
}

// 标记某条记录已生成报告（后台自动生成完成后调用，文案库卡片据此显示"查看报告"）
function markReportReady(id, userId) {
  const all = readAll();
  const idx = all.findIndex((it) => it.id === id);
  if (idx < 0) return null;
  if (userId != null && all[idx].user_id !== userId) return null;
  all[idx].report_ready = true;
  writeAll(all);
  return all[idx];
}

// 游客数据迁移：把没有归属的历史记录（升级前的全局数据）绑定给首位注册用户
// 返回迁移条数
function migrateGuestToUser(userId) {
  const all = readAll();
  let n = 0;
  for (const it of all) {
    if (!it.user_id) {
      it.user_id = userId;
      n++;
    }
  }
  if (n) writeAll(all);
  return n;
}

module.exports = {
  list,
  search,
  get,
  add,
  remove,
  clear,
  updateAnalysis,
  updateFeishu,
  markReportReady,
  migrateGuestToUser
};
