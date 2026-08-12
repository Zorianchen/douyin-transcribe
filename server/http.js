'use strict';

// 内置 https/http 的 Promise 封装：超时、跟随重定向、文本/Buffer/自动 JSON

const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) EdgiOS/121.0.2277.107 Version/17.0 Mobile/15E148 Safari/604.1';

function pick(urlStr) {
  return new URL(urlStr).protocol === 'http:' ? http : https;
}

/**
 * @typedef {Object} RequestOptions
 * @property {string} [method]
 * @property {Object} [headers]
 * @property {string|Buffer} [body]
 * @property {number} [timeout] 毫秒
 * @property {'auto'|'text'|'buffer'} [responseType]
 * @property {number} [maxRedirects]
 * @property {boolean} [json] 请求体按 JSON 发送并设置 content-type
 */

/**
 * 发起 HTTP 请求
 * @param {string} url
 * @param {RequestOptions} [options]
 * @returns {Promise<{status:number, headers:Object, body:any}>}
 */
function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = 15000,
    responseType = 'auto',
    maxRedirects = 5
  } = options;

  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = pick(url);
    const opts = {
      method,
      headers: { 'User-Agent': DEFAULT_UA, ...headers }
    };

    const req = client.request(url, opts, (res) => {
      const status = res.statusCode || 0;
      // 跟随重定向
      if (status >= 300 && status < 400 && res.headers.location && maxRedirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(request(next, { ...options, maxRedirects: maxRedirects - 1 }));
        return;
      }

      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let out = buf;
        if (responseType !== 'buffer') {
          const text = buf.toString('utf-8');
          if (responseType === 'text') {
            out = text;
          } else {
            // auto: 按 content-type 或首字符判断 JSON
            const ct = (res.headers['content-type'] || '').toLowerCase();
            const looksJson = ct.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('[');
            if (looksJson) {
              try { out = JSON.parse(text); } catch { out = text; }
            } else {
              out = text;
            }
          }
        }
        resolve({ status, headers: res.headers, body: out });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy(new Error('请求超时'));
    });

    if (body != null) {
      if (Buffer.isBuffer(body) || typeof body === 'string') {
        req.write(body);
      } else {
        req.write(JSON.stringify(body));
      }
    }
    req.end();
  });
}

/**
 * 仅获取短链重定向后的最终 URL（不下载 body）
 */
function resolveLocation(url, timeout = 10000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const client = pick(url);
    const req = client.request(
      url,
      { method: 'GET', headers: { 'User-Agent': DEFAULT_UA, ...extraHeaders } },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve(new URL(res.headers.location, url).toString());
        } else {
          res.resume();
          resolve(url);
        }
      }
    );
    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy(new Error('解析短链超时'));
    });
    req.end();
  });
}

module.exports = { request, resolveLocation, DEFAULT_UA };
