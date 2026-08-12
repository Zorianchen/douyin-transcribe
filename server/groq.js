'use strict';

// Groq Whisper 转录（verbose_json 带 segments）+ LLM 标点分段

const https = require('https');
const fs = require('fs');
const { URL } = require('url');
const { buildMultipart } = require('./multipart');
const { getProxyAgent } = require('./proxy');
const { AppError, CODES } = require('./errors');

// 支持通过 GROQ_BASE_URL 自定义 API 地址（用于国内服务器通过 Cloudflare Worker 等反代访问）
// 例：GROQ_BASE_URL=https://groq-proxy.yourname.workers.dev
const DEFAULT_GROQ_HOST = 'api.groq.com';
const _base = process.env.GROQ_BASE_URL ? new URL(process.env.GROQ_BASE_URL) : null;
const GROQ_HOST = _base ? _base.hostname : DEFAULT_GROQ_HOST;
const GROQ_PORT = _base && _base.port ? Number(_base.port) : 443;
const WHISPER_MODEL = 'whisper-large-v3';
const PUNCT_MODEL = 'llama-3.3-70b-versatile';

// 通用 Groq POST，返回解析后的 JSON
// 走自定义反代地址时直连（反代本身就是代理方案）；走官方 api.groq.com 时按代理配置决定
function groqPost(pathname, headers, body, timeout) {
  return new Promise((resolve, reject) => {
    // 如果设置了自定义反代地址，直连不走代理；否则按代理配置判断
    const agent = _base ? null : getProxyAgent(GROQ_HOST);
    // 如果走自定义反代且设置了 token，自动注入鉴权头
    const reqHeaders = { ...headers };
    if (_base && process.env.GROQ_PROXY_TOKEN) {
      reqHeaders['x-proxy-token'] = process.env.GROQ_PROXY_TOKEN;
    }
    const opts = {
      host: GROQ_HOST,
      port: GROQ_PORT,
      path: pathname,
      method: 'POST',
      headers: reqHeaders
    };
    if (agent) opts.agent = agent;
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = { raw: text };
        }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy(new Error('Groq 请求超时'));
    });
    if (body) req.write(body);
    req.end();
  });
}

function mapGroqError(status, error) {
  const msg = (error && (error.message || error.type)) || 'Groq 错误';
  if (status === 401 || /api[_ ]?key/i.test(msg)) {
    return new AppError(CODES.GROQ_AUTH);
  }
  if (status === 403) {
    return new AppError(
      CODES.GROQ_ERROR,
      '语音识别服务被拒绝访问（HTTP 403）',
      '可能是当前网络区域受限，请配置 HTTPS_PROXY 代理后重试。'
    );
  }
  if (status === 413 || /too large|maximum/i.test(msg)) {
    return new AppError(CODES.AUDIO_TOO_LARGE);
  }
  if (status === 429) {
    return new AppError(CODES.GROQ_RATE_LIMIT);
  }
  return new AppError(CODES.GROQ_ERROR, msg);
}

/**
 * 转录音频，返回带时间戳的 segments
 * @returns {Promise<{segments:Array, duration:number}>}
 */
async function transcribe(audioPath) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new AppError(CODES.NO_API_KEY);

  const buf = fs.readFileSync(audioPath);
  const fields = [
    { name: 'file', filename: 'audio.mp3', contentType: 'audio/mpeg', buffer: buf },
    { name: 'model', value: WHISPER_MODEL },
    { name: 'language', value: 'zh' },
    { name: 'response_format', value: 'verbose_json' },
    { name: 'temperature', value: '0' }
  ];
  const { body, contentType } = buildMultipart(fields);

  const { status, json } = await groqPost(
    '/openai/v1/audio/transcriptions',
    {
      Authorization: `Bearer ${key}`,
      'Content-Type': contentType,
      'Content-Length': body.length
    },
    body,
    180000
  );

  if (status !== 200 || json.error) {
    throw mapGroqError(status, json.error);
  }

  const segments = (json.segments || [])
    .map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: String(s.text || '').trim()
    }))
    .filter((s) => s.text);

  if (!segments.length && json.text) {
    segments.push({ start: 0, end: Number(json.duration) || 0, text: json.text.trim() });
  }

  return { segments, duration: Number(json.duration) || 0 };
}

/**
 * 为 segments 文本加标点。逐段编号发送，校验行数；失败回退原文。
 * 绝不改变顺序、不增删字。
 * @param {Array<{start:number,end:number,text:string}>} segments
 * @returns {Promise<Array>}
 */
async function punctuateSegments(segments) {
  if (!segments || !segments.length) return segments;

  const key = process.env.GROQ_API_KEY;
  if (!key) return segments;

  // 单段过长则跳过标点（保持原文），避免模型截断
  const items = segments.map((s, i) => ({
    idx: i,
    text: s.text,
    skipped: s.text.length > 1500
  }));

  const numbered = items
    .map((it, i) => `${i + 1}. ${it.text}`)
    .join('\n');

  const payload = {
    model: PUNCT_MODEL,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          '你是一个中文标点修复工具。用户会给你若干带行号的句子（每行格式为"序号. 文本"），这些是语音识别结果，缺少标点。' +
          '要求：1) 只给每行文本补充合适的中文标点；2) 严格保持相同行数、相同顺序、相同序号；' +
          '3) 不增删字词、不合并行、不拆分行、不重排；4) 直接输出结果，每行一条，不要任何解释或额外内容。'
      },
      { role: 'user', content: numbered }
    ]
  };

  let result;
  try {
    const { status, json } = await groqPost(
      '/openai/v1/chat/completions',
      {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      JSON.stringify(payload),
      60000
    );
    if (status !== 200 || json.error) {
      return segments; // 静默回退
    }
    result = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  } catch {
    return segments;
  }

  if (!result) return segments;

  const lines = result
    .split('\n')
    .map((l) => l.replace(/^\s*\d+[\.、)]\s*/, '').trim())
    .filter((l) => l.length > 0);

  // 行数不一致则整体回退原文
  if (lines.length !== items.length) {
    return segments;
  }

  return segments.map((s, i) => ({
    start: s.start,
    end: s.end,
    text: lines[i] || s.text
  }));
}

module.exports = { transcribe, punctuateSegments, chat };

/**
 * 通用对话补全（供智能加工使用）
 * @param {string} system 系统提示词
 * @param {string} user 用户输入
 * @param {object} opts { temperature, timeout, json }
 * @returns {Promise<string>}
 */
async function chat(system, user, opts = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new AppError(CODES.NO_API_KEY);

  const payload = {
    model: PUNCT_MODEL,
    temperature: opts.temperature != null ? opts.temperature : 0.5,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  };
  if (opts.json) {
    payload.response_format = { type: 'json_object' };
  }

  const { status, json } = await groqPost(
    '/openai/v1/chat/completions',
    {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    JSON.stringify(payload),
    opts.timeout || 90000
  );

  if (status !== 200 || json.error) {
    throw mapGroqError(status, json.error);
  }
  return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
}
