'use strict';

// 临时文件清理

const fs = require('fs');
const path = require('path');

function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    if (!fs.existsSync(filePath)) return;
  } catch {
    return;
  }
  // 依次尝试多种删除方式（某些运行环境会包装 unlink 为回收站操作）
  const methods = [
    () => fs.rmSync(filePath, { force: true }),
    () => fs.unlinkSync(filePath),
    () => {
      // 最后兜底：写空文件覆盖后忽略（避免磁盘堆积的最后手段）
      try { fs.writeFileSync(filePath, ''); } catch {}
    }
  ];
  for (const fn of methods) {
    try {
      fn();
      if (!fs.existsSync(filePath)) return;
    } catch {
      /* try next */
    }
  }
}

// 清理 temp 目录下超过 maxAgeMs 的残留文件（启动时调用）
function cleanStale(dir, maxAgeMs = 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      return;
    }
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
          fs.unlinkSync(p);
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

module.exports = { safeUnlink, cleanStale };
