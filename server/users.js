'use strict';

// 用户账户存储：本地 JSON 文件，使用 Node 内置 crypto.scrypt 做密码哈希
// 不引入额外依赖，数据文件位于 data/users.json

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'users.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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

// 密码哈希：随机盐 + scrypt
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}

// 校验密码：恒定时间比较，防止时序攻击
function verifyPassword(pw, salt, hash) {
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 系统拥有者（System Owner）用户名（可选环境变量指定，优先级最高）
function getSystemOwnerName() {
  return (process.env.SYSTEM_OWNER || '').trim().toLowerCase();
}

// 对外暴露的用户信息（永不返回密码/盐/哈希）
function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email || '',
    created_at: u.created_at,
    is_admin: !!u.is_admin
  };
}

// 入参校验，返回错误数组（空数组表示通过）
function validate({ username, password, email }) {
  const errs = [];
  const uname = username == null ? '' : String(username).trim();
  if (!uname) errs.push('用户名不能为空');
  else {
    if (uname.length < 3 || uname.length > 20) errs.push('用户名需 3-20 个字符');
    if (!/^[一-龥\w.\-]+$/.test(uname)) errs.push('用户名仅支持中英文、数字、下划线、点、连字符');
  }
  if (password == null || !String(password)) errs.push('密码不能为空');
  else if (String(password).length < 6) errs.push('密码至少 6 位');
  if (email) {
    const e = String(email).trim();
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) errs.push('邮箱格式不正确');
  }
  return errs;
}

function count() {
  return readAll().length;
}

// 创建用户。返回 { user } 或 { error }
function create({ username, password, email }) {
  const errs = validate({ username, password, email });
  if (errs.length) return { error: errs.join('；') };

  const uname = String(username).trim();
  const all = readAll();
  if (all.some((u) => u.username.toLowerCase() === uname.toLowerCase())) {
    return { error: '用户名已存在' };
  }

  const { salt, hash } = hashPassword(password);
  // 系统拥有者判定：注册前若无任何用户 → 首位即系统拥有者；或通过 SYSTEM_OWNER 环境变量指定
  const isFirst = all.length === 0;
  const designated = getSystemOwnerName();
  const isAdmin = isFirst || (designated && uname.toLowerCase() === designated);
  const user = {
    id: 'u_' + crypto.randomBytes(8).toString('hex'),
    username: uname,
    email: email ? String(email).trim() : '',
    salt,
    hash,
    is_admin: isAdmin,
    created_at: new Date().toISOString()
  };
  all.push(user);
  writeAll(all);
  return { user: publicUser(user) };
}

function findByUsername(username) {
  if (!username) return null;
  const uname = String(username).trim().toLowerCase();
  return readAll().find((u) => u.username.toLowerCase() === uname) || null;
}

function findById(id) {
  return readAll().find((u) => u.id === id) || null;
}

// 是否为系统拥有者
function isSystemOwner(uid) {
  const u = findById(uid);
  return !!(u && u.is_admin);
}

// 列出全部用户（脱敏：不含密码/盐/哈希），供系统拥有者用户管理视图使用
function listAll() {
  return readAll().map(publicUser);
}

// 启动时调用：若系统中尚无任何系统拥有者，则将注册最早的用户任命为系统拥有者
// 用于兼容历史数据（升级前已注册的用户不含 is_admin 标记）
function ensureSystemOwner() {
  const all = readAll();
  if (!all.length) return null;
  const existing = all.find((u) => u.is_admin);
  if (existing) return existing;
  // 环境变量指定优先
  const designated = getSystemOwnerName();
  if (designated) {
    const target = all.find((u) => u.username.toLowerCase() === designated);
    if (target) {
      target.is_admin = true;
      writeAll(all);
      console.log('[users] 已将', target.username, '设为系统拥有者（SYSTEM_OWNER 指定）');
      return target;
    }
  }
  // 否则取注册时间最早者
  const earliest = all.reduce((a, b) => (a.created_at <= b.created_at ? a : b));
  earliest.is_admin = true;
  writeAll(all);
  console.log('[users] 已将最早注册用户', earliest.username, '任命为系统拥有者');
  return earliest;
}

// 校验登录凭证，返回 { user } 或 { error }
function verify(username, password) {
  const u = findByUsername(username);
  if (!u) return { error: '用户名或密码错误' };
  if (!verifyPassword(password, u.salt, u.hash)) return { error: '用户名或密码错误' };
  return { user: publicUser(u) };
}

// 修改密码：校验旧密码正确后，生成新盐+新哈希写入
// 返回 { ok: true } 或 { error: '...' }
function changePassword(id, oldPassword, newPassword) {
  // 仅校验密码规则，不校验用户名
  if (!newPassword || String(newPassword).length < 6) return { error: '新密码至少 6 位' };
  if (String(newPassword).length > 100) return { error: '新密码过长' };
  if (oldPassword && String(oldPassword) === String(newPassword)) {
    return { error: '新密码不能与旧密码相同' };
  }
  const all = readAll();
  const idx = all.findIndex((u) => u.id === id);
  if (idx === -1) return { error: '用户不存在' };
  const u = all[idx];
  if (!verifyPassword(oldPassword, u.salt, u.hash)) return { error: '旧密码不正确' };
  const { salt, hash } = hashPassword(newPassword);
  all[idx] = { ...u, salt, hash };
  writeAll(all);
  return { ok: true };
}

// 删除用户（返回被删除的用户信息，或 { error }）
// 注意：不清理关联数据（history/profile/config），由调用方按需处理
function remove(id) {
  const all = readAll();
  const idx = all.findIndex((u) => u.id === id);
  if (idx === -1) return { error: '用户不存在' };
  const u = all[idx];
  // 不允许删除系统拥有者
  if (u.is_admin) return { error: '不能删除系统拥有者' };
  all.splice(idx, 1);
  writeAll(all);
  return { user: publicUser(u) };
}

module.exports = { create, verify, findByUsername, findById, count, validate, publicUser, isSystemOwner, listAll, ensureSystemOwner, changePassword, remove };
