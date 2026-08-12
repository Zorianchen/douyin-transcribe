'use strict';

// HTTPS-over-HTTP-proxy Agent（零依赖）
// 有 HTTPS_PROXY 环境变量就走代理；国内域名（飞书/抖音/DeepSeek等）直连。

const https = require('https');
const http = require('http');
const tls = require('tls');
const { URL } = require('url');

function getProxyUrl() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''
  );
}

class HttpsProxyAgent extends https.Agent {
  constructor(proxyUrl, options = {}) {
    super(options);
    this.proxy = new URL(proxyUrl);
  }

  createConnection(opts, callback) {
    const targetPort = opts.port || 443;
    const targetHost = opts.hostname || opts.host;

    const connectReq = http.request({
      host: this.proxy.hostname,
      port: this.proxy.port || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
        'User-Agent': 'Node.js'
      },
      timeout: 15000
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        callback(new Error(`Proxy CONNECT failed: HTTP ${res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect(
        {
          socket,
          servername: targetHost,
          host: targetHost,
          port: targetPort,
          rejectUnauthorized: true
        },
        () => callback(null, tlsSocket)
      );
      tlsSocket.on('error', (err) => callback(err));
    });

    connectReq.on('error', (err) => callback(err));
    connectReq.on('timeout', () => {
      connectReq.destroy(new Error('Proxy CONNECT timeout'));
    });
    connectReq.end();
  }
}

// 国内域名关键词（直连，不走代理）
const DOMESTIC_KEYWORDS = [
  'feishu.cn', 'larkoffice.com',
  'douyin.com', 'douyinpic.com', 'douyinvod.com', 'bytedance.com', 'toutiao.com', 'ixigua.com',
  'deepseek.com',
  'aliyuncs.com', 'dashscope.aliyun',
  'baidubce.com', 'baidu.com',
  'xf-yun.com', 'xfyun.cn',
  'bigmodel.cn', 'zhipuai.cn',
  'moonshot.cn',
  'minimax.chat', 'minimaxi.com',
  'tencent.com', 'qq.com', 'hunyuan',
  'baichuan-ai.com',
  'coze.cn', 'coze.com',
  'volces.com', 'volcengine.com',
  'siliconflow.cn',
  'yiwen.cloud',
  'sensecore.com',
  '01.ai',
];

function isDomesticHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return DOMESTIC_KEYWORDS.some(k => h === k || h.endsWith('.' + k) || h.includes(k));
}

// 返回代理 agent：有代理配置且目标非国内域名就走代理，否则 null（直连）
let cachedAgent = null;
let cachedProxy = '';

function getProxyAgent(targetHost) {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return null;
  if (targetHost && isDomesticHost(targetHost)) return null;
  if (cachedAgent && cachedProxy === proxyUrl) return cachedAgent;
  cachedAgent = new HttpsProxyAgent(proxyUrl);
  cachedProxy = proxyUrl;
  return cachedAgent;
}

module.exports = { getProxyAgent, getProxyUrl, HttpsProxyAgent, isDomesticHost };
