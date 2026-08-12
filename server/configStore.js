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
  // AI 模型配置。enabled=false 时用内置 Groq；true 时用自定义 OpenAI 兼容接口
  ai: {
    enabled: false,
    base_url: 'https://api.openai.com/v1',
    api_key: '',
    model: 'gpt-4o-mini',
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
  removeUserConfig,
  defaultConfig,
  TEMPLATE_FILE
};
