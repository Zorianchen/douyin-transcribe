'use strict';

// 用户个人资料与配置存储
// - data/profiles.json：按 user_id 索引，每个用户一份配置
// - 首次注册/登录时自动创建默认配置（由 index.js 调用 ensureInitialized）
// - 支持用户自行补充：联系方式、个性化选项、关联账户等
// - 数据结构可扩展：custom_fields 存放任意键值对
// - 飞书/AI 配置不在此模块（归 configStore.js 管理），由用户自行添加

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'profiles.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readAll() {
  ensureDir();
  try {
    if (!fs.existsSync(FILE)) return {};
    const raw = fs.readFileSync(FILE, 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch {
    return {};
  }
}

function writeAll(data) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

// 默认配置模板（新用户首次初始化时使用）
function defaultProfile(userId, username) {
  const now = new Date().toISOString();
  return {
    user_id: userId,
    display_name: username || '',
    avatar: '',                    // 头像 URL 或 base64（预留）
    role: 'user',                  // 角色：user | admin（预留扩展）
    // 偏好设置
    preferences: {
      theme: 'auto',               // auto | light | dark
      language: 'zh-CN',
      notifications: {
        email: false,              // 邮件通知
        browser: true              // 浏览器内通知
      },
      auto_generate_ai: true       // 转写后自动生成 AI 分析
    },
    // 联系方式（用户自行填写，注册时不要求）
    contact: {
      email: '',
      phone: '',
      wechat: '',
      bio: ''                      // 个人简介
    },
    // 可扩展的自定义字段（用于未来新增配置项，无需改表结构）
    custom_fields: {},
    created_at: now,
    updated_at: now
  };
}

// 获取用户资料（不存在返回 null）
function getProfile(userId) {
  if (!userId) return null;
  const all = readAll();
  const p = all[userId];
  return p ? structuredClone(p) : null;
}

// 创建默认资料（幂等：已存在则跳过并返回现有）
function createDefaultProfile(userId, username) {
  if (!userId) return null;
  const all = readAll();
  if (all[userId]) return structuredClone(all[userId]); // 已存在，直接返回

  const profile = defaultProfile(userId, username);
  all[userId] = profile;
  writeAll(all);
  console.log('[profile] 已为用户', username || userId, '创建默认配置');
  return structuredClone(profile);
}

// 更新用户资料（部分更新，只覆盖传入的字段）
function updateProfile(userId, patch) {
  if (!userId) { throw new Error('缺少 user_id'); }
  const all = readAll();
  if (!all[userId]) { throw new Error('用户资料不存在，请先初始化'); }

  const profile = all[userId];

  // 一级字段直接覆盖（display_name, avatar, role 等）
  for (const [key, val] of Object.entries(patch || {})) {
    if (key === 'user_id' || key === 'created_at') continue; // 不允许修改 ID 和创建时间
    if (val === undefined || val === null) continue;

    if (
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof profile[key] === 'object' &&
      !Array.isArray(profile[key])
    ) {
      // 对象类型深度合并（preferences, contact, custom_fields）
      Object.assign(profile[key], val);
    } else {
      profile[key] = val;
    }
  }

  profile.updated_at = new Date().toISOString();
  all[userId] = profile;
  writeAll(all);
  return structuredClone(profile);
}

// 确保用户已初始化（未初始化则自动创建默认配置）
// 返回 { initialized: bool, profile: object|null }
function ensureInitialized(userId, username) {
  if (!userId) return { initialized: false, profile: null };
  const existing = getProfile(userId);
  if (existing) return { initialized: true, profile: existing };
  const profile = createDefaultProfile(userId, username);
  return { initialized: false, profile };
}

// 删除用户资料（注销用，一般不调用）
function deleteProfile(userId) {
  if (!userId) return false;
  const all = readAll();
  if (!all[userId]) return false;
  delete all[userId];
  writeAll(all);
  return true;
}

module.exports = {
  getProfile,
  createDefaultProfile,
  updateProfile,
  ensureInitialized,
  deleteProfile,
  defaultProfile,
  FILE
};
