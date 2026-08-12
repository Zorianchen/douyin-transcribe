'use strict';

// 主编排：链接 → 详情 → 字幕优先 / ASR 兜底 → 统一响应

const path = require('path');
const fs = require('fs');
const { getVideoDetail } = require('./douyin');
const { pickSubtitleUrl, fetchAndNormalize, isSubtitleValid } = require('./subtitles');
const { extractAudio } = require('./audio');
const { transcribe, punctuateSegments } = require('./asr');
const { safeUnlink } = require('./clean');
const { AppError, CODES } = require('./errors');

const TEMP_DIR = path.join(__dirname, '..', 'temp');

function countChars(segments) {
  if (!Array.isArray(segments)) return 0;
  return segments
    .map((s) => s.text || '')
    .join('')
    .replace(/\s/g, '').length;
}

function buildMeta(detail) {
  return {
    video_id: detail.video_id,
    aweme_id: detail.aweme_id,
    title: detail.title,
    author: detail.author,
    duration: detail.duration || 0,
    desc: detail.desc || '',
    share_url: detail.video_id ? ('https://www.douyin.com/video/' + detail.video_id) : ''
  };
}

/**
 * 提取抖音视频文字稿
 * @param {string} input 用户粘贴的链接或整段分享文案
 * @returns {Promise<Object>}
 */
async function transcribeDouyin(input, apiKey) {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  // 1. 获取视频详情
  const detail = await getVideoDetail(input);

  // 2. 图文 / 笔记（无播放地址）：直接用文案
  if (detail.is_note || !detail.play_addr) {
    const segText = detail.desc || '';
    return {
      ...buildMeta(detail),
      source: 'note',
      segments: segText
        ? [{ start: 0, end: detail.duration || 0, text: segText }]
        : [],
      word_count: segText.replace(/\s/g, '').length
    };
  }

  // 3. 官方字幕优先
  const subUrl = pickSubtitleUrl(detail.subtitle_infos);
  if (subUrl) {
    try {
      const segments = await fetchAndNormalize(subUrl);
      if (isSubtitleValid(segments)) {
        return {
          ...buildMeta(detail),
          source: 'subtitle',
          segments,
          word_count: countChars(segments)
        };
      }
    } catch {
      // 字幕拉取失败，回退 ASR
    }
  }

  // 4. 无字幕或字幕无效 → ffmpeg 提音频 → Whisper 识别
  let audioResult;
  try {
    audioResult = await extractAudio(detail.play_addr, TEMP_DIR);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(CODES.AUDIO_FAILED, '提取音频失败：' + e.message);
  }

  try {
    const { segments: rawSegments } = await transcribe(audioResult.file, apiKey);
    const segments = await punctuateSegments(rawSegments);

    return {
      ...buildMeta(detail),
      source: 'asr',
      segments,
      word_count: countChars(segments)
    };
  } finally {
    safeUnlink(audioResult.file);
  }
}

module.exports = { transcribeDouyin, TEMP_DIR };
