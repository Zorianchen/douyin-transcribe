'use strict';

// 统一错误码
const CODES = {
  INVALID_LINK: 'INVALID_LINK',
  DETAIL_FAILED: 'DETAIL_FAILED',
  NO_AUDIO: 'NO_AUDIO',
  AUDIO_FAILED: 'AUDIO_FAILED',
  AUDIO_TOO_LARGE: 'AUDIO_TOO_LARGE',
  NO_API_KEY: 'NO_API_KEY',
  GROQ_AUTH: 'GROQ_AUTH',
  GROQ_RATE_LIMIT: 'GROQ_RATE_LIMIT',
  GROQ_ERROR: 'GROQ_ERROR',
  ASR_AUTH: 'ASR_AUTH',
  ASR_RATE_LIMIT: 'ASR_RATE_LIMIT',
  ASR_ERROR: 'ASR_ERROR',
  ASR_EMPTY: 'ASR_EMPTY',
  TIMEOUT: 'TIMEOUT'
};

// 错误码对应的 HTTP 状态码与默认提示
const META = {
  INVALID_LINK:    { status: 400, message: '链接格式不正确',         hint: '请粘贴包含 v.douyin.com 或 douyin.com/video 的抖音分享文案。' },
  DETAIL_FAILED:   { status: 502, message: '无法获取视频信息',       hint: '视频可能已删除、设为私密，或被反爬拦截。云服务器部署请在 .env 配置 DOUYIN_COOKIE（浏览器登录抖音后复制）。' },
  NO_AUDIO:        { status: 422, message: '该视频没有可识别的音频', hint: '图文/笔记类内容没有语音，已为你展示视频简介文案。' },
  AUDIO_FAILED:    { status: 502, message: '音频提取失败',           hint: '视频可能无音轨或链接已失效，请更换视频重试。' },
  AUDIO_TOO_LARGE: { status: 413, message: '音频过大',               hint: '视频过长或音频过大，请换一条更短的视频。' },
  NO_API_KEY:      { status: 500, message: '未配置语音识别密钥',     hint: '请在服务器 .env 中配置对应 ASR 服务的密钥（如 SILICONFLOW_API_KEY）。' },
  GROQ_AUTH:       { status: 502, message: '语音识别密钥无效',       hint: '请检查 .env 中的识别服务密钥是否正确。' },
  GROQ_RATE_LIMIT: { status: 429, message: '识别服务繁忙',           hint: '请求过于频繁，请稍后再试。' },
  GROQ_ERROR:      { status: 502, message: '语音识别失败',           hint: '识别服务暂时不可用，请稍后重试。' },
  ASR_AUTH:        { status: 502, message: '语音识别密钥无效',       hint: '请检查识别服务的密钥是否正确、账户是否有余额。' },
  ASR_RATE_LIMIT:  { status: 429, message: '识别服务繁忙',           hint: '请求过于频繁或并发超限，请稍后再试。' },
  ASR_ERROR:       { status: 502, message: '语音识别失败',           hint: '识别服务暂时不可用，请稍后重试。' },
  ASR_EMPTY:       { status: 502, message: '语音识别未返回文字',     hint: '硅基流动可能正临时限流（返回了空结果）。请稍候 1~2 分钟再试一次；若频繁出现，请更换有更高语音识别额度的硅基流动 API Key（配置到 .env 的 SILICONFLOW_API_KEY，或改代码里的 SF_K1/SF_K2）。' },
  TIMEOUT:         { status: 504, message: '请求超时',               hint: '处理时间过长，请稍后重试或更换更短的视频。' }
};

class AppError extends Error {
  constructor(code, message, hint, status) {
    const meta = META[code] || {};
    super(message || meta.message || '请求失败');
    this.code = code;
    this.hint = hint || meta.hint || '';
    this.status = status || meta.status || 500;
    this.isAppError = true;
  }
}

module.exports = { AppError, CODES, META };
