'use strict';

// 腾讯云语音识别 - 录音文件识别极速版
// 文档：https://cloud.tencent.com/document/api/1093/52097
//
// 特点：
// - 直接 POST 音频二进制数据（不需要 OSS/URL）
// - 同步返回结果（30分钟音频约10秒）
// - 自带中文标点（16k_zh_en 大模型引擎）
// - 返回 sentence_list 带毫秒级时间戳
// - 支持 mp3/wav/m4a/aac 等格式，最大 100MB，最长 2 小时

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const { getProxyAgent } = require('./proxy');
const { AppError, CODES } = require('./errors');

const HOST = 'asr.cloud.tencent.com';
const PATH_PREFIX = '/asr/flash/v1/';

// 引擎类型：16k_zh_en 是中英粤大模型引擎，自带标点，准确率最高
const ENGINE_TYPE = process.env.TENCENT_ASR_ENGINE || '16k_zh_en';
const VOICE_FORMAT = 'mp3';

/**
 * 生成腾讯云 ASR 签名
 * 签名原文：POSTasr.cloud.tencent.com/asr/flash/v1/<appid>?<排序后的query参数>
 * 算法：HMAC-SHA1(签名原文, SecretKey) → Base64
 */
function sign(appid, secretId, secretKey, params) {
  // 按 key 字典序排序
  const sortedKeys = Object.keys(params).sort();
  const pairs = sortedKeys
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => `${k}=${params[k]}`);
  const queryString = pairs.join('&');

  const signStr = `POST${HOST}${PATH_PREFIX}${appid}?${queryString}`;
  const hmac = crypto.createHmac('sha1', secretKey);
  hmac.update(signStr, 'utf8');
  return hmac.digest('base64');
}

/**
 * 映射腾讯云错误码到 AppError
 */
function mapTencentError(code, message) {
  const msg = message || '腾讯云 ASR 错误';
  switch (code) {
    case 4001:
      return new AppError(CODES.ASR_ERROR, '请求参数不合法：' + msg);
    case 4002:
      return new AppError(CODES.ASR_AUTH, '腾讯云 ASR 鉴权失败：' + msg,
        '请检查 TENCENT_APP_ID / TENCENT_SECRET_ID / TENCENT_SECRET_KEY 是否正确，且系统时间是否准确。');
    case 4003:
      return new AppError(CODES.ASR_ERROR, '腾讯云 ASR 服务未开通：' + msg,
        '请前往腾讯云语音识别控制台开通服务。');
    case 4004:
      return new AppError(CODES.ASR_RATE_LIMIT, '腾讯云 ASR 资源包耗尽：' + msg,
        '请开通后付费或购买资源包。');
    case 4005:
      return new AppError(CODES.ASR_ERROR, '腾讯云账户欠费：' + msg,
        '请及时充值。');
    case 4006:
      return new AppError(CODES.ASR_RATE_LIMIT, '腾讯云 ASR 并发超限：' + msg,
        '请稍后重试。');
    case 4007:
      return new AppError(CODES.AUDIO_FAILED, '音频解码失败：' + msg,
        '请检查音频格式是否正确。');
    case 4011:
      return new AppError(CODES.AUDIO_TOO_LARGE, '音频数据太大：' + msg);
    case 4012:
      return new AppError(CODES.NO_AUDIO, '音频数据为空');
    case 5001:
    case 5002:
    case 5003:
      return new AppError(CODES.ASR_ERROR, '腾讯云 ASR 识别失败（' + code + '）：' + msg,
        '服务端偶发错误，请稍后重试。');
    default:
      return new AppError(CODES.ASR_ERROR, '腾讯云 ASR 错误（' + code + '）：' + msg);
  }
}

/**
 * 转录音频，返回带时间戳的 segments
 * @param {string} audioPath 本地音频文件路径（mp3）
 * @returns {Promise<{segments:Array, duration:number}>}
 */
async function transcribe(audioPath) {
  const appId = process.env.TENCENT_APP_ID;
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;

  if (!appId || !secretId || !secretKey) {
    throw new AppError(
      CODES.NO_API_KEY,
      '未配置腾讯云 ASR 密钥',
      '请在 .env 中配置 TENCENT_APP_ID、TENCENT_SECRET_ID、TENCENT_SECRET_KEY。'
    );
  }

  const buf = fs.readFileSync(audioPath);
  if (!buf || buf.length === 0) {
    throw new AppError(CODES.NO_AUDIO);
  }

  const timestamp = Math.floor(Date.now() / 1000);

  // 构建请求参数
  const params = {
    appid: appId,
    secretid: secretId,
    engine_type: ENGINE_TYPE,
    voice_format: VOICE_FORMAT,
    timestamp: String(timestamp),
    convert_num_mode: '1',
    filter_dirty: '0',
    filter_modal: '0',
    filter_punc: '0',
    first_channel_only: '1',
    speaker_diarization: '0',
    word_info: '0'
  };

  // 计算签名
  const signature = sign(appId, secretId, secretKey, params);

  // 构建 URL query string
  const sortedKeys = Object.keys(params).sort();
  const pairs = sortedKeys
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => `${k}=${encodeURIComponent(params[k])}`);
  const queryString = pairs.join('&');
  const path = PATH_PREFIX + appId + '?' + queryString;

  // 国内地址直连
  const agent = getProxyAgent(HOST);

  return new Promise((resolve, reject) => {
    const opts = {
      host: HOST,
      port: 443,
      path: path,
      method: 'POST',
      headers: {
        Host: HOST,
        Authorization: signature,
        'Content-Type': 'application/octet-stream',
        'Content-Length': buf.length
      }
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
          return reject(new AppError(CODES.ASR_ERROR, '腾讯云 ASR 返回解析失败：' + text.slice(0, 200)));
        }

        if (json.code !== 0) {
          return reject(mapTencentError(json.code, json.message));
        }

        // 解析结果
        const flashResult = (json.flash_result && json.flash_result[0]) || {};
        const sentenceList = flashResult.sentence_list || [];

        // 毫秒 → 秒，与 Groq Whisper 格式统一
        const segments = sentenceList
          .map((s) => ({
            start: (Number(s.start_time) || 0) / 1000,
            end: (Number(s.end_time) || 0) / 1000,
            text: String(s.text || '').trim()
          }))
          .filter((s) => s.text);

        if (!segments.length && flashResult.text) {
          segments.push({
            start: 0,
            end: (Number(json.audio_duration) || 0) / 1000,
            text: flashResult.text.trim()
          });
        }

        const duration = (Number(json.audio_duration) || 0) / 1000;
        resolve({ segments, duration });
      });
    });

    req.on('error', (e) => {
      reject(new AppError(CODES.ASR_ERROR, '腾讯云 ASR 请求失败：' + e.message));
    });

    req.setTimeout(120000, () => {
      req.destroy(new Error('腾讯云 ASR 请求超时'));
    });

    req.write(buf);
    req.end();
  });
}

/**
 * 标点分段：腾讯云 16k_zh_en 大模型引擎自带中文标点，无需额外 LLM 处理
 * 此函数保留接口兼容性，直接返回原 segments
 */
async function punctuateSegments(segments) {
  return segments;
}

module.exports = { transcribe, punctuateSegments };
