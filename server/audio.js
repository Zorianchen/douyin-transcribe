'use strict';

// ffmpeg 远程提取抖音视频音频为 16k 单声道 mp3

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { AppError, CODES } = require('./errors');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// 默认清除代理环境变量，避免系统开了 Clash 但代理没运行时 ffmpeg 连死代理超时。
// 若配置了 DOUYIN_PROXY，则改由 downloadEnv() 注入，让 ffmpeg 经代理下载抖音 CDN，
// 用于绕过云服务器数据中心 IP 被抖音 CDN 403 拦截的问题。
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

// 给 ffmpeg 下载抖音视频用的环境变量：在 cleanEnv 基础上按需注入 DOUYIN_PROXY
function downloadEnv() {
  const env = cleanEnv();
  const dyProxy = (process.env.DOUYIN_PROXY || '').trim();
  if (dyProxy) {
    if (/^socks5?:\/\//i.test(dyProxy)) {
      // SOCKS 代理：ffmpeg 通过 socks_proxy 环境变量识别
      env.socks_proxy = dyProxy;
      env.SOCKS_PROXY = dyProxy;
    } else {
      // HTTP/HTTPS 代理：ffmpeg 对 https 目标走 CONNECT 隧道
      env.HTTP_PROXY = dyProxy;
      env.HTTPS_PROXY = dyProxy;
      env.http_proxy = dyProxy;
      env.https_proxy = dyProxy;
    }
  }
  return env;
}

// 用 ffprobe 获取时长（秒）
function probeDuration(file) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      file
    ];
    const p = spawn(FFPROBE, args, { timeout: 30000, env: cleanEnv() });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
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

// 重新转码为更低码率（用于接近 25MB 限制时）
function reencodeLowBitrate(src) {
  return new Promise((resolve, reject) => {
    const out = src.replace(/\.mp3$/, '_low.mp3');
    const args = [
      '-y', '-nostdin', '-loglevel', 'error',
      '-i', src,
      '-vn', '-ar', '16000', '-ac', '1',
      '-c:a', 'libmp3lame', '-b:a', '48k',
      out
    ];
    const p = spawn(FFMPEG, args, { timeout: 120000, env: cleanEnv() });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(out)) {
        try { fs.unlinkSync(src); } catch {}
        resolve(out);
      } else {
        reject(new AppError(CODES.AUDIO_FAILED, '音频压缩失败'));
      }
    });
    p.on('error', (e) => reject(e));
  });
}

/**
 * 从抖音无水印视频 URL 提取音频
 * @param {string} playAddr 无水印播放地址
 * @param {string} tempDir 临时目录
 * @returns {Promise<{file:string, duration:number}>}
 */
async function extractAudio(playAddr, tempDir) {
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const out = path.join(
    tempDir,
    `audio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`
  );

  // 抖音 CDN 下载同样可能校验 Cookie（云服务器 IP 易被拦截）。
  // DOUYIN_PROXY 配置后，ffmpeg 会经代理出口下载，绕过 403。
  const dyCookie = (process.env.DOUYIN_COOKIE || '').trim();
  const dlHeaders = 'Referer: https://www.douyin.com/\r\n' +
    (dyCookie ? 'Cookie: ' + dyCookie + '\r\n' : '');

  const args = [
    '-y',
    '-nostdin',
    '-loglevel', 'error',
    '-headers', dlHeaders,
    '-i', playAddr,
    '-vn',
    '-ar', '16000',
    '-ac', '1',
    '-c:a', 'libmp3lame',
    '-q:a', '4',
    '-t', '7200', // 硬上限 2 小时（腾讯云极速版上限）
    out
  ];

  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { timeout: 180000, env: downloadEnv() });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => {
      if (code === 0) return resolve();
      reject(
        new AppError(
          CODES.AUDIO_FAILED,
          'ffmpeg 提取音频失败 (code ' + code + ')',
          '视频可能无音轨或链接已失效，请更换视频重试。若服务器在云上被抖音 CDN 拦截，请在 .env 配置 DOUYIN_PROXY。'
        )
      );
    });
    p.on('error', (e) => {
      if (e && e.code === 'ENOENT') {
        reject(new AppError(CODES.AUDIO_FAILED, '未找到 ffmpeg，请确认已安装并加入 PATH'));
      } else {
        reject(e);
      }
    });
  });

  if (!fs.existsSync(out) || fs.statSync(out).size < 1024) {
    throw new AppError(CODES.NO_AUDIO);
  }

  // 腾讯云极速版限制 100MB，留余量 95MB；超出则压缩到低码率
  const MAX = 95 * 1024 * 1024;
  let finalFile = out;
  if (fs.statSync(out).size > MAX) {
    finalFile = await reencodeLowBitrate(out);
    if (fs.statSync(finalFile).size > MAX) {
      try { fs.unlinkSync(finalFile); } catch {}
      throw new AppError(CODES.AUDIO_TOO_LARGE);
    }
  }

  const duration = await probeDuration(finalFile);
  return { file: finalFile, duration };
}

module.exports = { extractAudio, probeDuration };
