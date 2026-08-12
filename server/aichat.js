'use strict';

// 统一 AI 对话：用户配置的硅基流动（SiliconFlow，OpenAI 兼容接口）
// 供智能加工（金句/结构/小红书/公众号/痛点/选题）调用

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { getProxyAgent } = require('./proxy');
const configStore = require('./configStore');

/**
 * 通用对话补全
 * @param {string} system 系统提示词
 * @param {string} user 用户输入
 * @param {object} opts { temperature, timeout, json }
 * @returns {Promise<string>}
 */
async function chat(system, user, opts = {}, ai = null) {
  // 不传 ai 时使用默认配置（默认已配置硅基流动）
  const cfgAi = ai || configStore.defaultConfig().ai;

  // 未启用或配置不完整 → 明确报错，不再回退 Groq
  if (!cfgAi.enabled || !cfgAi.api_key || !cfgAi.base_url || !cfgAi.model) {
    throw new Error('未配置 AI 模型：请在「设置 → AI 模型（硅基流动）」中填写硅基流动 API Key 并保存');
  }

  return chatCustom(cfgAi, system, user, opts);
}

async function chatCustom(ai, system, user, opts) {
  const payload = {
    model: ai.model,
    temperature: opts.temperature != null ? opts.temperature : (ai.temperature != null ? ai.temperature : 0.6),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  };
  if (opts.json) payload.response_format = { type: 'json_object' };

  // 解析 base_url，兼容末尾带/不带 /chat/completions
  let base = (ai.base_url || '').replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(base)) base += '/chat/completions';

  const url = new URL(base);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  const body = JSON.stringify(payload);
  // getProxyAgent 会自动判断：国内 API（DeepSeek/飞书/通义等）直连，海外 API 走代理
  const agent = isHttps ? getProxyAgent(url.hostname) : undefined;

  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + ai.api_key,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    if (agent) reqOpts.agent = agent;

    const req = lib.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = { raw: text }; }
        if (res.statusCode !== 200) {
          const msg = (json.error && (json.error.message || json.error.type)) || ('HTTP ' + res.statusCode);
          return reject(new Error(msg));
        }
        const content =
          json.choices &&
          json.choices[0] &&
          json.choices[0].message &&
          json.choices[0].message.content;
        if (!content) return reject(new Error('AI 返回内容为空'));
        resolve(String(content).trim());
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 90000, () => req.destroy(new Error('AI 请求超时')));
    req.write(body);
    req.end();
  });
}

/**
 * 测试自定义 AI 配置是否可用
 */
async function testCustom(ai = null) {
  const cfgAi = ai || configStore.defaultConfig().ai;
  if (!cfgAi.enabled || !cfgAi.api_key || !cfgAi.base_url || !cfgAi.model) {
    return { ok: false, message: '未启用 AI 模型或配置不完整（请先填写硅基流动 API Key）' };
  }
  try {
    const reply = await chatCustom(
      cfgAi,
      '你是一个测试助手，只回复"OK"两个字母。',
      '请回复OK',
      { temperature: 0, timeout: 20000 }
    );
    return { ok: true, message: '连接成功', reply: reply.slice(0, 50) };
  } catch (e) {
    return { ok: false, message: e.message || '连接失败' };
  }
}

module.exports = { chat, testCustom };
