'use strict';

// 抖音官方字幕的选择、拉取与多格式归一化

const { request } = require('./http');

function pickSubtitleUrl(subInfos) {
  if (!Array.isArray(subInfos) || !subInfos.length) return null;

  // 优先中文字幕
  const zh = subInfos.find((s) => {
    const lang = String(
      s.LanguageCode || s.language_code || s.LanguageID || s.language || s.name || ''
    );
    return /zh|chinese|cn|sc|tc/i.test(lang) || /[\u4e00-\u9fa5]/.test(s.name || '');
  });

  // 其次 srt/vtt 格式
  const fmt = subInfos.find((s) => {
    const f = String(s.Format || s.format || s.type || '').toLowerCase();
    return f.includes('srt') || f.includes('vtt');
  });

  const cand = zh || fmt || subInfos.find((s) => s.Url || s.url) || subInfos[0];
  let u = cand.Url || cand.url || cand.SubtitleUrl || cand.subtitle_url;
  if (!u) return null;

  // 处理编码与协议
  try {
    u = decodeURIComponent(u);
  } catch {
    /* 可能未编码 */
  }
  if (u.startsWith('//')) u = 'https:' + u;
  else if (u.startsWith('http:')) u = 'https:' + u.slice(5);
  return u;
}

// 解析时间为秒
function toSec(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  // HH:MM:SS.mmm 或 MM:SS.mmm
  const t = s.match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/);
  if (t) {
    const h = parseInt(t[1] || '0', 10);
    const m = parseInt(t[2], 10);
    const sec = parseInt(t[3], 10);
    const ms = parseInt((t[4] + '000').slice(0, 3), 10);
    return h * 3600 + m * 60 + sec + ms / 1000;
  }
  const n = Number(s);
  if (!Number.isNaN(n)) return n;
  return null;
}

// 从字幕元素中取文本
function pickText(it) {
  return (
    it.text ||
    it.content ||
    it.utterance ||
    it.Text ||
    it.Content ||
    it.sentence ||
    ''
  )
    .toString()
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

// 解析 SRT / VTT 纯文本字幕
function parseTextSubtitle(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const timeRe =
    /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(timeRe);
    if (!m) {
      i++;
      continue;
    }
    const start =
      parseInt(m[1] || '0', 10) * 3600 +
      parseInt(m[2], 10) * 60 +
      parseInt(m[3], 10) +
      parseInt((m[4] + '000').slice(0, 3), 10) / 1000;
    const end =
      parseInt(m[5] || '0', 10) * 3600 +
      parseInt(m[6], 10) * 60 +
      parseInt(m[7], 10) +
      parseInt((m[8] + '000').slice(0, 3), 10) / 1000;

    const textLines = [];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].match(timeRe)) {
      textLines.push(lines[i]);
      i++;
    }
    const t = textLines.join('\n').trim();
    if (t) out.push({ start, end, text: t });
  }
  return out;
}

function normalizeSubtitle(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t[0] === '{' || t[0] === '[') {
      try {
        data = JSON.parse(t);
      } catch {
        return parseTextSubtitle(t);
      }
    } else {
      return parseTextSubtitle(t);
    }
  }

  // 探测数组容器
  let arr =
    (data &&
      (data.snippets ||
        data.snippet ||
        data.utterances ||
        data.Utterances ||
        data.body ||
        data.data ||
        data.subtitles ||
        data.lines)) ||
    (Array.isArray(data) ? data : []);

  if (!Array.isArray(arr)) {
    if (data && typeof data === 'object') arr = [data];
    else arr = [];
  }

  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const text = pickText(it);
    if (!text) continue;

    let start = toSec(it.start ?? it.start_time ?? it.from ?? it.begin ?? it.timestamp);
    let end = toSec(it.end ?? it.end_time ?? it.to ?? it.stop);

    if (start == null) continue;

    // 毫秒判断
    if (start > 1000) start = start / 1000;
    if (end != null && end > 1000) end = end / 1000;

    if (end == null || end < start) {
      const dur = toSec(it.duration ?? it.Duration);
      if (dur != null) {
        end = start + (dur > 1000 ? dur / 1000 : dur);
      } else {
        end = start + 2;
      }
    }

    out.push({ start: +start.toFixed(3), end: +end.toFixed(3), text });
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

// 判断字幕是否有效（非空、非纯音乐标记）
function isSubtitleValid(segments) {
  if (!Array.isArray(segments) || !segments.length) return false;
  const full = segments.map((s) => s.text).join('').replace(/\s/g, '');
  if (full.length < 4) return false;

  const musicMarkers = /(音乐|配乐|original sound|BGM|♪|♫|\[音乐\]|音乐声|纯音乐)/i;
  let musicHits = 0;
  for (const s of segments) {
    if (musicMarkers.test(s.text)) musicHits++;
  }
  if (segments.length >= 3 && musicHits / segments.length > 0.8) return false;

  return true;
}

async function fetchAndNormalize(url) {
  const { body } = await request(url, {
    headers: { Referer: 'https://www.douyin.com/' },
    timeout: 15000,
    responseType: 'auto'
  });
  return normalizeSubtitle(body);
}

module.exports = {
  pickSubtitleUrl,
  fetchAndNormalize,
  normalizeSubtitle,
  isSubtitleValid
};
