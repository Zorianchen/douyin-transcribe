'use strict';

// 硅基流动（SiliconFlow）语音识别 - 完全免费
// 文档：https://docs.siliconflow.cn/cn/api-reference/audio/create-audio-transcriptions
//
// 特点：
// - FunAudioLLM/SenseVoiceSmall 模型免费使用
// - API 格式与 OpenAI/Groq 完全兼容（/v1/audio/transcriptions）
// - 国内直连（api.siliconflow.cn）
// - 自带中文标点
// - 不返回分段时间戳 → 用 ffmpeg 切块获取近似时间戳
// - 限制：单文件 50MB / 1小时

const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { buildMultipart } = require('./multipart');
const { getProxyAgent } = require('./proxy');
const { AppError, CODES } = require('./errors');

const HOST = 'api.siliconflow.cn';
const MODEL = process.env.SILICONFLOW_MODEL || 'FunAudioLLM/SenseVoiceSmall';
const CHUNK_SECONDS = 30; // 切块时长（秒），用于生成时间戳

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function cleanEnv() {
  const env = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  return env;
}

// SenseVoice 会在文本中插入 <|HAPPY|>、<|Speech|> 等标签，并在末尾追加情感 emoji（😊😔😠😰等）
// 清理掉这些非文本内容
function cleanSenseVoiceText(text) {
  if (!text) return '';
  return String(text)
    .replace(/<\|[^|]*\|>/g, '')                   // <|HAPPY|>、<|Speech|>、<|BGM|> 等标签
    .replace(/[\u{1F600}-\u{1F64F}\u{1F900}-\u{1F9FF}]\s*$/gu, '') // 末尾的情感 emoji
    .trim();
}

// 获取音频时长（秒）
function probeDuration(file) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file];
    const p = spawn(FFPROBE, args, { timeout: 30000, env: cleanEnv() });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', (code) => {
      if (code === 0) {
        const n = parseFloat(out.trim());
        resolve(Number.isFinite(n) ? n : 0);
      } else {
        resolve(0);
      }
    });
    p.on('error', () => resolve(0));
  });
}

// 用 ffmpeg 将音频切成固定时长的小块
function splitAudio(inputPath, chunkDir, chunkSeconds) {
  return new Promise((resolve, reject) => {
    const pattern = path.join(chunkDir, 'chunk_%04d.mp3');
    const args = [
      '-y', '-nostdin', '-loglevel', 'error',
      '-i', inputPath,
      '-f', 'segment',
      '-segment_time', String(chunkSeconds),
      '-c:a', 'libmp3lame', '-q:a', '4',
      '-ar', '16000', '-ac', '1',
      pattern
    ];
    const p = spawn(FFMPEG, args, { timeout: 120000, env: cleanEnv() });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error('ffmpeg 切块失败 (code ' + code + '): ' + err));
      }
      const files = fs.readdirSync(chunkDir)
        .filter((f) => f.startsWith('chunk_') && f.endsWith('.mp3'))
        .sort();
      resolve(files.map((f) => path.join(chunkDir, f)));
    });
    p.on('error', reject);
  });
}

// 调用硅基流动 API 识别单个音频块
function transcribeChunk(audioPath, apiKey) {
  return new Promise((resolve, reject) => {
    const buf = fs.readFileSync(audioPath);
    const fields = [
      { name: 'file', filename: 'audio.mp3', contentType: 'audio/mpeg', buffer: buf },
      { name: 'model', value: MODEL }
    ];
    const { body, contentType } = buildMultipart(fields);

    const agent = getProxyAgent(HOST);
    const opts = {
      host: HOST,
      port: 443,
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': contentType,
        'Content-Length': body.length
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
          return reject(new AppError(CODES.ASR_ERROR, '硅基流动返回解析失败：' + text.slice(0, 200)));
        }
        if (res.statusCode !== 200) {
          const msg = (json.error && (json.error.message || json.error.type)) || ('HTTP ' + res.statusCode);
          if (res.statusCode === 401) {
            return reject(new AppError(CODES.ASR_AUTH, '硅基流动 API Key 无效：' + msg));
          }
          if (res.statusCode === 429) {
            return reject(new AppError(CODES.ASR_RATE_LIMIT, '硅基流动请求超限：' + msg));
          }
          return reject(new AppError(CODES.ASR_ERROR, '硅基流动识别失败：' + msg));
        }
        resolve(cleanSenseVoiceText(json.text));
      });
    });
    req.on('error', (e) => {
      reject(new AppError(CODES.ASR_ERROR, '硅基流动请求失败：' + e.message));
    });
    req.setTimeout(60000, () => req.destroy(new Error('硅基流动请求超时')));
    req.write(body);
    req.end();
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 单次完整识别（不含重试）。
 * 硅基流动在限流时会返回 HTTP 200 但 text 为空，这里把「空」当作可能的限流，
 * 交由外层 transcribe() 做整体重试。
 * @returns {Promise<{segments:Array, duration:number}>}
 */
async function transcribeOnce(audioPath, apiKey) {
  const totalDuration = await probeDuration(audioPath);

  // 短音频（<=35秒）直接整段发送，不需要切块
  if (totalDuration > 0 && totalDuration <= CHUNK_SECONDS + 5) {
    const text = await transcribeChunk(audioPath, apiKey);
    return {
      segments: text ? [{ start: 0, end: totalDuration, text }] : [],
      duration: totalDuration
    };
  }

  // 长音频：切块分别识别
  const chunkDir = path.join(path.dirname(audioPath), 'chunks_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(chunkDir, { recursive: true });

  try {
    const chunkFiles = await splitAudio(audioPath, chunkDir, CHUNK_SECONDS);
    const segments = [];
    let offset = 0;

    for (let i = 0; i < chunkFiles.length; i++) {
      const chunkDur = await probeDuration(chunkFiles[i]);
      const text = await transcribeChunk(chunkFiles[i], apiKey);
      if (text) {
        segments.push({
          start: Math.round(offset * 1000) / 1000,
          end: Math.round((offset + (chunkDur || CHUNK_SECONDS)) * 1000) / 1000,
          text
        });
      }
      offset += chunkDur || CHUNK_SECONDS;
    }

    return { segments, duration: totalDuration || offset };
  } finally {
    // 清理切块临时文件
    try {
      const files = fs.readdirSync(chunkDir);
      for (const f of files) {
        try { fs.unlinkSync(path.join(chunkDir, f)); } catch {}
      }
      fs.rmdirSync(chunkDir);
    } catch {}
  }
}

/**
 * 转录音频，返回带时间戳的 segments
 * @param {string} audioPath 本地音频文件路径（mp3）
 * @param {string} [apiKey] 可选，优先使用示例传入的硅基流动 API Key；缺省时回退环境变量 SILICONFLOW_API_KEY
 * @returns {Promise<{segments:Array, duration:number}>}
 */
async function transcribe(audioPath, apiKey) {
  const key = apiKey || process.env.SILICONFLOW_API_KEY;
  if (!key) {
    throw new AppError(
      CODES.NO_API_KEY,
      '未配置硅基流动 API Key',
      '请在「设置 → 语音识别（硅基流动）」中填写硅基流动 API Key 并保存。'
    );
  }

  // 硅基流动限流时会返回 HTTP 200 但 text 为空，整体重试以规避瞬时限流
  const MAX_TRIES = 3;
  let lastResult = null;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    lastResult = await transcribeOnce(audioPath, apiKey);
    if (lastResult.segments.length > 0) {
      return lastResult;
    }
    if (attempt < MAX_TRIES) {
      await delay(3000 * attempt); // 指数退避：3s、6s
    }
  }

  throw new AppError(
    CODES.ASR_EMPTY,
    '语音识别未返回任何文字',
    '硅基流动可能正临时限流（返回了空结果）。请稍候 1~2 分钟再试一次；若频繁出现，请更换有更高语音识别额度的硅基流动 API Key（配置到 .env 的 SILICONFLOW_API_KEY，或改代码里的 SF_K1/SF_K2）。'
  );
}

/**
 * 标点分段：SenseVoice 自带标点，直接返回
 */
async function punctuateSegments(segments) {
  return segments;
}

module.exports = { transcribe, punctuateSegments };
