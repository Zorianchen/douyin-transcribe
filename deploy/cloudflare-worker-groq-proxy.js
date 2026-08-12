/**
 * Cloudflare Worker — Groq API 反向代理
 * 免费版每天 10 万次请求，足够个人使用
 *
 * 部署步骤：
 * 1. 注册/登录 Cloudflare → Workers & Pages → Create Worker
 * 2. 把这段代码粘进去，部署
 * 3. 拿到 Worker 地址（类似 https://groq-proxy.xxx.workers.dev）
 * 4. 在国内服务器的 .env 文件里加一行：
 *    GROQ_BASE_URL=https://groq-proxy.xxx.workers.dev
 * 5. 重启服务即可
 *
 * 可选安全增强（推荐）：
 * 在 Worker 设置里加环境变量 AUTH_TOKEN（随便一串长字符），
 * 然后在 .env 里也加 GROQ_PROXY_TOKEN=同样的字符，
 * 这样只有你自己的服务器能调这个 Worker。
 */

const ALLOWED_HEADERS = [
  'authorization',
  'content-type',
  'content-length',
  'accept',
  'user-agent',
];

export default {
  async fetch(request, env) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-proxy-token',
        },
      });
    }

    // 只允许 POST
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Token 鉴权（如果设置了 AUTH_TOKEN）
    if (env.AUTH_TOKEN) {
      const auth = request.headers.get('x-proxy-token');
      if (auth !== env.AUTH_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
    }

    const url = new URL(request.url);
    const targetUrl = 'https://api.groq.com' + url.pathname + url.search;

    // 转发请求头（只保留必要的）
    const fwdHeaders = new Headers();
    for (const h of ALLOWED_HEADERS) {
      const v = request.headers.get(h);
      if (v) fwdHeaders.set(h, v);
    }

    // 转发请求体
    const body = await request.arrayBuffer();

    const resp = await fetch(targetUrl, {
      method: 'POST',
      headers: fwdHeaders,
      body,
    });

    // 返回响应，加上 CORS 头
    const respHeaders = new Headers(resp.headers);
    respHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
    });
  },
};
