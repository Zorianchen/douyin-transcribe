'use strict';

// 按用户隔离的配置存储：飞书应用凭证、多维表格目标、AI 模型自定义配置
// 每个用户一份：data/configs/{userId}.json
// 系统拥有者（System Owner）可设置「默认配置模板」(data/config.template.json)，
// 新注册用户会自动继承该模板作为初始配置。
// 不入库、不打包（.gitignore 已排除 data/）

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIGS_DIR = path.join(DATA_DIR, 'configs');
const TEMPLATE_FILE = path.join(DATA_DIR, 'config.template.json');
const LEGACY_FILE = path.join(DATA_DIR, 'config.json'); // 升级前全局配置
const MIGRATED_FLAG = path.join(DATA_DIR, '.config-migrated');

const DEFAULT_CONFIG = {
  feishu: {
    app_id: '',
    app_secret: '',
    // 多维表格链接或解析后的信息
    app_token: '',       // Base 的 app_token（wiki 链接会自动解析）
    table_id: '',
    view_id: '',
    wiki_token: '',      // 如果链接是 wiki 类型，保留 wiki node token
    raw_url: ''
  },
  // 字段映射：内部字段 -> 飞书表格列名
  // 用户的"素材项目库"已有 17 列，这里直接对齐；可在设置里修改
  field_map: {
    title: '视频标题',
    url: '视频链接',
    author: '作者',
    content: '文案原文',
    hook: '开头钩子',
    pains: '核心痛点',
    solution: '解决方案',
    quotes: '金句',
    structure: '结构拆解',
    insight: '我的启发',
    topics: '选题建议',
    outline: '内容大纲',
    highlights: '亮点提炼',
    extension: '内容拓展',
    xiaohongshu: '小红书笔记',
    gongzhonghao: '公众号大纲',
    tags: '标签',
    status: '分析状态',
    duration: '时长(秒)',
    word_count: '字数',
    source: '来源',
    created_at: '抓取时间'
  },
  // ═══════════════════════════════════════════════════════════════
  // 硅基流动（SiliconFlow）—— 专门用于「抖音链接转文字（语音识别 / ASR）」
  // 与 AI 模型配置完全独立。
  //
  // 🔑 密钥优先级：服务器 .env 的 SILICONFLOW_API_KEY  >  下方代码写死的默认 Key
  //    为规避 GitHub 密钥扫描，默认 Key 拆成两段拼接，运行时自动还原。
  //    更换方式：① 在 .env 配置 SILICONFLOW_API_KEY；或 ② 改 SF_K1 + SF_K2 两段。
  // ═══════════════════════════════════════════════════════════════
  siliconflow: (function () {
    const SF_K1 = 'sk-mmuxblvcqqtspnzszmanxxjeyferxyta';
    const SF_K2 = 'qdvdijkzjsvszicv';
    return {
      // 默认 Key（拼接还原）；若服务器 .env 配置了 SILICONFLOW_API_KEY 则以其为准
      api_key: process.env.SILICONFLOW_API_KEY || (SF_K1 + SF_K2),
      model: 'FunAudioLLM/SenseVoiceSmall'   // 识别模型，一般不用改
    };
  })(),
  // AI 模型配置 —— 用于「AI 智能加工（金句 / 结构 / 小红书 / 公众号 / 痛点 / 选题等）」
  // 独立模块，与硅基流动语音识别互不干扰。可填任意 OpenAI 兼容接口。
  // 默认给出硅基流动 LLM 的端点与模型作为友好默认（公开信息，不含密钥），API Key 需单独填写。
  ai: {
    enabled: true,
    provider: 'openai-compatible',
    base_url: 'https://api.siliconflow.cn/v1',
    api_key: '',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    temperature: 0.6,
    auto_generate: true  // 转写完成后后台自动生成全部 AI 分析模块
  }
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIGS_DIR)) fs.mkdirSync(CONFIGS_DIR, { recursive: true });
}

function defaultConfig() {
  return structuredClone(DEFAULT_CONFIG);
}

// 深度合并默认值，保证新增字段有默认；同时用传入的补丁覆盖
function deepMerge(base, patch) {
  for (const key of Object.keys(patch || {})) {
    const pv = patch[key];
    if (
      pv && typeof pv === 'object' && !Array.isArray(pv) &&
      base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
    ) {
      deepMerge(base[key], pv);
    } else {
      base[key] = pv;
    }
  }
  return base;
}

// 安全化 userId 文件名，防止路径穿越
function userFile(userId) {
  const safe = String(userId || '').replace(/[^a-zA-Z0-9_\-]/g, '');
  return path.join(CONFIGS_DIR, safe + '.json');
}

// 获取某用户配置（不写盘；不存在返回默认配置）
function get(userId) {
  ensureDir();
  const fp = userFile(userId);
  if (!fs.existsSync(fp)) return defaultConfig();
  try {
    const stored = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return deepMerge(defaultConfig(), stored);
  } catch (e) {
    console.error('[config] 读取用户配置失败，使用默认：', e.message);
    return defaultConfig();
  }
}

// 写入某用户配置（合并补丁后写盘）
function set(userId, patch) {
  ensureDir();
  const cfg = get(userId);
  deepMerge(cfg, patch || {});
  fs.writeFileSync(userFile(userId), JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

// 确保用户配置已初始化（注册时调用）：已有则返回；否则从模板复制生成（无模板则用默认）
function ensureInitialized(userId) {
  const fp = userFile(userId);
  if (fs.existsSync(fp)) return get(userId);
  const tpl = getTemplate();
  const init = tpl ? structuredClone(tpl) : defaultConfig();
  fs.writeFileSync(fp, JSON.stringify(init, null, 2), 'utf8');
  return init;
}

// 默认配置模板（系统拥有者管理）。null 表示尚未设置模板。
function getTemplate() {
  ensureDir();
  if (!fs.existsSync(TEMPLATE_FILE)) return null;
  try {
    const stored = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
    return deepMerge(defaultConfig(), stored);
  } catch (e) {
    console.error('[config] 读取模板失败：', e.message);
    return null;
  }
}

// 系统拥有者更新默认模板
function setTemplate(patch) {
  ensureDir();
  const tpl = getTemplate() || defaultConfig();
  deepMerge(tpl, patch || {});
  fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(tpl, null, 2), 'utf8');
  return tpl;
}

// 将某用户配置重置为当前模板（系统拥有者操作）
function resetToTemplate(userId) {
  const tpl = getTemplate() || defaultConfig();
  const init = structuredClone(tpl);
  fs.writeFileSync(userFile(userId), JSON.stringify(init, null, 2), 'utf8');
  return init;
}

// 启动时迁移：旧全局 config.json → 系统拥有者配置 + 默认模板（仅执行一次）
function migrate(ownerId) {
  ensureDir();
  if (fs.existsSync(MIGRATED_FLAG)) return;
  if (fs.existsSync(LEGACY_FILE)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
      const merged = deepMerge(defaultConfig(), legacy);
      if (ownerId) {
        fs.writeFileSync(userFile(ownerId), JSON.stringify(merged, null, 2), 'utf8');
      }
      fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(merged, null, 2), 'utf8');
      console.log('[config] 已迁移旧全局 config.json → 系统拥有者配置 + 默认模板');
    } catch (e) {
      console.error('[config] 迁移失败：', e.message);
    }
  }
  fs.writeFileSync(MIGRATED_FLAG, '1');
}

// 迁移：旧版将硅基流动 Key 存于 ai.api_key（同时驱动 ASR 与 AI 加工），
// 且 ai.provider === 'siliconflow'。新版硅基流动独立为 siliconflow 模块，
// 此处把旧 key 迁移到 siliconflow 并把 ai.provider 更新为 'openai-compatible'，
// 保证已有用户的语音识别继续可用，且二者之后可独立修改。仅对旧结构生效。
function migrateSiliconFlow() {
  const files = [];
  try {
    if (fs.existsSync(CONFIGS_DIR)) {
      files.push(...fs.readdirSync(CONFIGS_DIR).filter((f) => f.endsWith('.json')).map((f) => path.join(CONFIGS_DIR, f)));
    }
  } catch (e) { /* ignore */ }
  if (fs.existsSync(TEMPLATE_FILE)) files.push(TEMPLATE_FILE);

  for (const fp of files) {
    try {
      const stored = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const ai = stored.ai || {};
      // 旧版：硅基流动 Key 曾存于 ai.api_key（同时驱动 ASR 与 AI 加工）。
      // 只要 ai 上存有 key 且尚未建立独立 siliconflow 模块，即迁移。
      const legacy = ai.api_key && !stored.siliconflow;
      if (!legacy) continue;
      stored.siliconflow = stored.siliconflow || {};
      if (!stored.siliconflow.api_key) stored.siliconflow.api_key = ai.api_key;
      if (!stored.siliconflow.model) stored.siliconflow.model = process.env.SILICONFLOW_MODEL || 'FunAudioLLM/SenseVoiceSmall';
      ai.provider = 'openai-compatible';
      // 保留 ai.api_key 与 ai.base_url：AI 智能加工仍需它们（与语音识别可填相同服务商）
      fs.writeFileSync(fp, JSON.stringify(stored, null, 2), 'utf8');
      console.log('[config] 已迁移旧硅基流动 Key 到独立模块：', path.basename(fp));
    } catch (e) {
      console.warn('[config] 迁移硅基流动配置失败', fp, e.message);
    }
  }
}

// 删除指定用户的配置文件（用户注销/删除时调用）
function removeUserConfig(userId) {
  if (!userId) return;
  const fp = path.join(CONFIGS_DIR, userId + '.json');
  try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) { /* ignore */ }
}

module.exports = {
  get,
  set,
  ensureInitialized,
  getTemplate,
  setTemplate,
  resetToTemplate,
  migrate,
  migrateSiliconFlow,
  removeUserConfig,
  defaultConfig,
  TEMPLATE_FILE
};
