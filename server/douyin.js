'use strict';

// 抖音链接解析与视频详情抓取（三级降级）
// 移植并增强自 douyin-downloader-nodejs/douyin.js

const { request, resolveLocation } = require('./http');
const { AppError, CODES } = require('./errors');

// 抖音反爬：数据中心 IP（云服务器）容易被拦截，带登录 Cookie 可显著提高成功率
// 在 .env 配置 DOUYIN_COOKIE 后，所有抖音请求都会携带
function dyHeaders(referer) {
  const h = {
    Referer: referer,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  };
  const ck = (process.env.DOUYIN_COOKIE || '').trim();
  if (ck) h.Cookie = ck;
  return h;
}

// 从整段分享文案中提取抖音链接
const LINK_RE =
  /https?:\/\/(v\.douyin\.com\/[^\s]+|(?:www\.)?iesdouyin\.com\/share\/(?:video|note)\/\d+[^\s]*|(?:www\.)?douyin\.com\/(?:video|note)\/\d+[^\s]*)/i;

function parseInput(text) {
  const m = (text || '').match(LINK_RE);
  if (!m) {
    throw new AppError(CODES.INVALID_LINK);
  }
  let url = m[0];
  // 去掉尾部中英文标点/空白
  url = url.replace(/[）)】」』。，、；：！？\s]+$/, '');
  return url;
}

function extractVideoId(url) {
  let m = url.match(/\/video\/(\d+)/);
  if (m) return m[1];
  m = url.match(/\/share\/video\/(\d+)/);
  if (m) return m[1];
  return null;
}

function isNoteUrl(url) {
  return /\/note\/(\d+)/.test(url);
}

// 把接口返回的 item 归一化为统一结构
function normalizeItem(item, videoId, isNote) {
  if (!item) return null;
  const video = item.video || {};

  let playAddr = null;
  const addr = video.play_addr || video.download_addr || {};
  const list = addr.url_list || [];
  if (list.length) {
    playAddr = list[0].replace('playwm', 'play');
  } else if (video.play_addr_h264 && video.play_addr_h264.url_list) {
    playAddr = video.play_addr_h264.url_list[0].replace('playwm', 'play');
  }
  if (playAddr && playAddr.startsWith('//')) playAddr = 'https:' + playAddr;

  let duration = 0;
  if (video.duration != null) {
    const n = Number(video.duration);
    duration = n > 1000 ? n / 1000 : n;
  }

  const desc = item.desc || '';
  const subtitleInfos =
    video.subtitleInfos || video.subtitle_infos || video.video_subtitle || [];

  const awemeId = item.aweme_id || videoId;

  return {
    video_id: awemeId,
    aweme_id: awemeId,
    desc,
    title: (desc || `douyin_${awemeId}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80),
    author: (item.author && (item.author.nickname || item.author.unique_id)) || '未知作者',
    duration,
    play_addr: playAddr,
    is_note: !!isNote,
    subtitle_infos: Array.isArray(subtitleInfos) ? subtitleInfos : []
  };
}

// 方法0：第三方解析 API（2026-08 抖音反爬升级，自建方法全部失效后的主通道）
// 默认用 bugpk 公共解析接口，可通过 .env DOUYIN_PARSE_API 换成自建/其他服务
// 设 DOUYIN_PARSE_API=off 可完全关闭此通道
async function tryThirdParty(shareUrl, videoId, isNote) {
  const apiBase = (process.env.DOUYIN_PARSE_API !== undefined
    ? process.env.DOUYIN_PARSE_API
    : 'https://api.bugpk.com/api/douyin?url=').trim();
  if (!apiBase || apiBase === 'off') return null;

  const { body, status } = await request(apiBase + encodeURIComponent(shareUrl), {
    timeout: 20000,
    responseType: 'auto'
  });
  if (status !== 200 || !body || body.code !== 200 || !body.data) return null;

  const d = body.data;
  const isVideo = d.type === 'video' && d.url;
  if (!isVideo && !(d.images && d.images.length)) return null;

  const desc = d.desc || d.title || '';
  const awemeId = String(d.video_id || videoId || '');
  return {
    video_id: awemeId,
    aweme_id: awemeId,
    desc,
    title: (desc || `douyin_${awemeId}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80),
    author: (d.author && d.author.name) || '未知作者',
    duration: d.duration ? Number(d.duration) / 1000 : 0,
    play_addr: isVideo ? d.url : null,
    is_note: !isVideo,
    subtitle_infos: []
  };
}

// 方法1：移动端 share SSR（最可靠，2026 年仍可用）
// https://www.iesdouyin.com/share/video/<id>/ 的 window._ROUTER_DATA 含完整 item
async function tryShareSSR(videoId, isNote) {
  const kind = isNote ? 'note' : 'video';
  const url = `https://www.iesdouyin.com/share/${kind}/${videoId}/`;
  const { body, status } = await request(url, {
    headers: dyHeaders('https://www.iesdouyin.com/'),
    timeout: 15000,
    responseType: 'text'
  });
  if (status !== 200 || typeof body !== 'string') return null;

  const m = body.match(/window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/);
  if (!m) return null;

  let json;
  try {
    json = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const loader = (json && json.loaderData) || json;

  // 移动端 share 页：video_(id)/page 或 note_(id)/page
  const page =
    (loader && loader['video_(id)/page']) ||
    (loader && loader['note_(id)/page']) ||
    null;

  const itemList = page && page.videoInfoRes && page.videoInfoRes.item_list;
  if (itemList && itemList.length) {
    return normalizeItem(itemList[0], videoId, isNote);
  }
  return null;
}

// 方法2：iesdouyin iteminfo（旧接口，部分视频仍可用）
async function tryIesdouyin(videoId) {
  const url = `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${videoId}`;
  const { body, status } = await request(url, {
    headers: dyHeaders('https://www.iesdouyin.com/'),
    timeout: 15000,
    responseType: 'auto'
  });
  if (status === 200 && body && body.item_list && body.item_list.length) {
    return normalizeItem(body.item_list[0], videoId, false);
  }
  return null;
}

// 方法3：douyin web detail（可能需要 a_bogus 签名，作为最后降级）
async function tryDouyinDetail(videoId) {
  const url = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${videoId}`;
  const { body, status } = await request(url, {
    headers: dyHeaders('https://www.douyin.com/'),
    timeout: 15000,
    responseType: 'auto'
  });
  if (status === 200 && body) {
    const item = body.aweme_detail || body;
    if (item && item.video) {
      return normalizeItem(item, videoId, false);
    }
  }
  return null;
}

// 在对象中递归查找含 video.play_addr 的对象（用于 RENDER_DATA）
function findVideoData(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;
  if (obj.video && (obj.video.play_addr || obj.video.download_addr)) return obj;
  for (const key of Object.keys(obj)) {
    const found = findVideoData(obj[key], depth + 1);
    if (found) return found;
  }
  return null;
}

// 方法3：解析页面 SSR 数据
async function trySSR(videoId, isNote) {
  const pageUrl = `https://www.douyin.com/${isNote ? 'note' : 'video'}/${videoId}`;
  const { body, status } = await request(pageUrl, {
    headers: dyHeaders('https://www.douyin.com/'),
    timeout: 15000,
    responseType: 'text'
  });
  if (status !== 200 || typeof body !== 'string') return null;

  let item = null;

  // _ROUTER_DATA
  const m1 = body.match(/window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/);
  if (m1) {
    try {
      const json = JSON.parse(m1[1]);
      const loader = json.loaderData || json;
      item =
        (loader['video_(id)/page'] && loader['video_(id)/page'].videoInfoRes &&
          loader['video_(id)/page'].videoInfoRes.item_list &&
          loader['video_(id)/page'].videoInfoRes.item_list[0]) ||
        (loader['note_(id)/page'] && loader['note_(id)/page'].videoInfoRes &&
          loader['note_(id)/page'].videoInfoRes.item_list &&
          loader['note_(id)/page'].videoInfoRes.item_list[0]) ||
        null;
    } catch {
      /* ignore */
    }
  }

  // RENDER_DATA
  if (!item) {
    const m2 = body.match(
      /<script id="RENDER_DATA" type="application\/json">([\s\S]*?)<\/script>/
    );
    if (m2) {
      try {
        const renderData = JSON.parse(decodeURIComponent(m2[1]));
        item = findVideoData(renderData);
      } catch {
        /* ignore */
      }
    }
  }

  if (item) return normalizeItem(item, videoId, isNote);
  return null;
}

/**
 * 从用户输入（链接或整段分享文案）获取视频详情
 * @param {string} input
 * @returns {Promise<Object>} 归一化后的视频详情
 */
async function getVideoDetail(input) {
  let shareUrl = parseInput(input);
  const noteFromInput = isNoteUrl(shareUrl);
  const errors = [];

  // 0) 第三方解析 API 优先：能直接处理短链，无需先解析 videoId（短链重定向也可能被拦）
  try {
    const detail0 = await tryThirdParty(shareUrl, null, noteFromInput);
    if (detail0) {
      if (noteFromInput && !detail0.play_addr) detail0.is_note = true;
      return detail0;
    }
  } catch (e) {
    errors.push('third-party: ' + e.message);
  }

  // 以下自建方法都需要 videoId
  let videoId = extractVideoId(shareUrl);

  // 短链：跟随重定向
  if (!videoId && shareUrl.includes('v.douyin.com')) {
    shareUrl = await resolveLocation(shareUrl, 10000, dyHeaders('https://www.douyin.com/'));
    videoId = extractVideoId(shareUrl);
  }

  if (!videoId) {
    // note 链接没有 /video/ id，但可能在重定向后出现；尝试从 URL 抓 note id
    const noteMatch = shareUrl.match(/\/note\/(\d+)/);
    if (noteMatch) {
      videoId = noteMatch[1];
    } else {
      throw new AppError(CODES.INVALID_LINK, '无法从链接中提取视频 ID');
    }
  }

  const isNote = noteFromInput || isNoteUrl(shareUrl);

  let detail = null;

  // 1) 移动端 share SSR
  if (!detail) {
    try {
      detail = await tryShareSSR(videoId, isNote);
    } catch (e) {
      errors.push('share-ssr: ' + e.message);
    }
  }

  // 2) iesdouyin iteminfo（旧接口）
  if (!detail) {
    try {
      detail = await tryIesdouyin(videoId);
    } catch (e) {
      errors.push('iesdouyin: ' + e.message);
    }
  }

  // 3) douyin web detail（可能需 a_bogus 签名）
  if (!detail) {
    try {
      detail = await tryDouyinDetail(videoId);
    } catch (e) {
      errors.push('detail: ' + e.message);
    }
  }

  // 4) PC 页面 SSR（兜底，新页面多为 SPA 空壳）
  if (!detail) {
    try {
      detail = await trySSR(videoId, isNote);
    } catch (e) {
      errors.push('ssr: ' + e.message);
    }
  }

  if (!detail) {
    if (errors.length) console.warn('[douyin] 所有解析方法失败:', errors.join(' | '));
    throw new AppError(
      CODES.DETAIL_FAILED,
      '无法解析视频信息',
      '视频可能已删除、设为私密，或被反爬拦截。云服务器部署请在 .env 配置 DOUYIN_COOKIE 或 DOUYIN_PARSE_API。'
    );
  }

  // 若确定是 note 且无播放地址，标记为图文
  if (isNote && !detail.play_addr) {
    detail.is_note = true;
  }

  return detail;
}

module.exports = { getVideoDetail, parseInput, extractVideoId, LINK_RE };
