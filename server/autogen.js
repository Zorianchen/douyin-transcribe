'use strict';

// 转写完成后，后台自动串行生成全部 AI 加工模块（含报告 5 模块）
// 结果通过 history.updateAnalysis 持久化，文案库/飞书同步可直接使用

const { processText, ACTIONS } = require('./process');
const history = require('./history');
const configStore = require('./configStore');

const running = new Set();

// 报告由这 5 个 AI 模块组合而成（与前端 REPORT_MODULES 保持一致）
const REPORT_MODULES_KEYS = ['outline', 'topics', 'pains', 'highlights', 'extension'];

async function autoGenerate(videoId, ai = null) {
  if (!videoId) return;
  const cfgAi = ai || configStore.defaultConfig().ai;
  if (cfgAi.auto_generate === false) return; // 设置里可关闭
  if (running.has(videoId)) return; // 防重复
  running.add(videoId);
  console.log('[autogen] 开始后台生成:', videoId);
  try {
    for (const key of Object.keys(ACTIONS)) {
      const rec = history.get(videoId);
      if (!rec) break;
      if (rec.analysis && rec.analysis[key]) continue; // 已有结果跳过
      try {
        const out = await processText(key, rec, cfgAi);
        history.updateAnalysis(videoId, { [key]: out.result });
        console.log('[autogen]', videoId, key, '✓');
      } catch (e) {
        console.warn('[autogen]', videoId, key, '失败:', e.message);
        // 密钥/配置类错误直接终止，避免 9 个模块重复失败
        if (/密钥|api.?key|401|unauthorized|鉴权/i.test(e.message || '')) {
          console.warn('[autogen] 疑似 AI 配置问题，终止本次自动生成');
          break;
        }
      }
    }
    // 全部报告模块已就绪则标记，文案库卡片据此显示"查看报告"
    const rec = history.get(videoId);
    if (rec && rec.analysis) {
      const hasAll = REPORT_MODULES_KEYS.every((k) => rec.analysis[k]);
      if (hasAll) history.markReportReady(videoId);
    }
  } finally {
    running.delete(videoId);
    console.log('[autogen] 结束:', videoId);
  }
}

// 异步触发，不阻塞主流程；ai 为对应用户的 AI 配置（不传则用默认）
function trigger(videoId, ai = null) {
  setImmediate(() => {
    autoGenerate(videoId, ai).catch((e) => console.warn('[autogen] 异常:', e.message));
  });
}

module.exports = { trigger };
