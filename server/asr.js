'use strict';

// ASR 统一入口：根据 ASR_PROVIDER 环境变量选择语音识别服务
// - siliconflow（推荐）：硅基流动 SenseVoiceSmall，国内直连，完全免费
// - tencent：腾讯云录音文件识别极速版，国内直连，每月5小时免费
// - groq：Groq Whisper，需海外网络或代理
//
// 所有 provider 都导出相同接口：
//   transcribe(audioPath) → { segments, duration }
//   punctuateSegments(segments) → segments

const provider = (process.env.ASR_PROVIDER || 'siliconflow').toLowerCase();

let mod;
if (provider === 'groq') {
  mod = require('./groq');
} else if (provider === 'tencent') {
  mod = require('./asr-tencent');
} else {
  mod = require('./asr-siliconflow');
}

module.exports = {
  provider,
  transcribe: mod.transcribe,
  punctuateSegments: mod.punctuateSegments
};
