'use strict';

// 鉴权模块：无状态签名 Cookie 令牌（HMAC-SHA256）
// - 不依赖 cookie-parser / jsonwebtoken，仅用 Node 内置 crypto
// - 签名密钥持久化到 data/.session-secret（重启后仍有效）
// - Cookie 设为 HttpOnly，前端无法用 JS 读取，降低 XSS 窃取风险

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const users = require('./users');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SECRET_FILE = path.join(DATA_DIR, '.session-secret');
const COOKIE_NAME = 'dtoken';
const MAX_AGE = 7 * 24 * 3600 * 1000; // 令牌有效期 7 天

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getSecret() {
  ensureDir();
  try {
    if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  } catch {}
  return s;
}

const SECRET = getSecret();

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function sign(payload) {
  const data = b64url(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return data + '.' + sig;
}

function generateToken(uid) {
  const payload = { uid, iat: Date.now(), exp: Date.now() + MAX_AGE };
  return sign(payload);
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(sig);
    expBuf = Buffer.from(expected);
  } catch {
    return null;
  }
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload.uid;
  } catch {
    return null;
  }
}

// 从请求头手动解析 Cookie（无需 cookie-parser）
function parseCookies(req) {
  const hdr = req.headers && req.headers.cookie;
  const out = {};
  if (!hdr) return out;
  hdr.split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i < 0) return;
    const k = c.slice(0, i).trim();
    const v = c.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function setAuthCookie(res, uid) {
  const token = generateToken(uid);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE,
    secure: process.env.COOKIE_SECURE === '1'
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function getCurrentUid(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies[COOKIE_NAME]);
}

// 必须登录，否则 401
function requireAuth(req, res, next) {
  const uid = getCurrentUid(req);
  if (!uid) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请先登录' } });
  }
  req.userId = uid;
  next();
}

// 可选登录：能识别就挂上 req.userId，否则放行
function attachUser(req, res, next) {
  req.userId = getCurrentUid(req) || null;
  next();
}

// 必须为系统拥有者（System Owner），否则 401（未登录）或 403（非拥有者）
function requireSystemOwner(req, res, next) {
  const uid = getCurrentUid(req);
  if (!uid) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请先登录' } });
  }
  const u = users.findById(uid);
  if (!u || !u.is_admin) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '仅系统拥有者可访问' } });
  }
  req.userId = uid;
  next();
}

module.exports = {
  COOKIE_NAME,
  MAX_AGE,
  generateToken,
  verifyToken,
  setAuthCookie,
  clearAuthCookie,
  getCurrentUid,
  requireAuth,
  attachUser,
  requireSystemOwner
};
